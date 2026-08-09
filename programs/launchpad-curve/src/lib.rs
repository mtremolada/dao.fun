//! launchpad-curve — the native bonding curve (SPEC-LAUNCHPAD.md).
//!
//! A coin is born with its whole supply in a program-owned vault, its mint
//! and freeze authorities already revoked, and a constant-product curve over
//! virtual reserves standing between it and the market. Buys walk the price
//! up; when the sellable reserve empties the curve completes, freezes, and
//! becomes migratable. Migration is permissionless: it seeds a Raydium CPMM
//! pool with everything the curve holds and burns the LP, so the liquidity
//! is nobody's to withdraw — including ours.
//!
//! The arithmetic here mirrors `packages/sdk/src/curve-math.ts` operation for
//! operation: same order, same rounding directions, same clamps. That module
//! is the specification and `tests/launchpad-parity.integration.test.ts`
//! proves the two agree over randomized sequences. Rounding always favours
//! the curve — buy costs ceil, sell proceeds floor, fees ceil — which is what
//! makes a buy-then-sell round trip strictly unprofitable.
//!
//! Note what is absent: there is no withdraw instruction, at any privilege
//! level. Curve principal moves only through `buy`, `sell`, and `migrate`,
//! each signing with PDA seeds. The May-2024 pump.fun drain was a privileged
//! withdraw path being misused, not a math error, and the fix is that the
//! path does not exist to misuse.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::{
    self, burn, close_account, mint_to, set_authority, spl_token::instruction::AuthorityType,
    sync_native, Burn, CloseAccount, Mint, MintTo, SetAuthority, SyncNative, Token, TokenAccount,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "dao.fun launchpad-curve",
    project_url: "https://github.com/mtremolada/dao.fun",
    contacts: "github:mtremolada/dao.fun",
    policy: "https://github.com/mtremolada/dao.fun/blob/main/REDTEAM.md",
    preferred_languages: "en",
    source_code: "https://github.com/mtremolada/dao.fun"
}

declare_id!("DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V");

/// A zero-fee path makes wash trading free (the Meteora `cliff_fee = 0`
/// audit finding); the ceiling caps what a compromised authority could
/// impose on future coins.
pub const MIN_TOTAL_FEE_BPS: u16 = 10;
pub const MAX_TOTAL_FEE_BPS: u16 = 500;
pub const BPS_DENOMINATOR: u128 = 10_000;
/// Ceiling on the graduation fee, so "operator-tunable" can never become
/// "operator takes the raise".
pub const MAX_GRADUATION_FEE_LAMPORTS: u64 = 5_000_000_000;
/// Ceiling on the protocol's share of post-graduation fees. The DAO stream
/// is the product; half is already more than any competitor takes.
pub const MAX_GRADUATED_FEE_PROTOCOL_BPS: u16 = 5_000;
/// Rent the Raydium CPMM charges its `creator` for the six accounts it
/// initializes (PoolState 637 B, ObservationState 4075 B, lp_mint, two
/// vaults, the creator LP ATA). Measured, not estimated —
/// tests/launchpad-cpmm-verify.integration.test.ts reconciles it to the
/// lamport. The pool-creation FEE is read from AmmConfig at runtime because
/// Raydium's admin can change it; these rent sizes are fixed by layout.
pub const CPMM_RENT_LAMPORTS: u64 = 42_156_720;
/// Byte offset of `create_pool_fee` in Raydium's AmmConfig (verified against
/// the deployed account). Read by hand rather than through the CPI crate's
/// struct, whose layout predates the creator-fee upgrade (D-035).
const AMM_CONFIG_CREATE_POOL_FEE_OFFSET: usize = 36;
/// Coins are classic SPL, 6 decimals — the convention every terminal,
/// indexer and wallet on Solana already renders correctly.
pub const COIN_DECIMALS: u8 = 6;

pub const CONFIG_SEED: &[u8] = b"config";
pub const CURVE_SEED: &[u8] = b"bonding-curve";
/// The raise lives in a SEPARATE system-owned PDA, not inside the
/// program-owned curve account. That is what lets every SOL movement be a
/// `system_program::transfer` — the runtime balances those by construction,
/// whereas hand-editing a program-owned account's lamports and then handing
/// it to a system-transfer CPI is the "sum of account balances ... do not
/// match" rejection that blocked graduation (SPEC-LAUNCHPAD §2.1).
pub const SOL_VAULT_SEED: &[u8] = b"sol-vault";
pub const CREATOR_VAULT_SEED: &[u8] = b"creator-vault";
/// Per-mint protocol-fee accrual. Trades pay the protocol's share here
/// instead of forwarding it to an external wallet, so that at graduation the
/// coin's OWN fees can pay for its OWN pool and the entire raise reaches
/// liquidity (PLAN-FEE-MODEL.md §2). Per-mint rather than global on purpose:
/// a shared vault would make the permissionless `migrate` crank depend on
/// somebody keeping it funded, and a drained vault would strand holders' SOL
/// in a completed curve.
pub const PROTOCOL_VAULT_SEED: &[u8] = b"protocol-vault";
pub const MIGRATION_AUTHORITY_SEED: &[u8] = b"migration-authority";
pub const POOL_SEED: &[u8] = b"cpmm-pool";

#[program]
pub mod launchpad_curve {
    use super::*;

    /// One-time global setup. The three Raydium addresses recorded here can
    /// never be changed afterwards: if an authority key could re-point them,
    /// a compromise of that key would redirect every future graduation's
    /// liquidity to an attacker's program.
    pub fn initialize_config(ctx: Context<InitializeConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.cpmm_program = ctx.accounts.cpmm_program.key();
        config.cpmm_amm_config = ctx.accounts.cpmm_amm_config.key();
        config.cpmm_create_pool_fee = ctx.accounts.cpmm_create_pool_fee.key();
        config.bump = ctx.bumps.config;
        config.apply(params);
        Ok(())
    }

    /// Authority-only. Changes apply to coins launched AFTER this point:
    /// every curve snapshots its fees at creation, so a fee rise cannot
    /// retroactively tax a coin that is already trading (INV-FEE-SNAPSHOT).
    /// There is deliberately no path here to any Raydium address.
    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        ctx.accounts.config.apply(params);
        Ok(())
    }

    /// Authority-only. Sets the graduation-time parameters that were not
    /// knowable at first deploy: which Raydium fee tier new pools are
    /// created in, whether the LP is locked or burned, and the protocol's
    /// share of the resulting fee stream.
    ///
    /// Unlike `cpmm_program`, these are safe to make mutable. The fee tier
    /// is an account OWNED BY the already-pinned CPMM program, so it can
    /// only ever be one of Raydium's own configs — a compromised authority
    /// could pick a silly fee, but cannot redirect a lamport. The locker is
    /// address-checked at use, and zero means "burn", the safe default.
    pub fn set_graduation_config(
        ctx: Context<SetGraduationConfig>,
        lock_program: Pubkey,
        graduated_fee_protocol_bps: u16,
    ) -> Result<()> {
        require!(
            graduated_fee_protocol_bps <= MAX_GRADUATED_FEE_PROTOCOL_BPS,
            LaunchpadError::FeeOutOfRange
        );
        let config = &mut ctx.accounts.config;
        config.cpmm_amm_config = ctx.accounts.cpmm_amm_config.key();
        config.lock_program = lock_program;
        config.graduated_fee_protocol_bps = graduated_fee_protocol_bps;
        Ok(())
    }

    /// Mints a coin and opens its curve. The full supply goes to the curve's
    /// vault and both mint authorities are dropped before this instruction
    /// returns, so no supply can ever appear behind the curve's back.
    ///
    /// `creator` is an ARGUMENT, never a signer (INV-CREATOR-ARG) — that is
    /// what lets a Squads vault PDA be the creator of a DAO-launched coin
    /// without anyone holding a key that can sign for it.
    pub fn create_coin(
        ctx: Context<CreateCoin>,
        name: String,
        symbol: String,
        uri: String,
        creator: Pubkey,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= 32, LaunchpadError::MetadataTooLong);
        require!(!symbol.is_empty() && symbol.len() <= 10, LaunchpadError::MetadataTooLong);
        require!(!uri.is_empty() && uri.len() <= 200, LaunchpadError::MetadataTooLong);

        let config = &ctx.accounts.config;
        let mint_key = ctx.accounts.mint.key();
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[ctx.bumps.bonding_curve]];

        // Whole supply into the curve's vault. Nothing is pre-allocated to
        // the creator: the only way to hold this coin is to buy it.
        mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.bonding_curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            config.token_total_supply,
        )?;

        create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                ctx.accounts.token_metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: ctx.accounts.metadata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    mint_authority: ctx.accounts.bonding_curve.to_account_info(),
                    update_authority: ctx.accounts.bonding_curve.to_account_info(),
                    payer: ctx.accounts.payer.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    rent: ctx.accounts.rent.to_account_info(),
                },
                &[curve_seeds],
            ),
            DataV2 {
                name: name.clone(),
                symbol: symbol.clone(),
                uri: uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            // Immutable: the name, ticker and image a buyer saw cannot be
            // swapped out from under them later.
            false,
            true,
            None,
        )?;

        // Mint authority dropped. Freeze authority was never set (see the
        // `init` constraint), so no one can freeze a holder's tokens either.
        set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.bonding_curve.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[curve_seeds],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        // Bring both system-owned PDAs into existence at the rent floor. The
        // runtime rejects any transaction that leaves an account under-funded
        // (D-009), and early fee crumbs / the first lamports of the raise are
        // far below it, so a coin whose vaults did not already exist would
        // fail on its first trade. Creating them with a system transfer also
        // makes them system-owned, which is what lets the program later move
        // their lamports by signing a `system_program::transfer` for the PDA.
        let rent_floor = Rent::get()?.minimum_balance(0);
        for vault in [
            ctx.accounts.creator_vault.to_account_info(),
            ctx.accounts.sol_vault.to_account_info(),
            ctx.accounts.protocol_vault.to_account_info(),
        ] {
            let missing = rent_floor.saturating_sub(vault.lamports());
            if missing > 0 {
                transfer_from_user(
                    &ctx.accounts.system_program,
                    &ctx.accounts.payer,
                    &vault,
                    missing,
                )?;
            }
        }

        let curve = &mut ctx.accounts.bonding_curve;
        curve.mint = mint_key;
        curve.creator = creator;
        curve.virtual_sol = config.initial_virtual_sol;
        curve.virtual_token = config.initial_virtual_token;
        curve.real_sol = 0;
        curve.real_token = config.initial_real_token;
        curve.protocol_fee_bps = config.protocol_fee_bps;
        curve.creator_fee_bps = config.creator_fee_bps;
        curve.complete = false;
        curve.migrated = false;
        curve.pool_state = Pubkey::default();
        curve.bump = ctx.bumps.bonding_curve;

        emit_cpi!(CreateEvent {
            mint: mint_key,
            creator,
            name,
            symbol,
            uri,
            virtual_sol: curve.virtual_sol,
            virtual_token: curve.virtual_token,
            real_token: curve.real_token,
            token_total_supply: config.token_total_supply,
        });
        Ok(())
    }

    /// Exact-token-out. The buyer names the tokens they want and caps what
    /// they will pay; the last buy is truncated to whatever the curve has
    /// left rather than failing, so a curve can always be closed out.
    ///
    /// One buy instruction, no variants — a guard is only as strong as its
    /// least-guarded entry point (the Meteora `swap2` bypass).
    pub fn buy(ctx: Context<Trade>, token_amount: u64, max_sol_cost: u64) -> Result<()> {
        let curve = &ctx.accounts.bonding_curve;
        require!(!curve.complete, LaunchpadError::CurveComplete);
        require!(token_amount > 0, LaunchpadError::ZeroAmount);

        let quote = curve.buy_quote(token_amount)?;
        require!(quote.total_cost <= max_sol_cost, LaunchpadError::SlippageExceeded);

        // SOL in first: the curve is never short against tokens it has
        // already handed out. The raise lands in the system-owned sol vault,
        // not the curve account, so it can later leave by a signed system
        // transfer rather than hand-edited lamports.
        transfer_from_user(
            &ctx.accounts.system_program,
            &ctx.accounts.user,
            &ctx.accounts.sol_vault.to_account_info(),
            quote.curve_cost,
        )?;
        transfer_from_user(
            &ctx.accounts.system_program,
            &ctx.accounts.user,
            &ctx.accounts.protocol_vault,
            quote.protocol_fee,
        )?;
        transfer_from_user(
            &ctx.accounts.system_program,
            &ctx.accounts.user,
            &ctx.accounts.creator_vault,
            quote.creator_fee,
        )?;

        let mint_key = ctx.accounts.mint.key();
        let curve_seeds: &[&[u8]] =
            &[CURVE_SEED, mint_key.as_ref(), &[ctx.accounts.bonding_curve.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.bonding_curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            quote.tokens_out,
        )?;

        let curve = &mut ctx.accounts.bonding_curve;
        curve.apply_buy(&quote)?;
        let complete = curve.complete;

        emit_cpi!(TradeEvent {
            mint: mint_key,
            user: ctx.accounts.user.key(),
            is_buy: true,
            token_amount: quote.tokens_out,
            sol_amount: quote.curve_cost,
            protocol_fee: quote.protocol_fee,
            creator_fee: quote.creator_fee,
            virtual_sol: curve.virtual_sol,
            virtual_token: curve.virtual_token,
            real_sol: curve.real_sol,
            real_token: curve.real_token,
        });
        if complete {
            emit_cpi!(CompleteEvent {
                mint: mint_key,
                raised_lamports: curve.real_sol,
                reserved_tokens: ctx.accounts.curve_token_vault.amount - quote.tokens_out,
            });
        }
        Ok(())
    }

    /// Sells back into the curve. Fees come out of the gross proceeds here,
    /// the mirror image of buys, and are capped at the gross so a dust sell
    /// settles at zero rather than underflowing.
    pub fn sell(ctx: Context<Trade>, token_amount: u64, min_sol_output: u64) -> Result<()> {
        let curve = &ctx.accounts.bonding_curve;
        require!(!curve.complete, LaunchpadError::CurveComplete);
        require!(token_amount > 0, LaunchpadError::ZeroAmount);

        let quote = curve.sell_quote(token_amount)?;
        require!(quote.net_sol >= min_sol_output, LaunchpadError::SlippageExceeded);

        // Tokens in first, for the same reason SOL goes in first on a buy.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.curve_token_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            token_amount,
        )?;

        // Proceeds come out of the system-owned sol vault, which signs each
        // leg for its own PDA. gross_sol == net_sol + protocol_fee +
        // creator_fee, and gross_sol <= real_sol (a holder can never sell out
        // more than the curve took in), so the vault never drops below its
        // rent floor.
        let mint_key = ctx.accounts.mint.key();
        let sol_vault = ctx.accounts.sol_vault.to_account_info();
        let sol_vault_seeds: &[&[u8]] =
            &[SOL_VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.sol_vault]];
        transfer_signed(
            &ctx.accounts.system_program,
            &sol_vault,
            &ctx.accounts.user.to_account_info(),
            quote.net_sol,
            sol_vault_seeds,
        )?;
        transfer_signed(
            &ctx.accounts.system_program,
            &sol_vault,
            &ctx.accounts.protocol_vault,
            quote.protocol_fee,
            sol_vault_seeds,
        )?;
        transfer_signed(
            &ctx.accounts.system_program,
            &sol_vault,
            &ctx.accounts.creator_vault,
            quote.creator_fee,
            sol_vault_seeds,
        )?;

        let curve = &mut ctx.accounts.bonding_curve;
        curve.apply_sell(token_amount, &quote)?;

        emit_cpi!(TradeEvent {
            mint: mint_key,
            user: ctx.accounts.user.key(),
            is_buy: false,
            token_amount,
            sol_amount: quote.gross_sol,
            protocol_fee: quote.protocol_fee,
            creator_fee: quote.creator_fee,
            virtual_sol: curve.virtual_sol,
            virtual_token: curve.virtual_token,
            real_sol: curve.real_sol,
            real_token: curve.real_token,
        });
        Ok(())
    }

    /// Seeds the Raydium pool and burns the LP. Permissionless and
    /// idempotent-by-refusal: anyone may crank a completed curve, and a
    /// second attempt fails on `migrated`. Our keeper is one such caller
    /// with no privileges the public lacks — liveness, not authority.
    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        let curve = &ctx.accounts.bonding_curve;
        require!(curve.complete, LaunchpadError::CurveNotComplete);
        require!(!curve.migrated, LaunchpadError::AlreadyMigrated);

        // Read Raydium's live pool-creation fee: their admin can change it,
        // so a hardcoded 0.15 SOL would eventually strand a graduation.
        let create_pool_fee = read_create_pool_fee(&ctx.accounts.cpmm_amm_config)?;
        let overhead = create_pool_fee
            .checked_add(CPMM_RENT_LAMPORTS)
            .ok_or(LaunchpadError::MathOverflow)?;
        let graduation_fee = ctx.accounts.config.graduation_fee_lamports;

        // The coin's own accrued protocol fees pay for the coin's own pool
        // (PLAN-FEE-MODEL.md §2). On production parameters the vault holds
        // ~0.595 SOL against ~0.215 SOL of overhead, so the ENTIRE raise
        // reaches liquidity. Whatever the vault cannot cover falls back to
        // the raise exactly as before — Raydium's `create_pool_fee` is
        // admin-mutable, and a graduation must never strand because a third
        // party raised a price on us.
        let protocol_vault_info = ctx.accounts.protocol_vault.to_account_info();
        let vault_available = protocol_vault_info
            .lamports()
            .saturating_sub(Rent::get()?.minimum_balance(0));
        let from_vault = overhead.min(vault_available);
        let from_raise = overhead - from_vault;

        let pool_sol = curve
            .real_sol
            .checked_sub(from_raise)
            .and_then(|v| v.checked_sub(graduation_fee))
            .ok_or(LaunchpadError::GraduationUnderfunded)?;
        require!(pool_sol > 0, LaunchpadError::GraduationUnderfunded);

        let pool_tokens = ctx.accounts.curve_token_vault.amount;
        require!(pool_tokens > 0, LaunchpadError::GraduationUnderfunded);

        let mint_key = ctx.accounts.mint.key();
        let curve_bump = curve.bump;
        let curve_seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        let migration_seeds: &[&[u8]] = &[
            MIGRATION_AUTHORITY_SEED,
            mint_key.as_ref(),
            &[ctx.bumps.migration_authority],
        ];

        // Move the raise out of the system-owned sol vault: the pool's SOL
        // side plus Raydium's overhead go to the migration authority (also
        // system-owned, because Raydium pays its fee with a system transfer
        // FROM the pool creator), and the graduation fee goes straight to the
        // protocol. A signed system transfer creates the migration authority
        // and funds it in one move — no hand-edited lamports anywhere.
        let migration_info = ctx.accounts.migration_authority.to_account_info();
        let sol_vault = ctx.accounts.sol_vault.to_account_info();
        let sol_vault_seeds: &[&[u8]] =
            &[SOL_VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.sol_vault]];
        let from_sol_vault = pool_sol
            .checked_add(from_raise)
            .ok_or(LaunchpadError::MathOverflow)?;
        transfer_signed(
            &ctx.accounts.system_program,
            &sol_vault,
            &migration_info,
            from_sol_vault,
            sol_vault_seeds,
        )?;
        if from_vault > 0 {
            transfer_signed(
                &ctx.accounts.system_program,
                &protocol_vault_info,
                &migration_info,
                from_vault,
                &[
                    PROTOCOL_VAULT_SEED,
                    mint_key.as_ref(),
                    &[ctx.bumps.protocol_vault],
                ],
            )?;
        }
        transfer_signed(
            &ctx.accounts.system_program,
            &sol_vault,
            &ctx.accounts.fee_recipient,
            graduation_fee,
            sol_vault_seeds,
        )?;

        // Wrap the pool's SOL side: Raydium pulls liquidity from token
        // accounts only, native lamports are used for the fee alone.
        transfer_signed(
            &ctx.accounts.system_program,
            &migration_info,
            &ctx.accounts.migration_wsol.to_account_info(),
            pool_sol,
            migration_seeds,
        )?;
        sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SyncNative {
                account: ctx.accounts.migration_wsol.to_account_info(),
            },
        ))?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.curve_token_vault.to_account_info(),
                    to: ctx.accounts.migration_token.to_account_info(),
                    authority: ctx.accounts.bonding_curve.to_account_info(),
                },
                &[curve_seeds],
            ),
            pool_tokens,
        )?;

        // Raydium requires token_0 < token_1 byte-wise. WSOL starts with
        // byte 6, so a coin mint sorts above it ~97.7% of the time — the
        // other branch is rare in the wild and easy to get wrong, so both
        // are exercised by the integration suite.
        let wsol_is_token_0 =
            ctx.accounts.wsol_mint.key().to_bytes() < mint_key.to_bytes();
        let (token_0_mint, token_1_mint, creator_token_0, creator_token_1, amount_0, amount_1) =
            if wsol_is_token_0 {
                (
                    ctx.accounts.wsol_mint.to_account_info(),
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.migration_wsol.to_account_info(),
                    ctx.accounts.migration_token.to_account_info(),
                    pool_sol,
                    pool_tokens,
                )
            } else {
                (
                    ctx.accounts.mint.to_account_info(),
                    ctx.accounts.wsol_mint.to_account_info(),
                    ctx.accounts.migration_token.to_account_info(),
                    ctx.accounts.migration_wsol.to_account_info(),
                    pool_tokens,
                    pool_sol,
                )
            };
        // The two vault accounts are already keyed to the sorted mints (see
        // their doc comments): Raydium re-derives both from pool_state and
        // the mint it expects, so a caller that mixes them up is refused
        // there rather than silently building a mirrored pool.
        //
        // Built by hand rather than through the CPI crate's generated
        // `initialize`: our pool account is OUR PDA, not Raydium's canonical
        // one, and the deployed program requires any non-canonical pool to be
        // a signer. The crate declares `pool_state` as a plain account, so the
        // generated helper emits a non-signer meta and Raydium's
        // `require_eq!(pool_state.is_signer, true)` rejects it. Setting the
        // meta ourselves and signing with `invoke_signed` is the only way to
        // seed OUR unsquattable pool address (SPEC-LAUNCHPAD, decision A8).
        let pool_seeds: &[&[u8]] =
            &[POOL_SEED, mint_key.as_ref(), &[ctx.bumps.pool_state]];
        initialize_cpmm_pool(
            &ctx.accounts.cpmm_program.to_account_info(),
            &migration_info,
            &ctx.accounts.cpmm_amm_config.to_account_info(),
            &ctx.accounts.cpmm_authority.to_account_info(),
            &ctx.accounts.pool_state.to_account_info(),
            &token_0_mint,
            &token_1_mint,
            &ctx.accounts.cpmm_lp_mint.to_account_info(),
            &creator_token_0,
            &creator_token_1,
            &ctx.accounts.migration_lp.to_account_info(),
            &ctx.accounts.cpmm_token_0_vault.to_account_info(),
            &ctx.accounts.cpmm_token_1_vault.to_account_info(),
            &ctx.accounts.cpmm_create_pool_fee.to_account_info(),
            &ctx.accounts.cpmm_observation_state.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.rent.to_account_info(),
            amount_0,
            amount_1,
            &[migration_seeds, pool_seeds],
        )?;

        // Burn every LP token we hold. Raydium never mints the 100 units it
        // withholds, so a fully burned pool reads supply 0 — verified
        // against the deployed binary, and asserted by the caller.
        let lp_amount = {
            let data = ctx.accounts.migration_lp.try_borrow_data()?;
            token::spl_token::state::Account::unpack(&data)?.amount
        };
        require!(lp_amount > 0, LaunchpadError::GraduationUnderfunded);
        burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.cpmm_lp_mint.to_account_info(),
                    from: ctx.accounts.migration_lp.to_account_info(),
                    authority: migration_info.clone(),
                },
                &[migration_seeds],
            ),
            lp_amount,
        )?;

        // Reclaim what the temporary accounts are holding; the graduation
        // fee and leftover rent are the protocol's, not the pool's.
        for account in [
            ctx.accounts.migration_wsol.to_account_info(),
            ctx.accounts.migration_token.to_account_info(),
            ctx.accounts.migration_lp.to_account_info(),
        ] {
            close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account,
                    destination: migration_info.clone(),
                    authority: migration_info.clone(),
                },
                &[migration_seeds],
            ))?;
        }
        // The migration authority is SYSTEM-owned (Raydium's fee is paid by
        // a system transfer from the pool creator), so its balance can only
        // be moved by the system program signing for our PDA — a direct
        // debit here is exactly the "spent from an account it does not own"
        // failure. Everything left is unspent overhead plus reclaimed rent.
        // Residue returns to the PROTOCOL VAULT, not to the fee recipient:
        // the vault fronted the overhead, so unspent overhead and reclaimed
        // rent belong back there where `collect_protocol_fee` can sweep them
        // under the same rules as everything else the coin earned.
        let residue = migration_info.lamports();
        if residue > 0 {
            transfer_signed(
                &ctx.accounts.system_program,
                &migration_info,
                &ctx.accounts.protocol_vault.to_account_info(),
                residue,
                migration_seeds,
            )?;
        }

        let pool_key = ctx.accounts.pool_state.key();
        let curve = &mut ctx.accounts.bonding_curve;
        curve.real_sol = 0;
        curve.real_token = 0;
        curve.migrated = true;
        curve.pool_state = pool_key;

        emit_cpi!(MigrateEvent {
            mint: mint_key,
            pool_state: pool_key,
            pool_sol,
            pool_tokens,
            lp_burned: lp_amount,
            create_pool_fee,
            graduation_fee,
        });
        Ok(())
    }

    /// Sweeps a coin's accrued PROTOCOL fees to `config.fee_recipient`.
    /// Permissionless to call, and the destination is fixed by config, so a
    /// crank can pay the protocol and nothing else.
    ///
    /// While the curve has not migrated the sweep must leave the graduation
    /// overhead behind: these lamports are earmarked to pay for the coin's
    /// own pool (PLAN-FEE-MODEL.md §2), and sweeping them early would push
    /// the cost back onto the raise. After migration there is nothing left
    /// to reserve and everything above the rent floor is swept.
    pub fn collect_protocol_fee(ctx: Context<CollectProtocolFee>) -> Result<()> {
        let vault = ctx.accounts.protocol_vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(0);
        let mut available = vault.lamports().saturating_sub(rent_floor);

        if !ctx.accounts.bonding_curve.migrated {
            let reserve = read_create_pool_fee(&ctx.accounts.cpmm_amm_config)?
                .checked_add(CPMM_RENT_LAMPORTS)
                .ok_or(LaunchpadError::MathOverflow)?;
            available = available.saturating_sub(reserve);
        }
        require!(available > 0, LaunchpadError::NothingToCollect);

        let mint_key = ctx.accounts.bonding_curve.mint;
        transfer_signed(
            &ctx.accounts.system_program,
            &vault,
            &ctx.accounts.fee_recipient.to_account_info(),
            available,
            &[
                PROTOCOL_VAULT_SEED,
                mint_key.as_ref(),
                &[ctx.bumps.protocol_vault],
            ],
        )?;
        Ok(())
    }

    /// Sweeps a creator's accrued fees. Permissionless to CALL but not to
    /// direct: the destination is the creator address stored on the curve,
    /// so a crank can pay the creator and nothing else. This is the fix for
    /// the pump.fun design that made GATE 0c fail — pump requires the
    /// creator to sign, which a Squads vault PDA cannot do.
    pub fn collect_creator_fee(ctx: Context<CollectCreatorFee>) -> Result<()> {
        let vault = ctx.accounts.creator_vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(0);
        let available = vault.lamports().saturating_sub(rent_floor);
        require!(available > 0, LaunchpadError::NothingToCollect);

        let creator_key = ctx.accounts.creator.key();
        transfer_signed(
            &ctx.accounts.system_program,
            &vault,
            &ctx.accounts.creator.to_account_info(),
            available,
            &[
                CREATOR_VAULT_SEED,
                creator_key.as_ref(),
                &[ctx.bumps.creator_vault],
            ],
        )?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// curve math — the Rust mirror of packages/sdk/src/curve-math.ts
// ---------------------------------------------------------------------------

pub struct BuyQuote {
    pub tokens_out: u64,
    pub curve_cost: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub total_cost: u64,
}

pub struct SellQuote {
    pub gross_sol: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    pub net_sol: u64,
}

fn ceil_div(numerator: u128, denominator: u128) -> Result<u128> {
    require!(denominator > 0, LaunchpadError::MathOverflow);
    Ok(if numerator % denominator == 0 {
        numerator / denominator
    } else {
        numerator / denominator + 1
    })
}

fn to_u64(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| LaunchpadError::MathOverflow.into())
}

impl BondingCurve {
    /// Rounded UP: the buyer covers the exact curve price or better, so k
    /// never falls (INV-ROUND-BUY, INV-K-NONDECREASING). Every product is
    /// widened to u128 first — a naive u64 multiply overflows for most
    /// real-world trade sizes.
    pub fn buy_quote(&self, token_amount: u64) -> Result<BuyQuote> {
        let tokens_out = token_amount.min(self.real_token);
        require!(tokens_out > 0, LaunchpadError::ZeroAmount);
        let virtual_token = self.virtual_token as u128;
        let out = tokens_out as u128;
        require!(virtual_token > out, LaunchpadError::MathOverflow);
        let curve_cost = to_u64(ceil_div(
            out.checked_mul(self.virtual_sol as u128)
                .ok_or(LaunchpadError::MathOverflow)?,
            virtual_token - out,
        )?)?;
        // Fees sit ON TOP: only curve_cost enters the reserves.
        let (protocol_fee, creator_fee) = self.split_fee(curve_cost, None)?;
        Ok(BuyQuote {
            tokens_out,
            curve_cost,
            protocol_fee,
            creator_fee,
            total_cost: curve_cost
                .checked_add(protocol_fee)
                .and_then(|v| v.checked_add(creator_fee))
                .ok_or(LaunchpadError::MathOverflow)?,
        })
    }

    /// Rounded DOWN, and capped at what the curve actually holds.
    pub fn sell_quote(&self, token_amount: u64) -> Result<SellQuote> {
        require!(token_amount > 0, LaunchpadError::ZeroAmount);
        let denominator = (self.virtual_token as u128)
            .checked_add(token_amount as u128)
            .ok_or(LaunchpadError::MathOverflow)?;
        let gross_sol = to_u64(
            (token_amount as u128)
                .checked_mul(self.virtual_sol as u128)
                .ok_or(LaunchpadError::MathOverflow)?
                / denominator,
        )?;
        require!(gross_sol <= self.real_sol, LaunchpadError::InsufficientReserve);
        // Capped at the gross so dust sells settle at zero instead of
        // underflowing (INV-SELL-NO-UNDERFLOW).
        let (protocol_fee, creator_fee) = self.split_fee(gross_sol, Some(gross_sol))?;
        Ok(SellQuote {
            gross_sol,
            protocol_fee,
            creator_fee,
            net_sol: gross_sol - protocol_fee - creator_fee,
        })
    }

    fn split_fee(&self, base: u64, cap: Option<u64>) -> Result<(u64, u64)> {
        let total_bps = (self.protocol_fee_bps as u128) + (self.creator_fee_bps as u128);
        if total_bps == 0 || base == 0 {
            return Ok((0, 0));
        }
        // Rounded up so a fee is never rounded away to nothing
        // (INV-FEE-FLOOR), then capped where the payer cannot cover it.
        let mut total = to_u64(ceil_div(
            (base as u128)
                .checked_mul(total_bps)
                .ok_or(LaunchpadError::MathOverflow)?,
            BPS_DENOMINATOR,
        )?)?;
        if let Some(cap) = cap {
            total = total.min(cap);
        }
        // The protocol absorbs the rounding remainder, so the two parts
        // always re-sum to `total` exactly.
        let creator_fee = to_u64((total as u128) * (self.creator_fee_bps as u128) / total_bps)?;
        Ok((total - creator_fee, creator_fee))
    }

    fn apply_buy(&mut self, quote: &BuyQuote) -> Result<()> {
        self.virtual_sol = self
            .virtual_sol
            .checked_add(quote.curve_cost)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.virtual_token = self
            .virtual_token
            .checked_sub(quote.tokens_out)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.real_sol = self
            .real_sol
            .checked_add(quote.curve_cost)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.real_token = self
            .real_token
            .checked_sub(quote.tokens_out)
            .ok_or(LaunchpadError::MathOverflow)?;
        // One-way, and set by exactly one condition
        // (INV-COMPLETE-MONOTONE).
        if self.real_token == 0 {
            self.complete = true;
        }
        Ok(())
    }

    fn apply_sell(&mut self, token_amount: u64, quote: &SellQuote) -> Result<()> {
        self.virtual_sol = self
            .virtual_sol
            .checked_sub(quote.gross_sol)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.virtual_token = self
            .virtual_token
            .checked_add(token_amount)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.real_sol = self
            .real_sol
            .checked_sub(quote.gross_sol)
            .ok_or(LaunchpadError::MathOverflow)?;
        self.real_token = self
            .real_token
            .checked_add(token_amount)
            .ok_or(LaunchpadError::MathOverflow)?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// lamport plumbing
// ---------------------------------------------------------------------------

fn transfer_from_user<'info>(
    system_program: &Program<'info, System>,
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            system_program::Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        amount,
    )
}

fn transfer_signed<'info>(
    system_program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            system_program::Transfer {
                from: from.clone(),
                to: to.clone(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Raydium CPMM `initialize`, built by hand. The generated CPI crate declares
/// `pool_state` as a non-signer account, which is correct only for creating
/// Raydium's canonical pool PDA. We seed OUR pool PDA instead (unsquattable —
/// nobody else can sign for it), and the deployed program requires any
/// non-canonical pool account to be a signer, so its meta must carry
/// `is_signer = true` and be signed via `invoke_signed`. Account order and
/// mut/signer flags mirror the deployed program's Initialize context exactly.
#[allow(clippy::too_many_arguments)]
fn initialize_cpmm_pool<'info>(
    cpmm_program: &AccountInfo<'info>,
    creator: &AccountInfo<'info>,
    amm_config: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    pool_state: &AccountInfo<'info>,
    token_0_mint: &AccountInfo<'info>,
    token_1_mint: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    creator_token_0: &AccountInfo<'info>,
    creator_token_1: &AccountInfo<'info>,
    creator_lp_token: &AccountInfo<'info>,
    token_0_vault: &AccountInfo<'info>,
    token_1_vault: &AccountInfo<'info>,
    create_pool_fee: &AccountInfo<'info>,
    observation_state: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    amount_0: u64,
    amount_1: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    // sha256("global:initialize")[..8], verified against the deployed binary.
    let mut data = Vec::with_capacity(8 + 24);
    data.extend_from_slice(&[175, 175, 109, 31, 13, 152, 155, 237]);
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    // open_time 0: Raydium clamps any past timestamp to now + 1, so the pool
    // opens immediately.
    data.extend_from_slice(&0u64.to_le_bytes());

    let accounts = vec![
        AccountMeta::new(*creator.key, true),
        AccountMeta::new_readonly(*amm_config.key, false),
        AccountMeta::new_readonly(*authority.key, false),
        AccountMeta::new(*pool_state.key, true),
        AccountMeta::new_readonly(*token_0_mint.key, false),
        AccountMeta::new_readonly(*token_1_mint.key, false),
        AccountMeta::new(*lp_mint.key, false),
        AccountMeta::new(*creator_token_0.key, false),
        AccountMeta::new(*creator_token_1.key, false),
        AccountMeta::new(*creator_lp_token.key, false),
        AccountMeta::new(*token_0_vault.key, false),
        AccountMeta::new(*token_1_vault.key, false),
        AccountMeta::new(*create_pool_fee.key, false),
        AccountMeta::new(*observation_state.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*associated_token_program.key, false),
        AccountMeta::new_readonly(*system_program.key, false),
        AccountMeta::new_readonly(*rent.key, false),
    ];
    let ix = Instruction {
        program_id: *cpmm_program.key,
        accounts,
        data,
    };
    invoke_signed(
        &ix,
        &[
            creator.clone(),
            amm_config.clone(),
            authority.clone(),
            pool_state.clone(),
            token_0_mint.clone(),
            token_1_mint.clone(),
            lp_mint.clone(),
            creator_token_0.clone(),
            creator_token_1.clone(),
            creator_lp_token.clone(),
            token_0_vault.clone(),
            token_1_vault.clone(),
            create_pool_fee.clone(),
            observation_state.clone(),
            token_program.clone(),
            associated_token_program.clone(),
            system_program.clone(),
            rent.clone(),
            cpmm_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// Raydium's admin can change the pool-creation fee, so migration reads it
/// live. Parsed by offset rather than through the CPI crate's `AmmConfig`,
/// whose field set predates the creator-fee upgrade (D-035).
fn read_create_pool_fee(amm_config: &AccountInfo) -> Result<u64> {
    let data = amm_config.try_borrow_data()?;
    let end = AMM_CONFIG_CREATE_POOL_FEE_OFFSET + 8;
    require!(data.len() >= end, LaunchpadError::InvalidAmmConfig);
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[AMM_CONFIG_CREATE_POOL_FEE_OFFSET..end]);
    Ok(u64::from_le_bytes(buf))
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub graduation_fee_lamports: u64,
    pub initial_virtual_sol: u64,
    pub initial_virtual_token: u64,
    pub initial_real_token: u64,
    pub token_total_supply: u64,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        let total = self
            .protocol_fee_bps
            .checked_add(self.creator_fee_bps)
            .ok_or(LaunchpadError::FeeOutOfRange)?;
        require!(
            (MIN_TOTAL_FEE_BPS..=MAX_TOTAL_FEE_BPS).contains(&total),
            LaunchpadError::FeeOutOfRange
        );
        require!(
            self.graduation_fee_lamports <= MAX_GRADUATION_FEE_LAMPORTS,
            LaunchpadError::FeeOutOfRange
        );
        require!(
            self.initial_virtual_sol > 0
                && self.initial_real_token > 0
                && self.initial_real_token < self.initial_virtual_token
                && self.initial_real_token <= self.token_total_supply,
            LaunchpadError::InvalidCurveParams
        );

        // A curve that could complete without being able to afford its own
        // graduation would strand its holders' SOL (INV-GRAD-COVERS-COST).
        // The fee floor is not known here, so the check uses the observed
        // 0.15 SOL plus rent; migration re-checks against the live value.
        let raise = ceil_div(
            (self.initial_real_token as u128)
                .checked_mul(self.initial_virtual_sol as u128)
                .ok_or(LaunchpadError::MathOverflow)?,
            (self.initial_virtual_token as u128) - (self.initial_real_token as u128),
        )?;
        let floor = (150_000_000u128 + CPMM_RENT_LAMPORTS as u128)
            .checked_mul(2)
            .ok_or(LaunchpadError::MathOverflow)?;
        require!(raise >= floor, LaunchpadError::GraduationUnderfunded);
        Ok(())
    }
}

impl Config {
    fn apply(&mut self, params: ConfigParams) {
        self.protocol_fee_bps = params.protocol_fee_bps;
        self.creator_fee_bps = params.creator_fee_bps;
        self.graduation_fee_lamports = params.graduation_fee_lamports;
        self.initial_virtual_sol = params.initial_virtual_sol;
        self.initial_virtual_token = params.initial_virtual_token;
        self.initial_real_token = params.initial_real_token;
        self.token_total_supply = params.token_total_supply;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub graduation_fee_lamports: u64,
    pub initial_virtual_sol: u64,
    pub initial_virtual_token: u64,
    pub initial_real_token: u64,
    pub token_total_supply: u64,
    /// Set once at initialization and never mutable afterwards.
    pub cpmm_program: Pubkey,
    pub cpmm_amm_config: Pubkey,
    pub cpmm_create_pool_fee: Pubkey,
    pub bump: u8,
    /// Raydium's liquidity locker. ZERO means "burn the LP", which is both
    /// the pre-existing behaviour and the only possible behaviour on devnet
    /// (the locker is not deployed there and hard-codes the MAINNET CPMM
    /// id). Set on mainnet, `migrate` locks instead and the coin earns
    /// trading fees forever (PLAN-FEE-MODEL.md §2).
    pub lock_program: Pubkey,
    /// Protocol's share of the SOL side of post-graduation fees, in bps,
    /// applied only AFTER the graduation cost has been recovered.
    pub graduated_fee_protocol_bps: u16,
    /// Headroom so later parameters do not force a state migration. Carved
    /// out of the original `[u64; 8]`, byte for byte, so this upgrade does
    /// NOT change Config's size and every already-deployed config account
    /// still deserializes — with lock_program = zero, i.e. burn, which is
    /// exactly what a config written before this existed meant.
    pub reserved: [u8; 30],
}

#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
    /// Snapshotted at creation (INV-FEE-SNAPSHOT).
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub complete: bool,
    pub migrated: bool,
    pub pool_state: Pubkey,
    pub bump: u8,
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: destination for protocol fees; only its address is stored.
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: the CPMM deployment this launchpad graduates into. Its address
    /// is recorded here and can never change afterwards, which is the real
    /// guarantee (INV-CPI-PINNED); we assert only that it is executable,
    /// because Raydium deploys the CPMM at a DIFFERENT address per cluster
    /// (mainnet CPMMoo8L… vs devnet DRaycpLY…) and a type-level pin to one of
    /// them would make the program undeployable on the other.
    #[account(constraint = cpmm_program.executable @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: Raydium's fee tier; parsed by offset at migration. Owned by the
    /// CPMM program above, which ties the config set together.
    #[account(owner = cpmm_program.key())]
    pub cpmm_amm_config: UncheckedAccount<'info>,
    /// CHECK: Raydium's wSOL fee receiver, address-constrained by them.
    pub cpmm_create_pool_fee: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetGraduationConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ LaunchpadError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: a Raydium fee tier. Constrained to be owned by the CPMM
    /// program pinned at initialization, so this can only ever select one of
    /// Raydium's own configs.
    #[account(owner = config.cpmm_program @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_amm_config: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ LaunchpadError::Unauthorized
    )]
    pub config: Box<Account<'info, Config>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(name: String, symbol: String, uri: String, creator: Pubkey)]
pub struct CreateCoin<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// A fresh mint, created here so its authorities are ours to drop.
    /// No freeze authority is set: nobody can ever freeze a holder.
    #[account(
        init,
        payer = payer,
        mint::decimals = COIN_DECIMALS,
        mint::authority = bonding_curve,
    )]
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: system-owned PDA that holds the raise; funded to the rent floor
    /// here so the first buy has an account to send SOL to.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA keyed to the creator argument; funded to the
    /// rent floor here so the first trade's fee crumb has somewhere to land.
    #[account(
        mut,
        seeds = [CREATOR_VAULT_SEED, creator.as_ref()],
        bump
    )]
    pub creator_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA holding this coin's protocol fees; funded to
    /// the rent floor here for the same reason as the creator vault.
    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub protocol_vault: UncheckedAccount<'info>,
    /// CHECK: validated by the Metaplex program during the CPI.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, Metadata>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = bonding_curve.bump,
        has_one = mint @ LaunchpadError::MintMismatch,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
    /// Every token account is bound to the curve's own mint — a substituted
    /// mint is the fake-mint class that drained a Raydium legacy pool.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: system-owned PDA holding the raise; buys pay into it, sells and
    /// migration are paid out of it by a transfer it signs for its own seeds.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = mint,
        associated_token::authority = user,
    )]
    pub user_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: system-owned PDA holding this coin's accrued protocol fees.
    /// It pays for the coin's own graduation and is swept only to
    /// config.fee_recipient (PLAN-FEE-MODEL.md §2).
    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub protocol_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA keyed to the curve's creator; swept only to
    /// that creator.
    #[account(
        mut,
        seeds = [CREATOR_VAULT_SEED, bonding_curve.creator.as_ref()],
        bump
    )]
    pub creator_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Migrate<'info> {
    /// Anyone. Pays the transaction, gains nothing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = bonding_curve.bump,
        has_one = mint @ LaunchpadError::MintMismatch,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = bonding_curve,
    )]
    pub curve_token_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: system-owned PDA holding the raise; drained here by a transfer
    /// it signs for its own seeds.
    #[account(
        mut,
        seeds = [SOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA holding this coin's accrued protocol fees;
    /// funds the graduation overhead so the whole raise reaches liquidity,
    /// and receives the unspent residue afterwards.
    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub protocol_vault: UncheckedAccount<'info>,
    /// CHECK: system-owned PDA — Raydium pays its fee with a system transfer
    /// from the pool creator, which a program-owned account cannot do.
    #[account(
        mut,
        seeds = [MIGRATION_AUTHORITY_SEED, mint.key().as_ref()],
        bump
    )]
    pub migration_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = migration_authority,
    )]
    pub migration_wsol: Box<Account<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = migration_authority,
    )]
    pub migration_token: Box<Account<'info, TokenAccount>>,
    /// CHECK: created by Raydium during the CPI, then burned and closed.
    #[account(mut)]
    pub migration_lp: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::spl_token::native_mint::id())]
    pub wsol_mint: Box<Account<'info, Mint>>,
    /// CHECK: pinned to the address recorded in config.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pinned by ADDRESS to the program recorded at initialization —
    /// an authority key must not be able to redirect a graduation
    /// (INV-CPI-PINNED). That address equality is the whole guarantee; the
    /// account type stays generic so the same binary serves every cluster.
    #[account(address = config.cpmm_program @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_program: UncheckedAccount<'info>,
    /// CHECK: Raydium's own PDA, validated by them during the CPI.
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to config; parsed by offset for the live pool fee.
    #[account(address = config.cpmm_amm_config @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_amm_config: UncheckedAccount<'info>,
    /// CHECK: pinned to config; Raydium address-constrains it too.
    #[account(mut, address = config.cpmm_create_pool_fee @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: our PDA, signed into the CPI. Deterministic and unsquattable —
    /// Raydium accepts any signing pool account, so we never race for
    /// theirs.
    #[account(
        mut,
        seeds = [POOL_SEED, mint.key().as_ref()],
        bump
    )]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: initialized by Raydium during the CPI.
    #[account(mut)]
    pub cpmm_lp_mint: UncheckedAccount<'info>,
    /// CHECK: initialized by Raydium during the CPI. Keyed to the LOWER of
    /// (coin mint, wSOL) — Raydium re-derives it from pool_state and that
    /// mint, so a caller who swaps the two is refused there.
    #[account(mut)]
    pub cpmm_token_0_vault: UncheckedAccount<'info>,
    /// CHECK: initialized by Raydium during the CPI. Keyed to the HIGHER of
    /// (coin mint, wSOL).
    #[account(mut)]
    pub cpmm_token_1_vault: UncheckedAccount<'info>,
    /// CHECK: initialized by Raydium during the CPI.
    #[account(mut)]
    pub cpmm_observation_state: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CollectProtocolFee<'info> {
    /// Anyone may crank this; the destination is fixed below.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: pinned to the address recorded in config — the only possible
    /// destination.
    #[account(mut, address = config.fee_recipient @ LaunchpadError::InvalidFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(
        seeds = [CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
    /// CHECK: system-owned PDA keyed to the coin.
    #[account(
        mut,
        seeds = [PROTOCOL_VAULT_SEED, bonding_curve.mint.as_ref()],
        bump
    )]
    pub protocol_vault: UncheckedAccount<'info>,
    /// CHECK: Raydium's fee tier, read to size the graduation reserve.
    #[account(address = config.cpmm_amm_config @ LaunchpadError::InvalidCpmmAccount)]
    pub cpmm_amm_config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectCreatorFee<'info> {
    /// Anyone may crank this; the destination is fixed below.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the curve's recorded creator — the only possible destination.
    #[account(mut, address = bonding_curve.creator @ LaunchpadError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,
    #[account(
        seeds = [CURVE_SEED, bonding_curve.mint.as_ref()],
        bump = bonding_curve.bump,
    )]
    pub bonding_curve: Box<Account<'info, BondingCurve>>,
    /// CHECK: system-owned PDA keyed to the creator.
    #[account(
        mut,
        seeds = [CREATOR_VAULT_SEED, creator.key().as_ref()],
        bump
    )]
    pub creator_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// events — emit_cpi so the indexer reads instruction data, not logs, which
// the runtime is free to truncate
// ---------------------------------------------------------------------------

#[event]
pub struct CreateEvent {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_token: u64,
    pub token_total_supply: u64,
}

#[event]
pub struct TradeEvent {
    pub mint: Pubkey,
    pub user: Pubkey,
    pub is_buy: bool,
    pub token_amount: u64,
    pub sol_amount: u64,
    pub protocol_fee: u64,
    pub creator_fee: u64,
    /// Post-trade reserves, so the indexer can price the trade without
    /// replaying the curve.
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub real_sol: u64,
    pub real_token: u64,
}

#[event]
pub struct CompleteEvent {
    pub mint: Pubkey,
    pub raised_lamports: u64,
    pub reserved_tokens: u64,
}

#[event]
pub struct MigrateEvent {
    pub mint: Pubkey,
    pub pool_state: Pubkey,
    pub pool_sol: u64,
    pub pool_tokens: u64,
    pub lp_burned: u64,
    pub create_pool_fee: u64,
    pub graduation_fee: u64,
}

#[error_code]
pub enum LaunchpadError {
    #[msg("total trade fee is outside the permitted range")]
    FeeOutOfRange,
    #[msg("curve parameters are invalid")]
    InvalidCurveParams,
    #[msg("curve cannot raise enough to cover its own graduation")]
    GraduationUnderfunded,
    #[msg("curve is complete: trading is closed")]
    CurveComplete,
    #[msg("curve has not completed yet")]
    CurveNotComplete,
    #[msg("curve has already migrated")]
    AlreadyMigrated,
    #[msg("amount must be positive")]
    ZeroAmount,
    #[msg("slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("curve reserve cannot cover this")]
    InsufficientReserve,
    #[msg("token account does not belong to this curve's mint")]
    MintMismatch,
    #[msg("fee recipient does not match the configured address")]
    InvalidFeeRecipient,
    #[msg("raydium account does not match the configured address")]
    InvalidCpmmAccount,
    #[msg("amm config account is malformed")]
    InvalidAmmConfig,
    #[msg("nothing to collect")]
    NothingToCollect,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("unauthorized")]
    Unauthorized,
    #[msg("metadata field length out of bounds")]
    MetadataTooLong,
}
