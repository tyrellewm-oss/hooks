use anchor_lang::prelude::*;
use crate::constants::{MAX_EXEMPT, POT_WINNERS};

#[account]
#[derive(InitSpace)]
pub struct Global {
    /// Lift-switch authority (devnet: throwaway test key; mainnet plan: 2-of-3 human Squads).
    pub authority: Pubkey,
    /// Global allow-all. One-way: false -> true only.
    pub lifted: bool,
    pub bump: u8,
}

/// Global as created by `initialize_global`: discriminator + authority + lifted + bump = 42 bytes.
pub const GLOBAL_V1_LEN: usize = 8 + Global::INIT_SPACE;
/// Global after `migrate_global_v2` (8.3): v1 + `launch_authority` at bytes 42..74.
/// The field is deliberately NOT in the `Global` struct: every transfer loads `Account<Global>`, and a 42-byte
/// account would stop deserializing (all transfers fail) until the migration lands. Read it with `launch_authority_of`.
pub const GLOBAL_V2_LEN: usize = GLOBAL_V1_LEN + 32;

/// The launch key stored at bytes 42..74 of Global, or None when the account is shorter than 74 bytes (not
/// migrated) or the bytes are all zero (never a valid launch key).
pub fn launch_authority_of(global_data: &[u8]) -> Option<Pubkey> {
    let b = global_data.get(GLOBAL_V1_LEN..GLOBAL_V2_LEN)?;
    if b.iter().all(|x| *x == 0) { return None; }
    Pubkey::try_from(b).ok()
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace, PartialEq, Eq)]
pub struct StepData {
    pub slot_offset: u64,
    pub max_bps: u16,
}

/// Immutable after init: no instruction writes this account again.
#[account]
#[derive(InitSpace)]
pub struct MintConfig {
    pub mint: Pubkey,
    pub launch_slot: u64,
    pub supply_ref: u64,
    pub steps: [StepData; cap_math::MAX_STEPS],
    pub step_count: u8,
    pub uncapped_after: u64,
    pub exempt_owners: [Pubkey; MAX_EXEMPT],
    pub exempt_count: u8,
    /// true only if the program that wrote this config was built with `test-slots` (LOCAL).
    pub test_slots_build: bool,
    pub launcher: Pubkey,
    pub bump: u8,
}

impl MintConfig {
    pub fn cap_config(&self) -> cap_math::CapConfig {
        let mut steps = [cap_math::Step::default(); cap_math::MAX_STEPS];
        for (i, s) in self.steps.iter().enumerate() {
            steps[i] = cap_math::Step { slot_offset: s.slot_offset, max_bps: s.max_bps };
        }
        cap_math::CapConfig {
            launch_slot: self.launch_slot,
            supply: self.supply_ref,
            steps,
            step_count: self.step_count,
            uncapped_after: self.uncapped_after,
        }
    }
}

/// The only mutable rule state per mint; changed only by the lift-only switch.
#[account]
#[derive(InitSpace)]
pub struct LiftState {
    pub mint: Pubkey,
    pub lifted: bool,
    pub raised_floor_bps: u16,
    pub bump: u8,
}

impl LiftState {
    pub fn to_lift(&self) -> cap_math::Lift {
        cap_math::Lift { lifted: self.lifted, raised_floor_bps: self.raised_floor_bps }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitConfigArgs {
    pub steps: Vec<StepData>,
    pub uncapped_after: u64,
    pub supply_ref: u64,
    pub exempt_owners: Vec<Pubkey>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScheduleView {
    pub mint: Pubkey,
    pub launch_slot: u64,
    pub supply_ref: u64,
    pub steps: Vec<StepData>,
    pub uncapped_after: u64,
    pub test_slots_build: bool,
    pub program_built_with_test_slots: bool,
    pub slot: u64,
    pub effective_cap: Option<u64>,
    pub mint_lifted: bool,
    pub raised_floor_bps: u16,
    pub global_lifted: bool,
}

/// v2 buy rules, fixed at launch (only the counters below the line change, and only in the transfer hook).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RulesArgs {
    /// Max tokens (raw) one buy from the curve may take during the window; 0 = off.
    pub max_buy_tokens: u64,
    /// Max tokens (raw) all buys together may take in one slot during the window; 0 = off.
    pub max_per_slot_tokens: u64,
    /// Window for the two buy limits, in slots after launch; 0 = the whole bonding curve.
    pub window_slots: u64,
    /// Nth-buy pot: every Nth qualifying buy wins; 0 = off.
    pub pot_every: u32,
    /// Nth-buy pot: a buy qualifies from this many tokens (raw).
    pub pot_min_tokens: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace, PartialEq, Eq)]
pub struct PotWin {
    pub owner: Pubkey,
    pub token_account: Pubkey,
    pub buy_index: u64,
    pub slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct RulesState {
    pub mint: Pubkey,
    pub bump: u8,
    pub launch_slot: u64,
    pub max_buy_tokens: u64,
    pub max_per_slot_tokens: u64,
    pub window_slots: u64,
    pub pot_every: u32,
    pub pot_min_tokens: u64,
    // ---- counters (written only by transfer_hook)
    pub cur_slot: u64,
    pub bought_in_slot: u64,
    pub buy_count: u64,
    pub last_counted_slot: u64,
    pub wins: u64,
    pub winners: [PotWin; POT_WINNERS],
}
