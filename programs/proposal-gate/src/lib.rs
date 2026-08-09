//! proposal-gate — Stage 3 (spec 6.9): Guarded-mode enforcement and the
//! structural INV-11 ratchet.
//!
//! V2 (D-042, Option A "gate the front door"): the gate authority PDA
//! (`["gate-authority", realm]`) owns the realm's ONLY council token, and
//! the guarded governance config disables community proposal creation
//! (u64::MAX sentinel — binary-verified). Every proposal therefore enters
//! through this program: `create_gated_proposal` / `insert_gated_transaction`
//! / `sign_off_gated_proposal` CPI the deployed GovER5 fork with the gate
//! authority signing via invoke_signed, and the INSERT leg runs the same
//! whitelist validation engine over the exact bytes it is about to insert —
//! off-menu instructions never come to exist. `bind_realm` performs the
//! ceremony's council-token deposit (only the gate can sign for its PDA).
//!
//! CPI wire formats are hand-built to mirror the 0.3.28 client byte-for-byte
//! (variants 1/6/9/12 + account orders dumped and pinned in the R0 suite) —
//! the fork diverged from public source (D-032), so client-parity, proven in
//! bankrun against the deployed binary, is the ONLY trusted encoding. The
//! v1 surface (validate_transaction clearances for externally-created
//! proposals in council/cypherpunk modes, the one-way ratchet) is unchanged.
//!
//! Safety baseline (6.9): overflow-checks=on (workspace profile), typed
//! accounts, CPIs ONLY to the pinned governance/token programs with the
//! gate PDA as the sole forwarded signer, bump validation on every PDA,
//! checked manual deserialization throughout.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

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
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
pub const TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172,
    28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
/// SysvarRent111111111111111111111111111111111
pub const RENT_SYSVAR_ID: Pubkey = Pubkey::new_from_array([
    6, 167, 213, 23, 25, 44, 92, 81, 33, 140, 201, 76, 61, 74, 241, 127, 88,
    218, 238, 8, 155, 161, 253, 68, 227, 219, 217, 138, 0, 0, 0, 0,
]);

pub const GATE_AUTHORITY_SEED: &[u8] = b"gate-authority";

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
        community_mint: Pubkey,
        council_mint: Pubkey,
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
        gate.community_mint = community_mint;
        gate.council_mint = council_mint;
        gate.mode = mode;
        gate.bump = ctx.bumps.gate;
        gate.whitelist = whitelist;
        Ok(())
    }

    /// Ceremony step: deposit the gate's SINGLE council token into the
    /// realm, creating the token owner record that authors every guarded
    /// proposal. Only this program can sign for the gate authority PDA, so
    /// only this instruction can ever bind it. CPI wire format: variant 1
    /// (DepositGoverningTokens), client-parity, proven in the R0 suite.
    pub fn bind_realm(ctx: Context<BindRealm>) -> Result<()> {
        let realm_key = ctx.accounts.gate.realm;
        let mut data = Vec::with_capacity(9);
        data.push(1u8); // DepositGoverningTokens
        data.extend_from_slice(&1u64.to_le_bytes());
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(realm_key, false),
                AccountMeta::new(ctx.accounts.holding.key(), false),
                AccountMeta::new(ctx.accounts.source_ata.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gate_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.gate_authority.key(), true),
                AccountMeta::new(ctx.accounts.token_owner_record.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
                AccountMeta::new(ctx.accounts.realm_config.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.realm.to_account_info(),
                ctx.accounts.holding.to_account_info(),
                ctx.accounts.source_ata.to_account_info(),
                ctx.accounts.gate_authority.to_account_info(),
                ctx.accounts.token_owner_record.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.realm_config.to_account_info(),
            ],
            &[&[GATE_AUTHORITY_SEED, realm_key.as_ref(), &[ctx.bumps.gate_authority]]],
        )?;
        Ok(())
    }

    /// The front door: ANYONE may propose, but the proposal is authored by
    /// the gate's council record and its electorate is pinned to the
    /// COMMUNITY mint (the D-042 spike facts). Content is enforced at
    /// insert time, so creation itself is open — identity is not the
    /// protection, the menu is. CPI: variant 6 (CreateProposal).
    pub fn create_gated_proposal(
        ctx: Context<CreateGatedProposal>,
        name: String,
        description_link: String,
        proposal_seed: Pubkey,
    ) -> Result<()> {
        let realm_key = ctx.accounts.gate.realm;
        let mut data = Vec::with_capacity(64 + name.len() + description_link.len());
        data.push(6u8); // CreateProposal
        name.serialize(&mut data)?;
        description_link.serialize(&mut data)?;
        data.push(0u8); // VoteType::SingleChoice
        vec!["Approve".to_string()].serialize(&mut data)?;
        data.push(1u8); // use_deny_option
        data.extend_from_slice(proposal_seed.as_ref());
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(realm_key, false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new(ctx.accounts.governance.key(), false),
                AccountMeta::new(ctx.accounts.token_owner_record.key(), false),
                AccountMeta::new_readonly(ctx.accounts.community_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gate_authority.key(), true),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.realm_config.key(), false),
                AccountMeta::new(ctx.accounts.proposal_deposit.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.realm.to_account_info(),
                ctx.accounts.proposal.to_account_info(),
                ctx.accounts.governance.to_account_info(),
                ctx.accounts.token_owner_record.to_account_info(),
                ctx.accounts.community_mint.to_account_info(),
                ctx.accounts.gate_authority.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.realm_config.to_account_info(),
                ctx.accounts.proposal_deposit.to_account_info(),
            ],
            &[&[GATE_AUTHORITY_SEED, realm_key.as_ref(), &[ctx.bumps.gate_authority]]],
        )?;
        Ok(())
    }

    /// The enforcement point: the whitelist runs over the EXACT bytes about
    /// to be inserted (same engine as validate_transaction — outer program
    /// ids, Squads vault-message unwrap, buffered/ALT refusal), and only
    /// then does the gate authority sign the insert. Off-menu instructions
    /// never exist inside a guarded proposal. CPI: variant 9.
    pub fn insert_gated_transaction(
        ctx: Context<InsertGatedTransaction>,
        option_index: u8,
        index: u16,
        hold_up_time: u32,
        instructions: Vec<GateInstructionData>,
    ) -> Result<()> {
        require!(!instructions.is_empty(), GateError::MalformedTransaction);
        let gate = &ctx.accounts.gate;
        for gix in &instructions {
            require!(gate.allows(&gix.program_id), GateError::OffMenuProgram);
            if gix.program_id == SQUADS_V4_ID && gix.data.len() >= 8 {
                let disc: &[u8] = &gix.data[0..8];
                if disc == TX_BUFFER_CREATE_DISC {
                    return err!(GateError::BufferedNotSupported);
                }
                if disc == VAULT_TX_CREATE_DISC {
                    validate_vault_message(gate, &gix.data)?;
                }
            }
        }

        let realm_key = gate.realm;
        let mut data = Vec::with_capacity(64);
        data.push(9u8); // InsertTransaction
        data.push(option_index);
        data.extend_from_slice(&index.to_le_bytes());
        data.extend_from_slice(&hold_up_time.to_le_bytes());
        instructions.serialize(&mut data)?; // borsh-identical to InstructionData
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(ctx.accounts.governance.key(), false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_owner_record.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gate_authority.key(), true),
                AccountMeta::new(ctx.accounts.proposal_transaction.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(RENT_SYSVAR_ID, false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.governance.to_account_info(),
                ctx.accounts.proposal.to_account_info(),
                ctx.accounts.token_owner_record.to_account_info(),
                ctx.accounts.gate_authority.to_account_info(),
                ctx.accounts.proposal_transaction.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
            ],
            &[&[GATE_AUTHORITY_SEED, realm_key.as_ref(), &[ctx.bumps.gate_authority]]],
        )?;
        Ok(())
    }

    /// Owner-path sign-off: moves the gate-authored proposal into Voting.
    /// Safe to leave permissionless — every inserted transaction was
    /// whitelist-validated at insert, so there is nothing off-menu to open
    /// voting on. CPI: variant 12 (SignOffProposal).
    pub fn sign_off_gated_proposal(ctx: Context<SignOffGatedProposal>) -> Result<()> {
        let realm_key = ctx.accounts.gate.realm;
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new(realm_key, false),
                AccountMeta::new(ctx.accounts.governance.key(), false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gate_authority.key(), true),
                AccountMeta::new_readonly(ctx.accounts.token_owner_record.key(), false),
            ],
            data: vec![12u8],
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.realm.to_account_info(),
                ctx.accounts.governance.to_account_info(),
                ctx.accounts.proposal.to_account_info(),
                ctx.accounts.gate_authority.to_account_info(),
                ctx.accounts.token_owner_record.to_account_info(),
            ],
            &[&[GATE_AUTHORITY_SEED, realm_key.as_ref(), &[ctx.bumps.gate_authority]]],
        )?;
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

/// Borsh-identical to spl-governance InstructionData / AccountMetaData —
/// the SAME structs are validated and then serialized into the CPI, so the
/// bytes checked are the bytes inserted (no TOCTOU seam).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GateAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct GateInstructionData {
    pub program_id: Pubkey,
    pub accounts: Vec<GateAccountMeta>,
    pub data: Vec<u8>,
}

#[derive(Accounts)]
pub struct BindRealm<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: pure PDA signer; seeds pin it to this gate's realm.
    #[account(seeds = [GATE_AUTHORITY_SEED, gate.realm.as_ref()], bump)]
    pub gate_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's realm; contents validated by governance.
    #[account(address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: the realm's council holding account — governance validates.
    #[account(mut)]
    pub holding: UncheckedAccount<'info>,
    /// CHECK: the gate authority's council ATA — token program validates.
    #[account(mut)]
    pub source_ata: UncheckedAccount<'info>,
    /// CHECK: created by governance for (realm, council mint, gate authority).
    #[account(mut)]
    pub token_owner_record: UncheckedAccount<'info>,
    /// CHECK: the realm config PDA — governance validates.
    #[account(mut)]
    pub realm_config: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: pinned address.
    #[account(address = TOKEN_PROGRAM_ID @ GateError::WrongProgram)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: pinned address — the deployed GovER5 fork.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongProgram)]
    pub governance_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateGatedProposal<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: pure PDA signer.
    #[account(seeds = [GATE_AUTHORITY_SEED, gate.realm.as_ref()], bump)]
    pub gate_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's realm.
    #[account(address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: PDA derivation validated by governance against proposal_seed.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's governance.
    #[account(mut, address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: the gate's council token owner record — governance enforces
    /// that its owner is the signing gate authority.
    #[account(mut)]
    pub token_owner_record: UncheckedAccount<'info>,
    /// CHECK: the ELECTORATE is structurally the community mint.
    #[account(address = gate.community_mint @ GateError::WrongElectorate)]
    pub community_mint: UncheckedAccount<'info>,
    /// CHECK: realm config PDA — governance validates.
    pub realm_config: UncheckedAccount<'info>,
    /// CHECK: proposal deposit PDA — governance validates.
    #[account(mut)]
    pub proposal_deposit: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: pinned address — the deployed GovER5 fork.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongProgram)]
    pub governance_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InsertGatedTransaction<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: pure PDA signer.
    #[account(seeds = [GATE_AUTHORITY_SEED, gate.realm.as_ref()], bump)]
    pub gate_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's governance.
    #[account(address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: governance validates the proposal belongs to it.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: the gate's council TOR — governance enforces ownership.
    pub token_owner_record: UncheckedAccount<'info>,
    /// CHECK: ProposalTransaction PDA — governance derives and validates.
    #[account(mut)]
    pub proposal_transaction: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: pinned address.
    #[account(address = RENT_SYSVAR_ID @ GateError::WrongProgram)]
    pub rent: UncheckedAccount<'info>,
    /// CHECK: pinned address — the deployed GovER5 fork.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongProgram)]
    pub governance_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SignOffGatedProposal<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: pure PDA signer.
    #[account(seeds = [GATE_AUTHORITY_SEED, gate.realm.as_ref()], bump)]
    pub gate_authority: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's realm.
    #[account(mut, address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: pinned to the gate's governance.
    #[account(mut, address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: governance validates.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: the gate's council TOR (owner sign-off path).
    pub token_owner_record: UncheckedAccount<'info>,
    /// CHECK: pinned address — the deployed GovER5 fork.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongProgram)]
    pub governance_program: UncheckedAccount<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Gate {
    pub realm: Pubkey,
    pub governance: Pubkey,
    /// The electorate every gated proposal votes with (D-042).
    pub community_mint: Pubkey,
    /// The mint whose single token the gate authority holds.
    pub council_mint: Pubkey,
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
    #[msg("account is not the gate's realm")]
    WrongRealm,
    #[msg("gated proposals vote with the community mint only")]
    WrongElectorate,
    #[msg("account is not the pinned program/sysvar")]
    WrongProgram,
    #[msg("malformed transaction bytes")]
    MalformedTransaction,
}
