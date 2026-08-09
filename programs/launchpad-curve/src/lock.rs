//! Post-graduation liquidity lock — the Burn & Earn branch of `migrate`.
//!
//! `migrate` leaves the LP with the migration authority when
//! `config.lock_program` is set; this hands it to Raydium's locker, which
//! makes it as unwithdrawable as burning does (the locker has no unlock,
//! withdraw or close entrypoint — proven against the deployed binary in
//! tests/launchpad-lock-verify.integration.test.ts) while minting a "fee
//! key" NFT whose holder may collect the position's trading fees forever.
//!
//! Split out of `migrate` for a boring reason: `migrate` already carries ~28
//! accounts and the locker needs 19 more, which does not fit in a legacy
//! transaction. Both halves are permissionless, so the split costs nothing
//! but a second crank.
//!
//! Every address here is DERIVED, never hardcoded — the locker program id
//! comes from config, so the same binary works on any cluster that has one
//! (today, only mainnet).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

/// The 19 accounts of `lock_cp_liquidity`, in the deployed IDL's order.
#[allow(clippy::too_many_arguments)]
pub fn lock_cp_liquidity<'info>(
    lock_program: &AccountInfo<'info>,
    lock_authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    liquidity_owner: &AccountInfo<'info>,
    fee_nft_owner: &AccountInfo<'info>,
    fee_nft_mint: &AccountInfo<'info>,
    fee_nft_account: &AccountInfo<'info>,
    pool_state: &AccountInfo<'info>,
    locked_liquidity: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    liquidity_owner_lp: &AccountInfo<'info>,
    locked_lp_vault: &AccountInfo<'info>,
    token_0_vault: &AccountInfo<'info>,
    token_1_vault: &AccountInfo<'info>,
    metadata_account: &AccountInfo<'info>,
    rent: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    metadata_program: &AccountInfo<'info>,
    lp_amount: u64,
    with_metadata: bool,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(8 + 8 + 1);
    data.extend_from_slice(&crate::LOCK_CP_LIQUIDITY_DISC);
    data.extend_from_slice(&lp_amount.to_le_bytes());
    data.push(u8::from(with_metadata));

    let ix = Instruction {
        program_id: *lock_program.key,
        accounts: vec![
            AccountMeta::new_readonly(*lock_authority.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*liquidity_owner.key, true),
            // Not a signer: the fee key is minted straight to our PDA.
            AccountMeta::new_readonly(*fee_nft_owner.key, false),
            // IS a signer, and G0 proved a PDA may fill it.
            AccountMeta::new(*fee_nft_mint.key, true),
            AccountMeta::new(*fee_nft_account.key, false),
            AccountMeta::new_readonly(*pool_state.key, false),
            AccountMeta::new(*locked_liquidity.key, false),
            AccountMeta::new_readonly(*lp_mint.key, false),
            AccountMeta::new(*liquidity_owner_lp.key, false),
            AccountMeta::new(*locked_lp_vault.key, false),
            AccountMeta::new(*token_0_vault.key, false),
            AccountMeta::new(*token_1_vault.key, false),
            AccountMeta::new(*metadata_account.key, false),
            AccountMeta::new_readonly(*rent.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*associated_token_program.key, false),
            AccountMeta::new_readonly(*metadata_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            lock_authority.clone(),
            payer.clone(),
            liquidity_owner.clone(),
            fee_nft_owner.clone(),
            fee_nft_mint.clone(),
            fee_nft_account.clone(),
            pool_state.clone(),
            locked_liquidity.clone(),
            lp_mint.clone(),
            liquidity_owner_lp.clone(),
            locked_lp_vault.clone(),
            token_0_vault.clone(),
            token_1_vault.clone(),
            metadata_account.clone(),
            rent.clone(),
            system_program.clone(),
            token_program.clone(),
            associated_token_program.clone(),
            metadata_program.clone(),
            lock_program.clone(),
        ],
        signer_seeds,
    )
    .map_err(Into::into)
}

/// The 18 accounts of `collect_cp_fees`, in the deployed IDL's order.
///
/// `recipient_token_0/1` are UNCONSTRAINED by the locker (G0 proved a payout
/// landing in a non-ATA account owned by an unrelated PDA), which is exactly
/// what lets our program hard-wire the destinations and keep the crank open
/// to anyone.
#[allow(clippy::too_many_arguments)]
pub fn collect_cp_fees<'info>(
    lock_program: &AccountInfo<'info>,
    lock_authority: &AccountInfo<'info>,
    fee_nft_owner: &AccountInfo<'info>,
    fee_nft_account: &AccountInfo<'info>,
    locked_liquidity: &AccountInfo<'info>,
    cp_swap_program: &AccountInfo<'info>,
    cp_authority: &AccountInfo<'info>,
    pool_state: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    recipient_token_0: &AccountInfo<'info>,
    recipient_token_1: &AccountInfo<'info>,
    token_0_vault: &AccountInfo<'info>,
    token_1_vault: &AccountInfo<'info>,
    vault_0_mint: &AccountInfo<'info>,
    vault_1_mint: &AccountInfo<'info>,
    locked_lp_vault: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_program_2022: &AccountInfo<'info>,
    memo_program: &AccountInfo<'info>,
    fee_lp_amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(&crate::COLLECT_CP_FEES_DISC);
    data.extend_from_slice(&fee_lp_amount.to_le_bytes());

    let ix = Instruction {
        program_id: *lock_program.key,
        accounts: vec![
            AccountMeta::new_readonly(*lock_authority.key, false),
            AccountMeta::new_readonly(*fee_nft_owner.key, true),
            AccountMeta::new_readonly(*fee_nft_account.key, false),
            AccountMeta::new(*locked_liquidity.key, false),
            AccountMeta::new_readonly(*cp_swap_program.key, false),
            AccountMeta::new_readonly(*cp_authority.key, false),
            AccountMeta::new(*pool_state.key, false),
            AccountMeta::new(*lp_mint.key, false),
            AccountMeta::new(*recipient_token_0.key, false),
            AccountMeta::new(*recipient_token_1.key, false),
            AccountMeta::new(*token_0_vault.key, false),
            AccountMeta::new(*token_1_vault.key, false),
            AccountMeta::new_readonly(*vault_0_mint.key, false),
            AccountMeta::new_readonly(*vault_1_mint.key, false),
            AccountMeta::new(*locked_lp_vault.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*token_program_2022.key, false),
            AccountMeta::new_readonly(*memo_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            lock_authority.clone(),
            fee_nft_owner.clone(),
            fee_nft_account.clone(),
            locked_liquidity.clone(),
            cp_swap_program.clone(),
            cp_authority.clone(),
            pool_state.clone(),
            lp_mint.clone(),
            recipient_token_0.clone(),
            recipient_token_1.clone(),
            token_0_vault.clone(),
            token_1_vault.clone(),
            vault_0_mint.clone(),
            vault_1_mint.clone(),
            locked_lp_vault.clone(),
            token_program.clone(),
            token_program_2022.clone(),
            memo_program.clone(),
            lock_program.clone(),
        ],
        signer_seeds,
    )
    .map_err(Into::into)
}
