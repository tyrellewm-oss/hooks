// LOCAL cap-math simulation report (not on-chain). Writes docs/replay_results_v0.md and refreshes the
// committed fixture snapshot tests/fixtures/replay_v0.min.json from Research's full fixtures.
//   node --import tsx scripts/replay_report.ts [--fixtures ../replay_fixtures_v0]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { FIXTURE_NAMES, SCHEDULES, parseCsv, fromSnapshot, toSnapshot, summarize, replay, type Fixture } from '../sdk/replay.js';

const argv = process.argv.slice(2); const i = argv.indexOf('--fixtures');
const dir = i >= 0 ? argv[i + 1] : process.env.REPLAY_FIXTURES_DIR ?? '../replay_fixtures_v0';
const SNAP = 'tests/fixtures/replay_v0.min.json';
let fixtures: Fixture[];
if (existsSync(`${dir}/A.csv`)) { // anonymised copies of Research's CSVs: A.csv … E.csv (never commit real names/addresses)
  fixtures = FIXTURE_NAMES.map(n => parseCsv(n, readFileSync(`${dir}/${n}.csv`, 'utf8')));
  writeFileSync(SNAP, JSON.stringify({ source: 'Research replay_fixtures_v0 (CSV), anonymised: fixtures A-E, ids replaced by per-fixture labels; see docs/replay_results_v0.md', fixtures: fixtures.map(toSnapshot) }, null, 0) + '\n');
} else fixtures = JSON.parse(readFileSync(SNAP, 'utf8')).fixtures.map(fromSnapshot);

const f2 = (x: number | null) => (x === null ? 'no cap' : `${x.toFixed(2)}%`);
let md = `# Replay results v0: Research sniper fixtures through the cap math (LOCAL simulation)

**LOCAL / cap-math simulation, not on-chain.** Generated ${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' })} ICT by \`scripts/replay_report.ts\` and checked by \`tests/replay.test.ts\`. Inputs: Research's \`replay_fixtures_v0\` (5 mainnet bonding-curve launches, read-only data, **anonymised as fixtures A–E**; owners, token accounts and tx ids are replaced by per-fixture labels) and the schedules in \`sdk/schedules.ts\` (proposals from \`research/cap_schedule_options.md\`; none is production).

How it works: every fixture row with a token-balance change is replayed in (slot, block index) order through \`sdk/capMath.ts\`, the same math the program uses, with balance tracked **per token account**. Rule mirrored from \`programs/trenches-hook\`: the receiving token account's post-balance must be ≤ cap(slot offset). Exempt receivers are only accounts owned by the DBC or DAMM v2 pool authority PDAs. The source is never checked. **A tx with any over-cap transfer reverts as a whole**, because the hook rejects the transfer and the tx fails.

## Crew results per fixture × schedule
Key:
- *orig* = % of supply the crew got in the fixture.
- *as-is* = the crew's holdings if the same txs were replayed unchanged.
- *resized* = best case on the curve with the **same token accounts** (each buy shrunk to fit its account's cap).
- *post-grad* = crew buys after graduation, which have no cap.
- *accounts needed* = token accounts needed at the slot-0 cap to reach the crew's original curve %.

| Fixture | Crew | Schedule | Cap at slot +0 | Crew orig | Curve part | Blocked (as-is) | Crew as-is | Resized (same accounts) | Post-grad, uncapped | Accounts needed |
|---|---|---|---|---|---|---|---|---|---|---|
`;
for (const f of fixtures) for (const s of SCHEDULES) {
  const x = summarize(f, s);
  md += `| ${f.name} | ${f.crew.join('+')} | ${s.name} | ${f2(x.capAtBuyBps === null ? null : x.capAtBuyBps / 100)} | ${f2(x.originalCrewPct)} | ${f2(x.originalCurvePct)} | ${f2(x.blockedCurvePct)} | ${f2(x.replayAsIsPct)} | ${f2(x.resizedCurvePct)} | ${f2(x.postGraduationPct)} | ${x.accountsNeeded ?? 'n/a'} |\n`;
}
md += `\n## Per-sniper detail (Balanced, the devnet default "approved by King (Oct 4, 2026)")\n| Fixture | Member | Phase | Bought (orig) | Received as-is | Max in that account | Blocked | Accounts needed for that buy |\n|---|---|---|---|---|---|---|---|\n`;
const bal = SCHEDULES.find(s => s.name === 'Balanced')!;
for (const f of fixtures) for (const m of summarize(f, bal).perMember) md += `| ${f.name} | ${m.label} | ${m.phase} | ${f2(m.requestedPct)} | ${f2(m.asIsPct)} | ${m.maxPct === null ? 'no cap' : f2(m.maxPct)} | ${f2(m.blockedPct)} | ${m.accountsNeeded ?? 'n/a (uncapped)'} |\n`;
const d3 = replay(fixtures.find(f => f.name === 'C')!, bal).filter(r => ['B1', 'B2', 'B3', 'B4'].includes(r.row.label));
md += `
## Specific checks
- **Same tx, 2 owners, 2 token accounts (fixture C, block idx 947 and 948):** the cap is checked **per receiving token account**, once per transfer, not once per tx. Under Balanced: ${d3.map(r => `${r.row.label} ${r.outcome}${r.txReverted ? ' (tx reverted)' : ''}`).join(', ')}. Because a rejected transfer fails the tx, the other buy in the same tx is rolled back too.
- **1 owner, 2 token accounts (synthetic, AC-6):** the owner holds **2× the cap**, because the cap is per token account by design (see \`tests/replay.test.ts\`). A third buy into either account above its cap is blocked.
- **Post-graduation buys show as uncapped. This is a design limit, stated plainly.** Once the curve completes, DBC revokes the transfer hook, so the rule stops. In fixtures C, D and E, one wallet bought ~20% from the new pool right after migration. No schedule stops that, because \`uncapped_after\` doesn't matter once the hook is gone. In this replay we use the fixture's own migration point. With a cap in place the curve probably would **not** have completed at that point (the crew's curve buys revert), so the post-graduation rows show what the design allows, not what would have happened.

## Assumptions and caveats
1. Simulation of the cap math only. It doesn't run the program, DBC, fees or prices. It uses **% of supply (tokens)**, not SOL, as the fixture notes recommend. The DBC curve and fee schedule would change prices, and the anti-sniper fee isn't modelled here.
2. Launch slot = the fixture's creation slot (our hook config is created in the pool-creation tx), so slot offset = fixture \`slot_offset\`. All fixture curve buys are at +0, so only the first step of each schedule is ever reached. The later steps and \`uncapped_after\` aren't exercised by these fixtures (Research notes there's no +1..+3 curve sniping in v0).
3. **Pool-authority info:** fixture rows record owners and token accounts but not DBC/DAMM pool vaults. They're rows from another launchpad's curve and AMM, and none of the owners is the DBC or DAMM v2 pool authority, so **no row is exempt**. Sells (negative token deltas) go into a pool vault, which is an exempt receiver, so they're never blocked.
4. D and E: the "DEV" curve buy is inside the token's create tx. In our flow the hook config is initialised in the pool-creation tx, and any later buy in that tx would be capped the same way. We don't do a creator first-buy.
5. Crew membership comes from Research's linking evidence: co-signer and funder for A and B, creator funding for C. **In fixtures D and E, the link between the crew wallets is inferred, not proven** (consecutive block indexes only).
6. "Accounts needed" = ceil(orig curve % / slot-0 cap). Each account can be a fresh wallet or another token account of the same owner, and the cap can't tell them apart. Splitting across accounts defeats any per-account cap. With Balanced, the 4-wallet crew snipe becomes ~78–80 accounts.
7. Fixture data is read-only research data, used as test input only. Token names and all mainnet addresses (mints, wallets, token accounts, tx ids) are removed: fixtures are labelled A–E and ids are per-fixture labels.
`;
writeFileSync('docs/replay_results_v0.md', md);
console.log(md);
