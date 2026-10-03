// Research (offline): build + validate each fee/curve/supply option with the repo's own code paths.
// No network, no keys. Run: node --import tsx research/validate_fee_options.ts
import { readFileSync } from 'node:fs';
import { buildCurve, validateConfigParameters, MigrationFeeOption, BaseFeeMode, CollectFeeMode, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType, ActivationType } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Launchpad, launchFeeConfig, DEFAULT_LAUNCH_FEES } from '../sdk/launch.js';
import { BALANCED } from '../sdk/schedules.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { HookClient } from '../sdk/hook.js';
const HOOK = new HookClient().programId; const DUMMY = Keypair.generate().publicKey; // in-memory only, never saved
const full = (cfg: any) => ({ config: DUMMY, feeClaimer: DUMMY, leftoverReceiver: DUMMY, payer: DUMMY, quoteMint: NATIVE_MINT, transferHookProgram: HOOK, ...cfg });
import { pageVars, explainVars, fill } from '../app/public/pagevars.js';

const M: any = MigrationFeeOption;
type Opt = { name: string; o: any; pct: number };
const OPTIONS: Opt[] = [
  { name: 'DEFAULTS (reference)', pct: 20, o: { totalSupply: 1_000_000_000, migrationQuoteThresholdSol: 1 } },
  { name: 'Conservative', pct: 20, o: { feeStartBps: 9900, feeEndBps: 100, feePeriods: 30, feeDurationSlots: 450, creatorTradingFeePercentage: 0, migrationFeeOption: M.FixedBps100, migrationQuoteThresholdSol: 1, totalSupply: 1_000_000_000 } },
  { name: 'Balanced', pct: 20, o: { feeStartBps: 9000, feeEndBps: 100, feePeriods: 10, feeDurationSlots: 150, creatorTradingFeePercentage: 0, migrationFeeOption: M.FixedBps25, migrationQuoteThresholdSol: 3, totalSupply: 1_000_000_000 } },
  { name: 'Aggressive', pct: 30, o: { feeStartBps: 2500, feeEndBps: 100, feePeriods: 5, feeDurationSlots: 150, creatorTradingFeePercentage: 50, migrationFeeOption: M.FixedBps25, migrationQuoteThresholdSol: 10, totalSupply: 1_000_000_000 } },
];

// Same object as sdk/launch.ts configParams() (lines 80-92), with percentageSupplyOnMigration as a variable
// (Engineer is adding it as an option, default 20). For pct=20 we also call the real configParams and compare.
function build(o: any, pct: number) {
  const f = launchFeeConfig(o);
  return buildCurve({
    token: { tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9, tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: o.totalSupply ?? 1_000_000_000, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: f.startBps, endingFeeBps: f.endBps, numberOfPeriod: f.periods, totalDuration: f.durationSlots } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: f.creatorTradingFeePercentage, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: f.migrationFeeOption, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Slot, percentageSupplyOnMigration: pct, migrationQuoteThreshold: o.migrationQuoteThresholdSol ?? 1,
  } as any);
}

const COPY = JSON.parse(readFileSync('research/page_content.json', 'utf8'));
const SKIP = new Set(['version', 'placeholders', 'error_code_notes']);
const strings = (v: any): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
const rendered = Object.entries(COPY).filter(([k]) => !SKIP.has(k)).flatMap(([, v]) => strings(v));
const META = { cluster: 'DEVNET', liftAuthority: 'AuthTestKey1111111111111111111111111111111', programId: 'FieaXjJUpe5JiAbEzCddWGXHCYWvVPi7UwaYTVsWQTz', commit: 'abc1234' };
const view = (fc: any) => ({ status: { slot: '1000', steps: BALANCED.steps.map((s: any) => ({ slotOffset: s.slotOffset.toString(), maxBps: s.maxBps })), uncappedAfter: BALANCED.uncappedAfter.toString(), nextChange: { slot: '1150', bps: 200 } },
  launch: { symbol: 'TEST', mint: 'MintTest11111111111111111111111111111111111' }, balances: { alice: '5000000' }, switchHistory: [], feeConfig: fc });
const TRADE = { capHit: { balance: '12000000', cap: '10000000' }, hookError: 'WalletCapExceeded', link: 'https://explorer.solana.com/tx/x?cluster=devnet' };

let fails = 0;
console.log('DEFAULT_LAUNCH_FEES =', JSON.stringify(DEFAULT_LAUNCH_FEES), '| BALANCED uncappedAfter =', BALANCED.uncappedAfter.toString());
for (const { name, o, pct } of OPTIONS) {
  const line: string[] = [`== ${name}`];
  try {
    const cfg: any = build(o, pct);
    if (pct === 20) {
      const real: any = (Launchpad.prototype as any).configParams.call({}, o);
      const same = JSON.stringify(real) === JSON.stringify(cfg);
      line.push(`  matches real Launchpad.configParams: ${same ? 'YES' : 'NO'}`); if (!same) fails++;
    }
    validateConfigParameters(full(cfg), { isTransferHook: true, transferHookProgram: HOOK });
    const bf = cfg.poolFees.baseFee;
    const sold = 100 - pct;
    line.push(`  buildCurve + validateConfigParameters(isTransferHook): OK`);
    line.push(`  cliffFeeNumerator=${bf.cliffFeeNumerator.toString()} (=${Number(bf.cliffFeeNumerator.toString()) / 1e7}%), periods=${bf.firstFactor}, periodFrequency=${bf.secondFactor.toString()} slots, reductionFactor=${bf.thirdFactor.toString()}`);
    line.push(`  migrationQuoteThreshold=${cfg.migrationQuoteThreshold.toString()} lamports, creatorTradingFeePercentage=${cfg.creatorTradingFeePercentage}, migrationFeeOption=${cfg.migrationFeeOption}, supply on curve ~${sold}% (percentageSupplyOnMigration=${pct})`);
    // page render
    const fc = launchFeeConfig(o); const v = view(fc);
    const vars = { ...pageVars(META, v), ...explainVars(TRADE, v, 'alice') };
    const out = rendered.map((s) => fill(s, vars)).join('\n');
    const raw = out.match(/\{[A-Za-z_]+\}/g);
    line.push(`  page render: ${raw ? 'RAW PLACEHOLDERS ' + raw.join(',') : 'no raw {...}'}; SNIPER_FEE_START=${vars.SNIPER_FEE_START}, SNIPER_FEE_END=${vars.SNIPER_FEE_END}, SNIPER_FEE_DURATION=${vars.SNIPER_FEE_DURATION}, POOL_FEE=${vars.POOL_FEE}, FEE_SPLIT=${vars.FEE_SPLIT}`);
    if (raw) fails++;
  } catch (e: any) { line.push(`  FAIL: ${e.message}`); fails++; }
  console.log(line.join('\n'));
}
// negative checks: SDK limits
for (const [label, o] of [['start 9901 bps', { feeStartBps: 9901 }], ['end 24 bps', { feeEndBps: 24 }], ['end > start', { feeStartBps: 100, feeEndBps: 200 }], ['creator 101%', { creatorTradingFeePercentage: 101 }]] as [string, any][]) {
  try { validateConfigParameters(full(build({ ...o, migrationQuoteThresholdSol: 1 }, 20)), { isTransferHook: true, transferHookProgram: HOOK }); console.log(`neg ${label}: accepted (!)`); }
  catch (e: any) { console.log(`neg ${label}: rejected -> ${e.message.slice(0, 90)}`); }
}
console.log(fails ? `RESULT: ${fails} failure(s)` : 'RESULT: all options build, validate and render');
process.exit(fails ? 1 : 0);
