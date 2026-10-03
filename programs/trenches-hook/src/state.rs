use anchor_lang::prelude::*;
use crate::constants::MAX_EXEMPT;

#[account]
#[derive(InitSpace)]
pub struct Global {
    /// Lift-switch authority (devnet: throwaway test key; mainnet plan: 2-of-3 human Squads).
    pub authority: Pubkey,
    /// Global allow-all. One-way: false -> true only.
    pub lifted: bool,
    pub bump: u8,
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
