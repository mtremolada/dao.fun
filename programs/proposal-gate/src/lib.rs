//! proposal-gate — Stage 3 (spec 6.9): holds the realm authority and only
//! signs off proposals whose instruction set is byte-validated against the
//! fixed action menu; enforces the INV-11 mode ratchet structurally.
//!
//! SCAFFOLD STATE: this crate currently pins the build pipeline only (the
//! GATE 3 path runs cargo build-sbf and loads the artifact in bankrun —
//! see tests/stage3-build.integration.test.ts). The gate logic lands
//! tests-first per the component contract; nothing here touches funds.

use anchor_lang::prelude::*;

declare_id!("3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg");

#[program]
pub mod proposal_gate {
    use super::*;

    /// Build-pipeline smoke instruction: creates the gate's config PDA so
    /// the bankrun smoke test exercises account creation, the anchor
    /// discriminator, and bump validation against OUR compiled binary.
    pub fn initialize(ctx: Context<Initialize>, realm: Pubkey) -> Result<()> {
        let gate = &mut ctx.accounts.gate;
        gate.realm = realm;
        gate.bump = ctx.bumps.gate;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(realm: Pubkey)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Gate::INIT_SPACE,
        seeds = [b"gate", realm.as_ref()],
        bump
    )]
    pub gate: Account<'info, Gate>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Gate {
    pub realm: Pubkey,
    pub bump: u8,
}
