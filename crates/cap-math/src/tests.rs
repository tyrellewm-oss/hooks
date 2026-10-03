extern crate std;
use super::*;
use proptest::prelude::*;
use std::vec::Vec;

fn cfg(steps: &[(u64, u16)], end: u64) -> CapConfig {
    let v: Vec<Step> = steps.iter().map(|&(o, b)| Step { slot_offset: o, max_bps: b }).collect();
    CapConfig::new(1_000, 1_000_000_000, &v, end).unwrap()
}

#[test]
fn table_cap_at() {
    let c = cfg(&[(0, 100), (150, 200)], 1500);
    assert_eq!(validate(&c, RELEASE_LIMITS), Ok(()));
    assert_eq!(cap_at(&c, 0), Some(10_000_000)); // before start -> first step
    assert_eq!(cap_at(&c, 1_000), Some(10_000_000));
    assert_eq!(cap_at(&c, 1_149), Some(10_000_000));
    assert_eq!(cap_at(&c, 1_150), Some(20_000_000));
    assert_eq!(cap_at(&c, 2_499), Some(20_000_000));
    assert_eq!(cap_at(&c, 2_500), None);
    assert_eq!(cap_at(&c, u64::MAX), None);
    assert_eq!(next_change(&c, 1_000), Some((1_150, Some(200))));
    assert_eq!(next_change(&c, 1_200), Some((2_500, None)));
    assert_eq!(next_change(&c, 2_500), None);
}

#[test]
fn u64_edges() {
    let c = CapConfig::new(u64::MAX - 5, u64::MAX, &[Step { slot_offset: 0, max_bps: 10_000 }], u64::MAX).unwrap();
    assert_eq!(cap_at(&c, u64::MAX), Some(u64::MAX));
    assert_eq!(bps_to_amount(u64::MAX, 10_000), u64::MAX);
    assert_eq!(bps_to_amount(u64::MAX, 1), u64::MAX / 10_000);
}

#[test]
fn validation_rejects() {
    let lim = RELEASE_LIMITS;
    assert_eq!(validate(&cfg(&[(0, 200), (150, 100)], 1500), lim), Err(ScheduleError::Decreasing));
    assert_eq!(validate(&cfg(&[(5, 100)], 1500), lim), Err(ScheduleError::FirstOffsetNotZero));
    assert_eq!(validate(&cfg(&[(0, 5)], 1500), lim), Err(ScheduleError::OutOfRange));
    assert_eq!(validate(&cfg(&[(0, 10_001)], 1500), lim), Err(ScheduleError::OutOfRange));
    assert_eq!(validate(&cfg(&[(0, 100), (150, 200)], 150), lim), Err(ScheduleError::BadEnd));
    assert_eq!(validate(&cfg(&[(0, 100), (5, 200)], 1500), lim), Err(ScheduleError::BadOffsets)); // gap < 10
    assert_eq!(validate(&cfg(&[(0, 100), (0, 200)], 1500), lim), Err(ScheduleError::BadOffsets));
    assert_eq!(validate(&cfg(&[(0, 100)], 20), lim), Err(ScheduleError::BadEnd)); // ramp < 150 in release
    assert_eq!(validate(&cfg(&[(0, 100)], 20), TEST_SLOTS_LIMITS), Ok(()));
    // QA H-3: maximum ramp length, both profiles
    assert_eq!(validate(&cfg(&[(0, 100)], MAX_RAMP_SLOTS), lim), Ok(()));
    assert_eq!(validate(&cfg(&[(0, 100)], MAX_RAMP_SLOTS + 1), lim), Err(ScheduleError::BadEnd));
    assert_eq!(validate(&cfg(&[(0, 100)], u64::MAX), TEST_SLOTS_LIMITS), Err(ScheduleError::BadEnd));
    let mut z = cfg(&[(0, 100)], 1500);
    z.supply = 0;
    assert_eq!(validate(&z, lim), Err(ScheduleError::ZeroSupply));
    z.supply = 1;
    z.step_count = 0;
    assert_eq!(validate(&z, lim), Err(ScheduleError::BadLength));
    assert!(CapConfig::new(0, 1, &[Step::default(); 9], 10).is_err());
}

#[test]
fn lift_only() {
    let l0 = Lift::default();
    let l1 = apply_raise(&l0, 300).unwrap();
    assert!(apply_raise(&l1, 300).is_err()); // equal
    assert!(apply_raise(&l1, 200).is_err()); // lower
    let l2 = apply_lift(&l1).unwrap();
    assert!(apply_lift(&l2).is_err());
    assert!(apply_raise(&l2, 9_000).is_err());
    assert_eq!(apply_raise(&l0, 10_000).unwrap().lifted, true);
}

#[test]
fn decide_rule() {
    assert_eq!(decide(true, Some(0), u64::MAX), Decision::Allow);
    assert_eq!(decide(false, None, u64::MAX), Decision::Allow);
    assert_eq!(decide(false, Some(10), 10), Decision::Allow);
    assert_eq!(decide(false, Some(10), 11), Decision::Reject { cap: 10 });
}

fn arb_cfg(limits: Limits) -> impl Strategy<Value = CapConfig> {
    (1usize..=MAX_STEPS, any::<u64>(), 1u64..=u64::MAX, proptest::collection::vec((limits.min_step_slots.max(1)..5_000u64, 0u16..2_000), MAX_STEPS), FLOOR_BPS..=2_000u16, 0u64..5_000)
        .prop_map(move |(n, launch, supply, deltas, start_bps, tail)| {
            let mut steps = Vec::new();
            let (mut off, mut bps) = (0u64, start_bps);
            for i in 0..n {
                if i > 0 {
                    off += deltas[i].0;
                    bps = (bps as u32 + deltas[i].1 as u32).min(BPS_DENOM as u32) as u16;
                }
                steps.push(Step { slot_offset: off, max_bps: bps });
            }
            let end = (off + limits.min_step_slots.max(1) + tail).max(limits.min_ramp_slots);
            CapConfig::new(launch % (u64::MAX / 2), supply, &steps, end).unwrap()
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: std::env::var("PROPTEST_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000), ..ProptestConfig::default() })]

    // AC-3 / P-MONO: cap never decreases; None is final; no panic.
    #[test]
    fn prop_monotonic(c in arb_cfg(RELEASE_LIMITS), s1 in any::<u64>(), d in any::<u64>()) {
        prop_assert_eq!(validate(&c, RELEASE_LIMITS), Ok(()));
        let s2 = s1.saturating_add(d);
        match (cap_at(&c, s1), cap_at(&c, s2)) {
            (Some(a), Some(b)) => prop_assert!(b >= a),
            (None, Some(_)) => prop_assert!(false, "None followed by Some"),
            _ => {}
        }
    }

    // AC-6 / AC-7 / P-EXIT: exempt destinations always allowed, whatever the cap / balance / lift.
    #[test]
    fn prop_exempt_always_allowed(c in arb_cfg(RELEASE_LIMITS), slot in any::<u64>(), bal in any::<u64>(), lifted in any::<bool>(), floor in 0u16..=10_000, g in any::<bool>()) {
        let lift = Lift { lifted, raised_floor_bps: floor };
        prop_assert_eq!(decide(true, effective_cap(&c, &lift, g, slot), bal), Decision::Allow);
    }

    // P-CAP: only the cap rejects, and exactly when post-balance > cap.
    #[test]
    fn prop_only_cap_rejects(c in arb_cfg(RELEASE_LIMITS), slot in any::<u64>(), bal in any::<u64>()) {
        let cap = cap_at(&c, slot);
        match decide(false, cap, bal) {
            Decision::Allow => prop_assert!(cap.map_or(true, |x| bal <= x)),
            Decision::Reject { cap: x } => { prop_assert_eq!(Some(x), cap); prop_assert!(bal > x) }
        }
    }

    // AC-11 / P-LIFT: no sequence of switch calls ever lowers the effective cap or re-enables it.
    #[test]
    fn prop_lift_never_tightens(c in arb_cfg(RELEASE_LIMITS), slot in any::<u64>(), ops in proptest::collection::vec((any::<bool>(), 0u16..=10_000), 0..12)) {
        let mut l = Lift::default();
        let mut prev = effective_cap(&c, &l, false, slot);
        for (is_lift, v) in ops {
            let r = if is_lift { apply_lift(&l) } else { apply_raise(&l, v) };
            if let Ok(n) = r { l = n; }
            let now = effective_cap(&c, &l, false, slot);
            match (prev, now) {
                (Some(a), Some(b)) => prop_assert!(b >= a),
                (None, Some(_)) => prop_assert!(false, "re-enabled"),
                _ => {}
            }
            prev = now;
        }
    }

    // AC-4: random raw schedules either validate (and then are monotonic) or are rejected.
    #[test]
    fn prop_validate_implies_sane(launch in any::<u64>(), supply in any::<u64>(), raw in proptest::collection::vec((any::<u64>(), any::<u16>()), 1..=MAX_STEPS), end in any::<u64>()) {
        let steps: Vec<Step> = raw.iter().map(|&(o, b)| Step { slot_offset: o, max_bps: b }).collect();
        let c = CapConfig::new(launch, supply, &steps, end).unwrap();
        if validate(&c, TEST_SLOTS_LIMITS).is_ok() {
            for w in c.active_steps().windows(2) { prop_assert!(w[1].max_bps >= w[0].max_bps && w[1].slot_offset > w[0].slot_offset); }
            prop_assert!(c.active_steps().iter().all(|s| s.max_bps >= FLOOR_BPS && s.max_bps <= BPS_DENOM));
        }
        let _ = cap_at(&c, end); // never panics
    }
}
