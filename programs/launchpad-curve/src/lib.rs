//! launchpad-curve — the native bonding curve (SPEC-LAUNCHPAD.md).
//!
//! SCAFFOLD (Phase 0). This increment exists to pin the build pipeline and
//! prove the graduation-CPI dependency links under our toolchain BEFORE any
//! fund-handling logic is written — the same sequencing D-029 used for
//! proposal-gate. The curve math, trading, and migration instructions land
//! tests-first in Phase 2 against the SPEC-LAUNCHPAD component contract.
//!
//! Safety baseline (inherited from the workspace profile): overflow-checks
//! on, typed accounts, PDA bump validation, pinned CPI program ids, and —
//! structurally, for the life of this program — NO instruction that lets any
//! key withdraw curve principal. That absence is the design (the pump.fun
//! May-2024 insider drain was a privileged withdraw path, not a math bug).

use anchor_lang::prelude::*;

// Referenced so the graduation CPI crate is linked and version-checked by
// the Phase-0 build spike rather than at Phase-2 implementation time.
use raydium_cpmm_cpi::program::RaydiumCpmm;

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "dao.fun launchpad-curve",
    project_url: "https://github.com/mtremolada/dao.fun",
    contacts: "github:mtremolada/dao.fun",
    policy: "https://github.com/mtremolada/dao.fun/blob/main/REDTEAM.md",
    preferred_languages: "en",
    source_code: "https://github.com/mtremolada/dao.fun"
}

declare_id!("6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr");

/// Basis-point bounds on the total trade fee. The floor exists because a
/// zero-fee path makes wash trading free (the Meteora `cliff_fee = 0`
/// finding); the ceiling caps what a compromised authority could impose.
pub const MIN_TOTAL_FEE_BPS: u16 = 10;
pub const MAX_TOTAL_FEE_BPS: u16 = 500;

#[program]
pub mod launchpad_curve {
    use super::*;

    /// Phase-0 placeholder: creates the global config PDA so the pipeline
    /// (build → gzip fixture → load in bankrun → invoke) is proven end to
    /// end. Phase 2 replaces this with the full contract from
    /// SPEC-LAUNCHPAD.md §2, tests first.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        protocol_fee_bps: u16,
        creator_fee_bps: u16,
    ) -> Result<()> {
        let total = protocol_fee_bps
            .checked_add(creator_fee_bps)
            .ok_or(LaunchpadError::FeeOutOfRange)?;
        require!(
            (MIN_TOTAL_FEE_BPS..=MAX_TOTAL_FEE_BPS).contains(&total),
            LaunchpadError::FeeOutOfRange
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.creator_fee_bps = creator_fee_bps;
        config.cpmm_program = ctx.accounts.cpmm_program.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    /// CHECK: destination for protocol fees; only its address is stored.
    pub fee_recipient: UncheckedAccount<'info>,
    /// The graduation venue, recorded at init and never mutable afterwards:
    /// migration liquidity must not be redirectable by an authority key.
    pub cpmm_program: Program<'info, RaydiumCpmm>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub cpmm_program: Pubkey,
    pub bump: u8,
    /// Headroom so later parameters (launch-window guards, graduation fee)
    /// do not force a state migration on live curves.
    pub reserved: [u64; 8],
}

#[error_code]
pub enum LaunchpadError {
    #[msg("total trade fee is outside the permitted range")]
    FeeOutOfRange,
}
