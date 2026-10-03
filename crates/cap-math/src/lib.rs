//! Pure cap-schedule math for the `trenches-hook` rising per-token-account cap.
//!
//! `no_std`, no dependencies, no Solana types. The on-chain program and the
//! off-chain tooling (tests, page via the TS mirror in `app/src/capMath.ts`)
//! use the same rules, so the same inputs give the same output everywhere.
//!
//! Model
//! - A schedule is a list of steps `(slot_offset, max_bps)`, relative to the
//!   mint's `launch_slot`. `max_bps` is the per-token-account cap in basis points of the
//!   reference supply (100 bps = 1%).
//! - From `uncapped_after` slots after launch on there is **no cap** (`None`).
//! - The cap only ever rises: steps must be non-decreasing and `None` is final.
//! - Before `launch_slot` (should not happen on chain) the first step applies.
#![no_std]
#![forbid(unsafe_code)]

/// Maximum number of steps in a schedule.
pub const MAX_STEPS: usize = 8;
/// 100% in basis points.
pub const BPS_DENOM: u16 = 10_000;
/// Lowest allowed cap: 0.1% of supply (AC-4 floor).
pub const FLOOR_BPS: u16 = 10;
/// Longest allowed ramp (QA H-3): `uncapped_after` <= 6,480,000 slots
/// (~30 days at ~0.4 s/slot, estimate). Applies to every build profile.
pub const MAX_RAMP_SLOTS: u64 = 6_480_000;

/// Minimum slot gap between steps / before "no cap", per build profile.
/// Release (devnet) builds: >= 10 slots per step and a total ramp >= 150 slots (~1 min).
/// `test-slots` builds (LOCAL only): 1 slot per step, ramp >= 2 slots, so the cap
/// rises within seconds on a local validator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub min_step_slots: u64,
    pub min_ramp_slots: u64,
}
pub const RELEASE_LIMITS: Limits = Limits { min_step_slots: 10, min_ramp_slots: 150 };
pub const TEST_SLOTS_LIMITS: Limits = Limits { min_step_slots: 1, min_ramp_slots: 2 };

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Step {
    pub slot_offset: u64,
    pub max_bps: u16,
}

/// Fixed-size, copyable schedule (mirrors the on-chain config fields).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapConfig {
    pub launch_slot: u64,
    /// Reference total supply in base units (caps are computed from this).
    pub supply: u64,
    pub steps: [Step; MAX_STEPS],
    pub step_count: u8,
    /// Slots after launch from which there is no cap.
    pub uncapped_after: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleError {
    /// 0 steps or more than MAX_STEPS.
    BadLength,
    /// First step must start at offset 0.
    FirstOffsetNotZero,
    /// Offsets not strictly increasing, or gap below the build's minimum.
    BadOffsets,
    /// A step's cap is lower than the previous step's (cap must only rise).
    Decreasing,
    /// Cap below FLOOR_BPS or above 100%.
    OutOfRange,
    /// `uncapped_after` not after the last step, or ramp shorter than allowed.
    BadEnd,
    /// Reference supply is zero.
    ZeroSupply,
}

impl CapConfig {
    pub fn new(launch_slot: u64, supply: u64, steps: &[Step], uncapped_after: u64) -> Result<Self, ScheduleError> {
        if steps.is_empty() || steps.len() > MAX_STEPS {
            return Err(ScheduleError::BadLength);
        }
        let mut arr = [Step::default(); MAX_STEPS];
        arr[..steps.len()].copy_from_slice(steps);
        Ok(Self { launch_slot, supply, steps: arr, step_count: steps.len() as u8, uncapped_after })
    }

    pub fn active_steps(&self) -> &[Step] {
        let n = (self.step_count as usize).min(MAX_STEPS);
        &self.steps[..n]
    }
}

/// Validate a schedule (AC-4). Rejects: empty/too long, not starting at 0,
/// decreasing, out of [FLOOR_BPS, 100%], end not after last step, too short.
pub fn validate(cfg: &CapConfig, limits: Limits) -> Result<(), ScheduleError> {
    if cfg.supply == 0 {
        return Err(ScheduleError::ZeroSupply);
    }
    let n = cfg.step_count as usize;
    if n == 0 || n > MAX_STEPS {
        return Err(ScheduleError::BadLength);
    }
    let steps = &cfg.steps[..n];
    if steps[0].slot_offset != 0 {
        return Err(ScheduleError::FirstOffsetNotZero);
    }
    let mut prev: Option<Step> = None;
    for s in steps {
        if s.max_bps < FLOOR_BPS || s.max_bps > BPS_DENOM {
            return Err(ScheduleError::OutOfRange);
        }
        if let Some(p) = prev {
            match s.slot_offset.checked_sub(p.slot_offset) {
                Some(gap) if gap >= limits.min_step_slots && gap > 0 => {}
                _ => return Err(ScheduleError::BadOffsets),
            }
            if s.max_bps < p.max_bps {
                return Err(ScheduleError::Decreasing);
            }
        }
        prev = Some(*s);
    }
    let last = steps[n - 1].slot_offset;
    match cfg.uncapped_after.checked_sub(last) {
        Some(gap) if gap >= limits.min_step_slots && gap > 0 => {}
        _ => return Err(ScheduleError::BadEnd),
    }
    if cfg.uncapped_after < limits.min_ramp_slots || cfg.uncapped_after > MAX_RAMP_SLOTS {
        return Err(ScheduleError::BadEnd);
    }
    Ok(())
}

/// Cap in bps at `slot`, or `None` = no cap. Never panics, for any input.
pub fn cap_bps_at(cfg: &CapConfig, slot: u64) -> Option<u16> {
    let steps = cfg.active_steps();
    if steps.is_empty() {
        return None; // unreachable for validated configs
    }
    let elapsed = slot.saturating_sub(cfg.launch_slot);
    if elapsed >= cfg.uncapped_after {
        return None;
    }
    let mut bps = steps[0].max_bps;
    for s in steps {
        if s.slot_offset <= elapsed {
            bps = s.max_bps;
        } else {
            break;
        }
    }
    Some(bps)
}

/// bps of supply -> base units, floor division, no overflow (u128).
pub fn bps_to_amount(supply: u64, bps: u16) -> u64 {
    let v = (supply as u128) * (bps.min(BPS_DENOM) as u128) / (BPS_DENOM as u128);
    v as u64 // <= supply, always fits
}

/// AC-2: the schedule's cap (base units) at `slot`; `None` = no cap.
pub fn cap_at(cfg: &CapConfig, slot: u64) -> Option<u64> {
    cap_bps_at(cfg, slot).map(|b| bps_to_amount(cfg.supply, b))
}

/// The next point at which the cap changes after `slot`:
/// `Some((slot_at, Some(bps)))` for a higher step, `Some((slot_at, None))` for
/// "no cap from then", `None` if already uncapped.
pub fn next_change(cfg: &CapConfig, slot: u64) -> Option<(u64, Option<u16>)> {
    let elapsed = slot.saturating_sub(cfg.launch_slot);
    if elapsed >= cfg.uncapped_after {
        return None;
    }
    let cur = cap_bps_at(cfg, slot);
    for s in cfg.active_steps() {
        if s.slot_offset > elapsed && Some(s.max_bps) != cur {
            return Some((cfg.launch_slot.saturating_add(s.slot_offset), Some(s.max_bps)));
        }
    }
    Some((cfg.launch_slot.saturating_add(cfg.uncapped_after), None))
}

/// Mutable lift state (the ONLY mutable rule state; lift-only).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Lift {
    /// Per-mint cap removed (one-way).
    pub lifted: bool,
    /// Per-mint raised minimum cap in bps (0 = none). Only ever increases.
    pub raised_floor_bps: u16,
}

/// Effective cap after the lift-only switch: `None` = no cap.
pub fn effective_cap(cfg: &CapConfig, lift: &Lift, global_lifted: bool, slot: u64) -> Option<u64> {
    if global_lifted || lift.lifted {
        return None;
    }
    let bps = cap_bps_at(cfg, slot)?;
    let bps = if lift.raised_floor_bps > bps { lift.raised_floor_bps } else { bps };
    if bps >= BPS_DENOM {
        return None;
    }
    Some(bps_to_amount(cfg.supply, bps))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiftError {
    /// Would lower, re-enable, or not change anything.
    NotALift,
}

/// Lift-only transition: raise the per-mint floor. Must strictly increase and
/// can't run once lifted. Returns the new state.
pub fn apply_raise(lift: &Lift, new_floor_bps: u16) -> Result<Lift, LiftError> {
    if lift.lifted || new_floor_bps <= lift.raised_floor_bps || new_floor_bps > BPS_DENOM {
        return Err(LiftError::NotALift);
    }
    if new_floor_bps == BPS_DENOM {
        return Ok(Lift { lifted: true, raised_floor_bps: new_floor_bps });
    }
    Ok(Lift { lifted: false, raised_floor_bps: new_floor_bps })
}

/// Lift-only transition: remove the per-mint cap (one-way).
pub fn apply_lift(lift: &Lift) -> Result<Lift, LiftError> {
    if lift.lifted {
        return Err(LiftError::NotALift);
    }
    Ok(Lift { lifted: true, raised_floor_bps: lift.raised_floor_bps })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Destination's post-transfer balance is over `cap`.
    Reject { cap: u64 },
}

/// The ONE rule. Only the destination matters; the source is never checked.
/// Exempt destinations (pool vault / migration path) always pass (exit guarantee).
pub fn decide(dest_exempt: bool, cap: Option<u64>, dest_post_balance: u64) -> Decision {
    if dest_exempt {
        return Decision::Allow;
    }
    match cap {
        None => Decision::Allow,
        Some(c) if dest_post_balance <= c => Decision::Allow,
        Some(c) => Decision::Reject { cap: c },
    }
}

#[cfg(test)]
mod tests;
