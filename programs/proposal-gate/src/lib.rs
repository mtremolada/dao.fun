//! proposal-gate — Stage 3 (spec 6.9): Guarded-mode enforcement and the
//! structural INV-11 ratchet.
//!
//! V2 (Option A, D-033): the gate is the FRONT DOOR. On a guarded realm
//! the ceremony (a) welds community proposal creation shut
//! (minCommunityTokensToCreateProposal = u64::MAX — verified unreachable
//! even for a whale holding the entire deposited supply, and for
//! delegates), (b) seats creation exclusively with the gate PDA, which
//! holds H+1 council tokens against minCouncilTokensToCreateProposal =
//! H+1 (all H human council members pooled stay below it; they keep the
//! veto), and (c) parks the REALM AUTHORITY on the gate PDA so no voted
//! proposal can touch realm config. Every proposal is therefore authored
//! through `guard_create_proposal`, every leg through
//! `guard_insert_transaction` — which, while the mode is guarded, runs
//! the validation engine on the EXACT bytes it forwards (program
//! whitelist outer + inside the Squads vault message; the governance
//! program itself is hard-refused to keep the config immutable even by
//! a winning vote). After a voted ratchet (mode > guarded) inserts
//! become unrestricted (spec 12.2: council/cypherpunk admit
//! "menu + arbitrary") and `release_realm_authority` hands the realm to
//! its own governance — the realm then converges on a standard MVP DAO.
//!
//! The deployed GovER5 fork has NO required-signatory mechanism (D-032),
//! so this front-door design replaces the abandoned sign-off path. All
//! CPI byte layouts below are pinned from @solana/spl-governance 0.3.28,
//! the client whose instructions the GATE 1 suites proved against this
//! exact binary; the guarded integration suite re-proves each CPI here.
//!
//! Safety baseline (6.9): overflow-checks=on (workspace profile), typed
//! accounts where the account is ours, NO CPI to user-supplied programs
//! (the only CPI target is the pinned governance id), no user-signer
//! forwarding beyond the requester paying rent, bump validation on every
//! PDA, checked manual deserialization throughout.

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
pub const TOKEN_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121,
    172, 28, 180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0,
    169,
]);
/// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
pub const TOKEN_2022_PROGRAM: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218,
    182, 26, 252, 77, 131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
]);

/// GovernanceInstruction variant bytes — the 0.3.28 enum, which the
/// deployed fork matches for every client-emitted instruction (proven by
/// GATE 1 and every integration suite running on the real binary).
const GOV_IX_DEPOSIT_GOVERNING_TOKENS: u8 = 1;
const GOV_IX_CREATE_PROPOSAL: u8 = 6;
const GOV_IX_INSERT_TRANSACTION: u8 = 9;
const GOV_IX_CANCEL_PROPOSAL: u8 = 11;
const GOV_IX_SIGN_OFF_PROPOSAL: u8 = 12;
const GOV_IX_SET_REALM_AUTHORITY: u8 = 21;
const SET_REALM_AUTHORITY_SET_CHECKED: u8 = 1;

/// spl-governance account tag (GovernanceAccountType::ProposalTransactionV2).
const PROPOSAL_TRANSACTION_V2: u8 = 13;
/// Squads anchor discriminators (verified against @sqds/multisig 2.1.4).
const VAULT_TX_CREATE_DISC: [u8; 8] = [48, 250, 78, 168, 208, 226, 218, 211];
const TX_BUFFER_CREATE_DISC: [u8; 8] = [245, 201, 113, 108, 37, 63, 29, 89];

pub const MAX_WHITELIST: usize = 16;

/// Mode ratchet levels — one-way TOWARD decentralization (INV-11):
/// guarded(0) -> council(1) -> cypherpunk(2) -> sovereign(3).
pub const MODE_GUARDED: u8 = 0;
pub const MODE_SOVEREIGN: u8 = 3;

#[program]
pub mod proposal_gate {
    use super::*;

    /// Created during the launch ceremony, once per realm (PDA seeds).
    /// The config is immutable afterwards — loosening the whitelist is
    /// exactly what the gate exists to prevent. `proposal_threshold` is
    /// the community holdings a requester must show to author through
    /// the gate (the spec tier threshold, since the realm-level one is
    /// welded to u64::MAX on guarded realms).
    pub fn initialize(
        ctx: Context<Initialize>,
        realm: Pubkey,
        governance: Pubkey,
        community_mint: Pubkey,
        council_mint: Pubkey,
        proposal_threshold: u64,
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
        gate.proposal_threshold = proposal_threshold;
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
        validate_instruction_set(gate, &mut r, ix_count, false)?;

        let clearance = &mut ctx.accounts.clearance;
        clearance.proposal = proposal;
        clearance.proposal_transaction = info.key();
        clearance.bump = ctx.bumps.clearance;
        Ok(())
    }

    /// Option A front door: authors a proposal on the deployed governance
    /// program with the gate's council TokenOwnerRecord as the owner and
    /// the gate PDA signing as governance authority. The voting
    /// population is the COMMUNITY mint (verified on the fork: a council
    /// record may author community-voted proposals). Anyone holding
    /// `proposal_threshold` community tokens may request authorship —
    /// the same anti-spam economics the open modes get from the realm
    /// config. Proposals are pinned single-choice Approve/Deny.
    pub fn guard_create_proposal(
        ctx: Context<GuardCreateProposal>,
        name: String,
        description_link: String,
        proposal_seed: Pubkey,
    ) -> Result<()> {
        let gate = &ctx.accounts.gate;
        require_requester_threshold(
            &ctx.accounts.requester_token,
            &ctx.accounts.requester.key(),
            gate,
        )?;
        assert_gate_tor(gate, &gate.key(), &ctx.accounts.gate_tor.key())?;

        // [6] name desc voteType=SingleChoice options=["Approve"] deny=1 seed
        let mut data = Vec::with_capacity(
            1 + 4 + name.len() + 4 + description_link.len() + 1 + 4 + 4 + 7 + 1 + 32,
        );
        data.push(GOV_IX_CREATE_PROPOSAL);
        push_str(&mut data, &name);
        push_str(&mut data, &description_link);
        data.push(0); // VoteType::SingleChoice
        data.extend_from_slice(&1u32.to_le_bytes());
        push_str(&mut data, "Approve");
        data.push(1); // use_deny_option
        data.extend_from_slice(&proposal_seed.to_bytes());

        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(gate.realm, false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new(gate.governance, false),
                AccountMeta::new(ctx.accounts.gate_tor.key(), false),
                AccountMeta::new_readonly(gate.community_mint, false),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new(ctx.accounts.requester.key(), true),
                AccountMeta::new_readonly(
                    anchor_lang::solana_program::system_program::ID,
                    false,
                ),
                AccountMeta::new_readonly(ctx.accounts.realm_config.key(), false),
                AccountMeta::new(ctx.accounts.proposal_deposit.key(), false),
            ],
            data,
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)?;

        let meta = &mut ctx.accounts.meta;
        meta.requester = ctx.accounts.requester.key();
        meta.proposal = ctx.accounts.proposal.key();
        meta.bump = ctx.bumps.meta;
        Ok(())
    }

    /// Inserts ONE leg into a gate-authored proposal. `ix_bytes` is the
    /// borsh Vec<InstructionData> exactly as the governance program will
    /// store it; while the mode is guarded the validation engine runs on
    /// THESE bytes before they are forwarded verbatim — no
    /// reserialization, so what was validated is what executes (INV-9
    /// spirit at the byte level). The governance program itself is
    /// hard-refused as a target while guarded (a SetGovernanceConfig leg
    /// would re-open the welded front door); the gate program is always
    /// admissible (the voted ratchet rides it).
    pub fn guard_insert_transaction(
        ctx: Context<GuardProposalAction>,
        index: u16,
        hold_up_seconds: u32,
        ix_bytes: Vec<u8>,
    ) -> Result<()> {
        let gate = &ctx.accounts.gate;
        assert_gate_tor(gate, &gate.key(), &ctx.accounts.gate_tor.key())?;
        if gate.mode == MODE_GUARDED {
            let mut r = Reader::new(&ix_bytes);
            let ix_count = r.u32()?;
            require!(ix_count > 0, GateError::MalformedTransaction);
            validate_instruction_set(gate, &mut r, ix_count, true)?;
            require!(r.exhausted(), GateError::MalformedTransaction);
        }

        let mut data = Vec::with_capacity(8 + ix_bytes.len());
        data.push(GOV_IX_INSERT_TRANSACTION);
        data.push(0); // option_index
        data.extend_from_slice(&index.to_le_bytes());
        data.extend_from_slice(&hold_up_seconds.to_le_bytes());
        data.extend_from_slice(&ix_bytes);

        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(gate.governance, false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new_readonly(ctx.accounts.gate_tor.key(), false),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new(ctx.accounts.proposal_transaction.key(), false),
                AccountMeta::new(ctx.accounts.requester.key(), true),
                AccountMeta::new_readonly(
                    anchor_lang::solana_program::system_program::ID,
                    false,
                ),
                AccountMeta::new_readonly(
                    anchor_lang::solana_program::sysvar::rent::ID,
                    false,
                ),
            ],
            data,
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)
    }

    /// Sign-off, requester-gated. Every leg already passed guarded
    /// validation at insert time (the gate is the only possible
    /// inserter), so this is a pass-through CPI.
    pub fn guard_sign_off(ctx: Context<GuardSignOff>) -> Result<()> {
        let gate = &ctx.accounts.gate;
        assert_gate_tor(gate, &gate.key(), &ctx.accounts.gate_tor.key())?;
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new(gate.realm, false),
                AccountMeta::new(gate.governance, false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new_readonly(ctx.accounts.gate_tor.key(), false),
            ],
            data: vec![GOV_IX_SIGN_OFF_PROPOSAL],
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)
    }

    /// Cancel, requester-gated (the gate owns every proposal, so the
    /// human who asked for it needs this path to withdraw it).
    pub fn guard_cancel(ctx: Context<GuardSignOff>) -> Result<()> {
        let gate = &ctx.accounts.gate;
        assert_gate_tor(gate, &gate.key(), &ctx.accounts.gate_tor.key())?;
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new(gate.realm, false),
                AccountMeta::new(gate.governance, false),
                AccountMeta::new(ctx.accounts.proposal.key(), false),
                AccountMeta::new(ctx.accounts.gate_tor.key(), false),
                AccountMeta::new_readonly(gate.key(), true),
            ],
            data: vec![GOV_IX_CANCEL_PROPOSAL],
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)
    }

    /// Ceremony step: deposits the gate's H+1 council tokens into its own
    /// TokenOwnerRecord (the creation seat). Permissionless — it can only
    /// ever move the gate's OWN tokens into the gate's OWN record.
    pub fn deposit_council(ctx: Context<DepositCouncil>, amount: u64) -> Result<()> {
        let gate = &ctx.accounts.gate;
        assert_gate_tor(gate, &gate.key(), &ctx.accounts.gate_tor.key())?;
        let mut data = Vec::with_capacity(9);
        data.push(GOV_IX_DEPOSIT_GOVERNING_TOKENS);
        data.extend_from_slice(&amount.to_le_bytes());
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new_readonly(gate.realm, false),
                AccountMeta::new(ctx.accounts.holding.key(), false),
                AccountMeta::new(ctx.accounts.gate_council_ata.key(), false),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new(ctx.accounts.gate_tor.key(), false),
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new_readonly(
                    anchor_lang::solana_program::system_program::ID,
                    false,
                ),
                AccountMeta::new_readonly(TOKEN_PROGRAM, false),
                AccountMeta::new(ctx.accounts.realm_config.key(), false),
            ],
            data,
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)
    }

    /// After a voted ratchet out of guarded, hands the realm to its own
    /// governance (SetChecked — the program verifies the new authority is
    /// a governance of this realm). Permissionless: mode > guarded IS the
    /// voted decision; this crank just completes the standard MVP shape.
    pub fn release_realm_authority(ctx: Context<ReleaseRealmAuthority>) -> Result<()> {
        let gate = &ctx.accounts.gate;
        require!(gate.mode > MODE_GUARDED, GateError::StillGuarded);
        let ix = Instruction {
            program_id: SPL_GOVERNANCE_ID,
            accounts: vec![
                AccountMeta::new(gate.realm, false),
                AccountMeta::new_readonly(gate.key(), true),
                AccountMeta::new_readonly(gate.governance, false),
            ],
            data: vec![GOV_IX_SET_REALM_AUTHORITY, SET_REALM_AUTHORITY_SET_CHECKED],
        };
        invoke_gate_signed(&ix, ctx.accounts.cpi_infos(), gate)
    }
}

// ---------- validation engine ----------

/// Validates `ix_count` borsh InstructionData records read from `r`
/// against the gate whitelist; unwraps Squads vaultTransactionCreate legs
/// and validates the vault-signed INNER set too. `guarded_insert` adds
/// the front-door rules: the governance program is refused outright
/// (config immutability) and the gate program itself is always admitted
/// (the ratchet leg).
fn validate_instruction_set(
    gate: &Gate,
    r: &mut Reader,
    ix_count: u32,
    guarded_insert: bool,
) -> Result<()> {
    for _ in 0..ix_count {
        let program_id = r.pubkey()?;
        check_program(gate, &program_id, guarded_insert)?;
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
                // use the plain wrap (documented limitation).
                return err!(GateError::BufferedNotSupported);
            }
            if disc == VAULT_TX_CREATE_DISC {
                validate_vault_message(gate, ix_data, guarded_insert)?;
            }
        }
    }
    Ok(())
}

fn check_program(gate: &Gate, program_id: &Pubkey, guarded_insert: bool) -> Result<()> {
    if guarded_insert {
        // The welded front door stays welded: no leg may target the
        // governance program while guarded, whatever the whitelist says
        // (SetGovernanceConfig/SetRealmConfig would re-open creation).
        require!(
            *program_id != SPL_GOVERNANCE_ID,
            GateError::GovernanceSelfCallRefused
        );
        // The gate's own ratchet is how a DAO votes its way out.
        if *program_id == crate::ID {
            return Ok(());
        }
    }
    require!(gate.allows(program_id), GateError::OffMenuProgram);
    Ok(())
}

/// The vault-signed INNER instruction set rides inside the Squads
/// vaultTransactionCreate args; every inner program id must be on the
/// whitelist too — this is where a smuggled off-menu CPI would hide.
fn validate_vault_message(gate: &Gate, ix_data: &[u8], guarded_insert: bool) -> Result<()> {
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
        check_program(gate, program_id, guarded_insert)?;
        let acct_count = m.u8()? as usize;
        m.skip(acct_count)?;
        let data_len = m.u16()? as usize;
        m.skip(data_len)?;
    }
    // address-table lookups would resolve keys we cannot see — refuse any.
    require!(m.u8()? == 0, GateError::AltNotSupported);
    Ok(())
}

// ---------- CPI plumbing ----------

fn push_str(data: &mut Vec<u8>, s: &str) {
    data.extend_from_slice(&(s.len() as u32).to_le_bytes());
    data.extend_from_slice(s.as_bytes());
}

fn invoke_gate_signed(
    ix: &Instruction,
    infos: Vec<AccountInfo>,
    gate: &Account<Gate>,
) -> Result<()> {
    let realm = gate.realm;
    let seeds: &[&[u8]] = &[b"gate", realm.as_ref(), &[gate.bump]];
    invoke_signed(ix, &infos, &[seeds]).map_err(Into::into)
}

/// The gate's council TokenOwnerRecord under the deployed governance
/// program: ["governance", realm, council_mint, gate].
fn assert_gate_tor(gate: &Gate, gate_pda: &Pubkey, tor: &Pubkey) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[
            b"governance",
            gate.realm.as_ref(),
            gate.council_mint.as_ref(),
            gate_pda.as_ref(),
        ],
        &SPL_GOVERNANCE_ID,
    );
    require_keys_eq!(*tor, expected, GateError::WrongTokenOwnerRecord);
    Ok(())
}

/// Requester anti-spam: a community token account owned by the requester
/// holding at least the gate's threshold. Base layout is identical for
/// spl-token and token-2022 (mint 0..32, owner 32..64, amount 64..72,
/// state byte 108).
fn require_requester_threshold(
    token: &AccountInfo,
    requester: &Pubkey,
    gate: &Gate,
) -> Result<()> {
    require!(
        *token.owner == TOKEN_PROGRAM || *token.owner == TOKEN_2022_PROGRAM,
        GateError::RequesterBelowThreshold
    );
    let data = token.try_borrow_data()?;
    require!(data.len() >= 109, GateError::RequesterBelowThreshold);
    let mint = Pubkey::try_from(&data[0..32]).unwrap();
    let owner = Pubkey::try_from(&data[32..64]).unwrap();
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap());
    require!(
        mint == gate.community_mint
            && owner == *requester
            && data[108] == 1 // AccountState::Initialized (not frozen)
            && amount >= gate.proposal_threshold,
        GateError::RequesterBelowThreshold
    );
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
    fn exhausted(&self) -> bool {
        self.pos == self.data.len()
    }
}

// ---------- accounts ----------

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

#[derive(Accounts)]
pub struct GuardCreateProposal<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// Who asked for this proposal; pays all rent and is the only key
    /// that can insert/sign-off/cancel it afterwards.
    #[account(mut)]
    pub requester: Signer<'info>,
    /// CHECK: parsed and threshold-checked in the handler.
    pub requester_token: UncheckedAccount<'info>,
    #[account(
        init,
        payer = requester,
        space = 8 + ProposalMeta::INIT_SPACE,
        seeds = [b"meta", proposal.key().as_ref()],
        bump
    )]
    pub meta: Account<'info, ProposalMeta>,
    /// CHECK: must be the gate's realm; the governance program validates
    /// the account itself.
    #[account(address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: created by the governance program at the seed-derived
    /// address (it validates the PDA against proposal_seed).
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: must be the gate's governance; validated by address.
    #[account(mut, address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: derived in the handler (the gate's council TOR).
    #[account(mut)]
    pub gate_tor: UncheckedAccount<'info>,
    /// CHECK: the community (voting) mint; validated by address.
    #[account(address = gate.community_mint @ GateError::WrongRealm)]
    pub community_mint: UncheckedAccount<'info>,
    /// CHECK: realm config PDA; the governance program validates it.
    pub realm_config: UncheckedAccount<'info>,
    /// CHECK: proposal deposit PDA (payer-scoped); the governance program
    /// validates and (within the exempt window) leaves it empty.
    #[account(mut)]
    pub proposal_deposit: UncheckedAccount<'info>,
    /// CHECK: pinned to the deployed governance id.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongOwner)]
    pub governance_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> GuardCreateProposal<'info> {
    fn cpi_infos(&self) -> Vec<AccountInfo<'info>> {
        vec![
            self.realm.to_account_info(),
            self.proposal.to_account_info(),
            self.governance.to_account_info(),
            self.gate_tor.to_account_info(),
            self.community_mint.to_account_info(),
            self.governance_program.to_account_info(),
            self.requester.to_account_info(),
            self.system_program.to_account_info(),
            self.realm_config.to_account_info(),
            self.proposal_deposit.to_account_info(),
            self.gate.to_account_info(),
        ]
    }
}

#[derive(Accounts)]
pub struct GuardProposalAction<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        seeds = [b"meta", proposal.key().as_ref()],
        bump = meta.bump,
        has_one = requester @ GateError::NotTheRequester
    )]
    pub meta: Account<'info, ProposalMeta>,
    /// CHECK: validated against meta by the seeds above and by the
    /// governance program.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: must be the gate's governance; validated by address.
    #[account(address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: derived in the handler (the gate's council TOR).
    pub gate_tor: UncheckedAccount<'info>,
    /// CHECK: created by the governance program at the derived address.
    #[account(mut)]
    pub proposal_transaction: UncheckedAccount<'info>,
    /// CHECK: pinned to the deployed governance id.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongOwner)]
    pub governance_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: rent sysvar (the governance insert path requires it).
    #[account(address = anchor_lang::solana_program::sysvar::rent::ID)]
    pub rent: UncheckedAccount<'info>,
}

impl<'info> GuardProposalAction<'info> {
    fn cpi_infos(&self) -> Vec<AccountInfo<'info>> {
        vec![
            self.governance.to_account_info(),
            self.proposal.to_account_info(),
            self.gate_tor.to_account_info(),
            self.proposal_transaction.to_account_info(),
            self.requester.to_account_info(),
            self.governance_program.to_account_info(),
            self.system_program.to_account_info(),
            self.rent.to_account_info(),
            self.gate.to_account_info(),
        ]
    }
}

#[derive(Accounts)]
pub struct GuardSignOff<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    pub requester: Signer<'info>,
    #[account(
        seeds = [b"meta", proposal.key().as_ref()],
        bump = meta.bump,
        has_one = requester @ GateError::NotTheRequester
    )]
    pub meta: Account<'info, ProposalMeta>,
    /// CHECK: the realm; mutated by the governance program.
    #[account(mut, address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: the governance; mutated by the governance program.
    #[account(mut, address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: validated by the governance program.
    #[account(mut)]
    pub proposal: UncheckedAccount<'info>,
    /// CHECK: derived in the handler (the gate's council TOR).
    #[account(mut)]
    pub gate_tor: UncheckedAccount<'info>,
    /// CHECK: pinned to the deployed governance id.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongOwner)]
    pub governance_program: UncheckedAccount<'info>,
}

impl<'info> GuardSignOff<'info> {
    fn cpi_infos(&self) -> Vec<AccountInfo<'info>> {
        vec![
            self.realm.to_account_info(),
            self.governance.to_account_info(),
            self.proposal.to_account_info(),
            self.gate_tor.to_account_info(),
            self.governance_program.to_account_info(),
            self.gate.to_account_info(),
        ]
    }
}

#[derive(Accounts)]
pub struct DepositCouncil<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the realm; validated by address against the gate config.
    #[account(address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: governing token holding PDA; the governance program
    /// validates it.
    #[account(mut)]
    pub holding: UncheckedAccount<'info>,
    /// CHECK: the gate's council token account — the token program
    /// enforces ownership when the gate signs the transfer.
    #[account(mut)]
    pub gate_council_ata: UncheckedAccount<'info>,
    /// CHECK: derived in the handler (the gate's council TOR).
    #[account(mut)]
    pub gate_tor: UncheckedAccount<'info>,
    /// CHECK: realm config PDA; the governance program validates it.
    #[account(mut)]
    pub realm_config: UncheckedAccount<'info>,
    /// CHECK: pinned to the deployed governance id.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongOwner)]
    pub governance_program: UncheckedAccount<'info>,
    /// CHECK: classic SPL token program (council mints are classic).
    #[account(address = TOKEN_PROGRAM)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> DepositCouncil<'info> {
    fn cpi_infos(&self) -> Vec<AccountInfo<'info>> {
        vec![
            self.realm.to_account_info(),
            self.holding.to_account_info(),
            self.gate_council_ata.to_account_info(),
            self.gate_tor.to_account_info(),
            self.payer.to_account_info(),
            self.governance_program.to_account_info(),
            self.token_program.to_account_info(),
            self.system_program.to_account_info(),
            self.realm_config.to_account_info(),
            self.gate.to_account_info(),
        ]
    }
}

#[derive(Accounts)]
pub struct ReleaseRealmAuthority<'info> {
    #[account(seeds = [b"gate", gate.realm.as_ref()], bump = gate.bump)]
    pub gate: Account<'info, Gate>,
    /// CHECK: the realm; validated by address against the gate config.
    #[account(mut, address = gate.realm @ GateError::WrongRealm)]
    pub realm: UncheckedAccount<'info>,
    /// CHECK: the governance the realm is handed to (SetChecked — the
    /// governance program verifies it belongs to this realm).
    #[account(address = gate.governance @ GateError::WrongGovernance)]
    pub governance: UncheckedAccount<'info>,
    /// CHECK: pinned to the deployed governance id.
    #[account(address = SPL_GOVERNANCE_ID @ GateError::WrongOwner)]
    pub governance_program: UncheckedAccount<'info>,
}

impl<'info> ReleaseRealmAuthority<'info> {
    fn cpi_infos(&self) -> Vec<AccountInfo<'info>> {
        vec![
            self.realm.to_account_info(),
            self.governance.to_account_info(),
            self.governance_program.to_account_info(),
            self.gate.to_account_info(),
        ]
    }
}

// ---------- state ----------

#[account]
#[derive(InitSpace)]
pub struct Gate {
    pub realm: Pubkey,
    pub governance: Pubkey,
    pub community_mint: Pubkey,
    pub council_mint: Pubkey,
    pub proposal_threshold: u64,
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

/// Who asked the gate to author a proposal; only they may insert,
/// sign-off or cancel it.
#[account]
#[derive(InitSpace)]
pub struct ProposalMeta {
    pub requester: Pubkey,
    pub proposal: Pubkey,
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
    #[msg("account is not this gate's realm")]
    WrongRealm,
    #[msg("not the gate's council TokenOwnerRecord")]
    WrongTokenOwnerRecord,
    #[msg("requester does not hold the community proposal threshold")]
    RequesterBelowThreshold,
    #[msg("only the original requester may act on this proposal")]
    NotTheRequester,
    #[msg("no governance-program leg may exist while the realm is guarded")]
    GovernanceSelfCallRefused,
    #[msg("the realm is still guarded (ratchet first)")]
    StillGuarded,
}
