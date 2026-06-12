//! proposal-gate — Stage 3 (spec 6.9): Guarded-mode enforcement and the
//! structural INV-11 ratchet.
//!
//! V1 SCOPE (this increment): the on-chain VALIDATION ENGINE + ratchet.
//! `validate_transaction` parses a REAL spl-governance
//! ProposalTransactionV2 account, unwraps any Squads vaultTransactionCreate
//! it carries (the ExecutionAdapter custody chain), and creates a
//! Clearance PDA only when EVERY instruction — outer legs AND the inner
//! vault-signed set — targets a program on the gate's whitelist. Buffered
//! Squads messages and address-table lookups are REFUSED (cannot be
//! validated from a single account; guarded proposals must use the plain
//! wrap). The sign-off ENFORCEMENT seam is being redesigned: the deployed
//! GovER5 fork has NO required-signatory mechanism (D-032 — verified
//! against the binary), so the planned "gate PDA as required signatory"
//! path is abandoned. The leading replacement is the gate holding realm
//! authority + gating proposal-creation weight (operator decision
//! pending). The validation engine + clearances below are unaffected.
//!
//! Safety baseline (6.9): overflow-checks=on (workspace profile), typed
//! accounts, NO CPI anywhere in v1, no user-signer forwarding, bump
//! validation on every PDA, checked manual deserialization throughout.

use anchor_lang::prelude::*;

declare_id!("3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg");

/// Deployed program ids the gate trusts structurally (pinned, VERSIONS.md;
/// byte arrays because anchor 0.30 does not re-export the pubkey! macro).
/// GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw
pub const SPL_GOVERNANCE_ID: Pubkey = Pubkey::new_from_array([
    234, 228, 53, 189, 238, 117, 183, 52, 205, 89, 62, 207, 154, 48, 75, 128,
    36, 186, 40, 152, 103, 183, 105, 177, 249, 60, 167, 187, 184, 142, 70, 254,
]);
/// SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf
pub const SQUADS_V4_ID: Pubkey = Pubkey::new_from_array([
    6, 129, 196, 206, 71, 226, 35, 104, 184, 177, 85, 94, 200, 135, 175, 9, 46,
    252, 126, 251, 182, 108, 163, 245, 47, 191, 104, 212, 172, 156, 183, 168,
]);

/// spl-governance account tag (GovernanceAccountType::ProposalTransactionV2).
const PROPOSAL_TRANSACTION_V2: u8 = 13;
/// Squads anchor discriminators (verified against @sqds/multisig 2.1.4).
const VAULT_TX_CREATE_DISC: [u8; 8] = [48, 250, 78, 168, 208, 226, 218, 211];
const TX_BUFFER_CREATE_DISC: [u8; 8] = [245, 201, 113, 108, 37, 63, 29, 89];

pub const MAX_WHITELIST: usize = 16;

/// Mode ratchet levels — one-way TOWARD decentralization (INV-11):
/// guarded(0) -> council(1) -> cypherpunk(2) -> sovereign(3).
pub const MODE_SOVEREIGN: u8 = 3;

#[program]
pub mod proposal_gate {
    use super::*;

    /// Created during the launch ceremony, once per realm (PDA seeds).
    /// The whitelist is immutable afterwards — loosening it is exactly
    /// what the gate exists to prevent.
    pub fn initialize(
        ctx: Context<Initialize>,
        realm: Pubkey,
        governance: Pubkey,
        mode: u8,
        whitelist: Vec<Pubkey>,
    ) -> Result<()> {
        require!(mode <= MODE_SOVEREIGN, GateError::InvalidMode);
        require!(
            !whitelist.is_empty() && whitelist.len() <= MAX_WHITELIST,
            GateError::WhitelistSize
        );
        let gate = &mut ctx.accounts.gate;
        gate.realm = realm;
        gate.governance = governance;
        gate.mode = mode;
        gate.bump = ctx.bumps.gate;
        gate.whitelist = whitelist;
        Ok(())
    }

    /// INV-11 structurally: the mode only ever moves toward
    /// decentralization, and only the DAO itself (the governance PDA,
    /// which signs exclusively through executed proposals) can move it.
    pub fn ratchet(ctx: Context<Ratchet>, new_mode: u8) -> Result<()> {
        let gate = &mut ctx.accounts.gate;
        require!(new_mode <= MODE_SOVEREIGN, GateError::InvalidMode);
        require!(new_mode > gate.mode, GateError::RatchetViolation);
        gate.mode = new_mode;
        Ok(())
    }

    /// Permissionless crank: validates ONE ProposalTransaction against the
    /// whitelist and records the clearance. Fails (creating nothing) on
    /// the first off-menu program, malformed byte, buffered message or ALT.
    pub fn validate_transaction(ctx: Context<ValidateTransaction>) -> Result<()> {
        let gate = &ctx.accounts.gate;
        let info = &ctx.accounts.proposal_transaction;
        require_keys_eq!(*info.owner, SPL_GOVERNANCE_ID, GateError::WrongOwner);

        let data = info.try_borrow_data()?;
        let mut r = Reader::new(&data);
        require!(
            r.u8()? == PROPOSAL_TRANSACTION_V2,
            GateError::WrongAccountType
        );
        let proposal = r.pubkey()?;
        r.skip(1 + 2 + 4)?; // option_index, transaction_index, hold_up_time

        let ix_count = r.u32()?;
        require!(ix_count > 0, GateError::MalformedTransaction);
        for _ in 0..ix_count {
            let program_id = r.pubkey()?;
            require!(gate.allows(&program_id), GateError::OffMenuProgram);
            let meta_count = r.u32()?;
            r.skip(
                (meta_count as usize)
                    .checked_mul(34)
                    .ok_or(GateError::MalformedTransaction)?,
            )?;
            let data_len = r.u32()? as usize;
            let ix_data = r.bytes(data_len)?;

            if program_id == SQUADS_V4_ID && data_len >= 8 {
                let disc: &[u8] = &ix_data[0..8];
                if disc == TX_BUFFER_CREATE_DISC {
                    // a buffered message spans several ProposalTransactions —
                    // it cannot be validated here. Guarded proposals must
                    // use the plain wrap (v1 limitation, documented).
                    return err!(GateError::BufferedNotSupported);
                }
                if disc == VAULT_TX_CREATE_DISC {
                    validate_vault_message(gate, ix_data)?;
                }
            }
        }

        let clearance = &mut ctx.accounts.clearance;
        clearance.proposal = proposal;
        clearance.proposal_transaction = info.key();
        clearance.bump = ctx.bumps.clearance;
        Ok(())
    }
}

/// The vault-signed INNER instruction set rides inside the Squads
/// vaultTransactionCreate args; every inner program id must be on the
/// whitelist too — this is where a smuggled off-menu CPI would hide.
fn validate_vault_message(gate: &Gate, ix_data: &[u8]) -> Result<()> {
    let mut r = Reader::new(ix_data);
    r.skip(8 + 1 + 1)?; // discriminator, vault_index, ephemeral_signers
    let msg_len = r.u32()? as usize;
    let msg = r.bytes(msg_len)?;

    let mut m = Reader::new(msg);
    m.skip(3)?; // num_signers, num_writable_signers, num_writable_non_signers
    let key_count = m.u8()? as usize;
    let mut keys: Vec<Pubkey> = Vec::with_capacity(key_count);
    for _ in 0..key_count {
        keys.push(m.pubkey()?);
    }
    let ix_count = m.u8()?;
    require!(ix_count > 0, GateError::MalformedTransaction);
    for _ in 0..ix_count {
        let program_idx = m.u8()? as usize;
        let program_id = keys
            .get(program_idx)
            .ok_or(GateError::MalformedTransaction)?;
        require!(gate.allows(program_id), GateError::OffMenuProgram);
        let acct_count = m.u8()? as usize;
        m.skip(acct_count)?;
        let data_len = m.u16()? as usize;
        m.skip(data_len)?;
    }
    // address-table lookups would resolve keys we cannot see — refuse any.
    require!(m.u8()? == 0, GateError::AltNotSupported);
    Ok(())
}

/// Checked byte reader — every read is bounds-validated (INV-6 spirit).
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or(GateError::MalformedTransaction)?;
        let out = self
            .data
            .get(self.pos..end)
            .ok_or(GateError::MalformedTransaction)?;
        self.pos = end;
        Ok(out)
    }
    fn skip(&mut self, n: usize) -> Result<()> {
        self.bytes(n).map(|_| ())
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        let b = self.bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn u32(&mut self) -> Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn pubkey(&mut self) -> Result<Pubkey> {
        let b = self.bytes(32)?;
        Pubkey::try_from(b).map_err(|_| error!(GateError::MalformedTransaction))
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

#[derive(Accounts)]
pub struct Ratchet<'info> {
    #[account(
        mut,
        seeds = [b"gate", gate.realm.as_ref()],
        bump = gate.bump,
        has_one = governance @ GateError::WrongGovernance
    )]
    pub gate: Account<'info, Gate>,
    /// The governance PDA only ever signs through executed proposals —
    /// a ratchet is therefore always a voted decision.
    pub governance: Signer<'info>,
}

#[derive(Accounts)]
pub struct ValidateTransaction<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: owner + account-type tag validated in the handler; contents
    /// are parsed with the checked Reader.
    pub proposal_transaction: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Clearance::INIT_SPACE,
        seeds = [b"clearance", proposal_transaction.key().as_ref()],
        bump
    )]
    pub clearance: Account<'info, Clearance>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Gate {
    pub realm: Pubkey,
    pub governance: Pubkey,
    pub mode: u8,
    pub bump: u8,
    #[max_len(MAX_WHITELIST)]
    pub whitelist: Vec<Pubkey>,
}

impl Gate {
    pub fn allows(&self, program_id: &Pubkey) -> bool {
        self.whitelist.iter().any(|p| p == program_id)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Clearance {
    pub proposal: Pubkey,
    pub proposal_transaction: Pubkey,
    pub bump: u8,
}

#[error_code]
pub enum GateError {
    #[msg("mode must be one of guarded(0)/council(1)/cypherpunk(2)/sovereign(3)")]
    InvalidMode,
    #[msg("the mode ratchet is one-way toward decentralization (INV-11)")]
    RatchetViolation,
    #[msg("whitelist must have 1..=16 entries")]
    WhitelistSize,
    #[msg("account is not owned by spl-governance")]
    WrongOwner,
    #[msg("account is not a ProposalTransactionV2")]
    WrongAccountType,
    #[msg("instruction targets a program outside the gate whitelist")]
    OffMenuProgram,
    #[msg("buffered Squads messages cannot be gate-validated; use the plain wrap")]
    BufferedNotSupported,
    #[msg("address table lookups are not supported by the gate")]
    AltNotSupported,
    #[msg("gate does not govern this realm's governance")]
    WrongGovernance,
    #[msg("malformed transaction bytes")]
    MalformedTransaction,
}
