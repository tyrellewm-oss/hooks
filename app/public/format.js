// Pure formatting helpers for the page (no DOM), unit-tested in tests/format.test.ts.
export const SLOT_SECONDS_APPROX = 0.4; // Solana target slot time; real slots vary, so every duration is labelled approx.

/** "~30 min" style duration for a slot count (approx., at ~0.4 s/slot). */
export function approxDuration(slots) {
  const s = Number(slots) * SLOT_SECONDS_APPROX;
  if (s < 90) return `~${Math.round(s)} s`;
  if (s < 3600) return `~${Math.round(s / 60)} min`;
  const h = s / 3600; return `~${Number.isInteger(Math.round(h * 10) / 10) ? Math.round(h) : (Math.round(h * 10) / 10)} h`;
}
/** Value for the {CAP_RAMP} placeholder: when the cap ends by schedule (uncapped_after, slots after launch). */
export function capRampText(uncappedAfter) {
  if (uncappedAfter === undefined || uncappedAfter === null || uncappedAfter === '') return 'n/a';
  const n = BigInt(uncappedAfter);
  return `${approxDuration(n)} (approx., ${n.toLocaleString("en-US")} slots at ~0.4 s/slot)`;
}

// ---- fee display (copy v0d placeholders), derived only from the launch config ---------------------------
/** Meteora DBC MigrationFeeOption -> DAMM v2 pool fee in bps. Order verified against the SDK enum in
 *  tests/copy_v0d.test.ts (FixedBps25=0, FixedBps30=1, FixedBps100=2, FixedBps200=3, FixedBps400=4, FixedBps600=5, Customizable=6). */
export const MIGRATION_FEE_OPTION_BPS = Object.freeze([25, 30, 100, 200, 400, 600]);
export const MIGRATION_FEE_CUSTOMIZABLE = 6;
export const bpsPct = (bps) => `${Number(bps) / 100}%`;
/** Pool fee bps for a MigrationFeeOption (Customizable uses the config's poolFeeBps). */
export function poolFeeBps(migrationFeeOption, customPoolFeeBps) {
  const o = Number(migrationFeeOption);
  if (o === MIGRATION_FEE_CUSTOMIZABLE) { if (customPoolFeeBps === undefined || customPoolFeeBps === null) throw new Error('Customizable migration fee needs poolFeeBps'); return Number(customPoolFeeBps); }
  if (!(o >= 0 && o < MIGRATION_FEE_OPTION_BPS.length)) throw new Error(`unknown MigrationFeeOption ${migrationFeeOption}`);
  return MIGRATION_FEE_OPTION_BPS[o];
}
/** Launch fee config -> {SNIPER_FEE_START, SNIPER_FEE_END, SNIPER_FEE_DURATION, POOL_FEE, FEE_SPLIT}.
 *  cfg = { startBps, endBps, durationSlots, migrationFeeOption, creatorTradingFeePercentage, poolFeeBps? }
 *  (the values sdk/launch.ts used to build the DBC config). Missing config -> 'n/a' (never a made-up number). */
export function feeVars(cfg) {
  if (!cfg) return { SNIPER_FEE_START: 'n/a', SNIPER_FEE_END: 'n/a', SNIPER_FEE_DURATION: 'n/a', POOL_FEE: 'n/a', FEE_SPLIT: 'n/a' };
  const has = (k) => cfg[k] !== undefined && cfg[k] !== null;
  const creator = has('creatorTradingFeePercentage') ? Number(cfg.creatorTradingFeePercentage) : null;
  return {
    SNIPER_FEE_START: has('startBps') ? bpsPct(cfg.startBps) : 'n/a',
    SNIPER_FEE_END: has('endBps') ? bpsPct(cfg.endBps) : 'n/a',
    SNIPER_FEE_DURATION: has('durationSlots') ? `${approxDuration(cfg.durationSlots)} (approx., ${BigInt(cfg.durationSlots).toLocaleString('en-US')} slots)` : 'n/a',
    POOL_FEE: has('migrationFeeOption') ? bpsPct(poolFeeBps(cfg.migrationFeeOption, cfg.poolFeeBps)) : 'n/a',
    FEE_SPLIT: creator === null ? 'n/a' : `the studio test key (partner fee claimer, ${100 - creator}%; creator share ${creator}%)`,
  };
}

/** Supply split for a launch: percentageSupplyOnMigration % goes to the DAMM v2 pool at graduation, the rest is
 *  sold on the bonding curve (no leftover, no vesting in our config). Values are the launch settings, not live data. */
export function supplySold(percentageSupplyOnMigration) {
  const m = Number(percentageSupplyOnMigration);
  if (!Number.isInteger(m) || m < 1 || m > 99) throw new Error(`bad percentageSupplyOnMigration ${percentageSupplyOnMigration}`);
  return { soldPct: 100 - m, migrationPct: m };
}
export function supplySoldText(percentageSupplyOnMigration) {
  if (percentageSupplyOnMigration === undefined || percentageSupplyOnMigration === null) return 'n/a';
  const { soldPct, migrationPct } = supplySold(percentageSupplyOnMigration);
  return `${soldPct}% of supply sold on the curve; ${migrationPct}% goes to the DAMM v2 pool at graduation (launch setting)`;
}
