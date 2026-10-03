// LOCAL cap-math simulation (NOT on-chain): replay Research's anonymised sniper fixtures (A-E) through the same
// cap math the program uses (sdk/capMath.ts), tracking balance per TOKEN ACCOUNT like the hook does.
// Mirrors programs/trenches-hook transfer_hook: for each transfer, the RECEIVING token account's
// post-balance must be <= effectiveCap(slot), unless the receiving account's OWNER is the DBC pool
// authority or the DAMM v2 pool authority (no other exemptions since QA H-1). Source is never checked.
import { validate, effectiveCap, RELEASE_LIMITS, type CapConfig, type Step } from './capMath.js';
import { STRICT, BALANCED, LOOSE, LOCAL_DEMO } from './schedules.js';

export const SUPPLY = 1_000_000_000_000_000n; // 1e9 tokens, 6 dp (pump.fun and our DBC launches)
// Same pubkeys as sdk/hook.ts (derived there from the Meteora program ids); duplicated as strings so this module has no web3 deps.
export const EXEMPT_OWNERS = new Set(['FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC']);

export interface Row { slotOffset: number; blockIndex: number; label: string; owner: string; tokenAccount: string; kind: string; venue: string; tokensRaw: bigint; sig: string }
export interface Fixture { name: string; file: string; crew: string[]; rows: Row[] }
export interface Schedule { name: string; steps: Step[]; uncappedAfter: bigint }

export const SCHEDULES: Schedule[] = [STRICT, BALANCED, LOOSE, LOCAL_DEMO]; // proposals + current demo schedule (sdk/schedules.ts)

/** Crew = wallets Research linked in its fixture notes (co-signer/funding links; for D and E the link is inferred, not proven). */
export const CREWS: Record<string, string[]> = {
  A: ['S1', 'S2', 'S3', 'S4'],
  B: ['S1', 'S2', 'S3', 'S4'],
  C: ['B1', 'B2', 'B3', 'B4', 'DEV'],
  D: ['DEV', 'POOL_BUYER'],
  E: ['DEV', 'POOL_BUYER'],
};

export type Outcome = 'allowed' | 'blocked' | 'uncapped-post-graduation' | 'uncapped-schedule' | 'exempt' | 'sell';
export interface RowResult { row: Row; phase: 'curve' | 'post-graduation'; capBps: number | null; cap: bigint | null; outcome: Outcome; requested: bigint; received: bigint; maxThisAccount: bigint | null; txReverted: boolean }

/** Replay rows in (slot, block index) order. Each transfer is checked on its own (as the hook is called per
 *  transfer); a tx with ANY rejected transfer reverts as a whole, so its other transfers are rolled back too.
 *  Graduation: once the fixture's MIGRATION row has passed, DBC has revoked the hook -> no cap (design limit). */
export function replay(f: Fixture, s: Schedule): RowResult[] {
  const cfg: CapConfig = { launchSlot: 0n, supply: SUPPLY, steps: s.steps, uncappedAfter: s.uncappedAfter };
  if (validate(cfg, RELEASE_LIMITS)) throw new Error(`invalid schedule ${s.name}: ${validate(cfg, RELEASE_LIMITS)}`);
  const rows = [...f.rows].sort((a, b) => a.slotOffset - b.slotOffset || a.blockIndex - b.blockIndex);
  const bal = new Map<string, bigint>(); // token account -> balance
  let graduated = false;
  const out: RowResult[] = [];
  // group by tx (sig) to apply all-or-nothing
  for (let i = 0; i < rows.length;) {
    const sig = rows[i].sig; const group: Row[] = [];
    while (i < rows.length && rows[i].sig === sig) group.push(rows[i++]);
    const tmp = new Map(bal); const res: RowResult[] = []; let revert = false;
    for (const r of group) {
      if (r.kind.startsWith('migration')) { graduated = true; continue; }
      if (r.tokensRaw === 0n || !r.tokenAccount) continue;
      const phase = graduated ? 'post-graduation' : 'curve';
      const slot = BigInt(r.slotOffset);
      const capBps = (() => { const c = effectiveCap(cfg, { lifted: false, raisedFloorBps: 0 }, false, slot); return c === null ? null : Number((c * 10_000n) / SUPPLY); })();
      const cap = graduated ? null : effectiveCap(cfg, { lifted: false, raisedFloorBps: 0 }, false, slot);
      const prev = tmp.get(r.tokenAccount) ?? 0n;
      const requested = r.tokensRaw;
      let outcome: Outcome; let received = requested;
      if (requested < 0n) outcome = 'sell'; // tokens leave the account into a pool vault (exempt receiver); source never checked
      else if (EXEMPT_OWNERS.has(r.owner)) outcome = 'exempt';
      else if (graduated) outcome = 'uncapped-post-graduation';
      else if (cap === null) outcome = 'uncapped-schedule';
      else if (prev + requested <= cap) outcome = 'allowed';
      else { outcome = 'blocked'; received = 0n; revert = true; }
      if (received !== 0n) tmp.set(r.tokenAccount, prev + received);
      res.push({ row: r, phase, capBps: graduated ? null : capBps, cap, outcome, requested, received, maxThisAccount: cap === null ? null : (cap > prev ? cap - prev : 0n), txReverted: false });
    }
    if (revert) { for (const x of res) { x.txReverted = true; x.received = 0n; } }
    else for (const [k, v] of tmp) bal.set(k, v);
    out.push(...res);
  }
  return out;
}

export const pct = (raw: bigint) => Number((raw * 1_000_000n) / SUPPLY) / 10_000; // % of supply, 4 dp
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export interface CrewSummary {
  fixture: string; schedule: string; capAtBuyBps: number | null;
  originalCrewPct: number;         // what the crew got in the fixture (curve + post-graduation)
  originalCurvePct: number;        // crew's curve-phase buys only
  replayAsIsPct: number;           // crew holdings if the fixture txs were replayed unchanged (over-cap txs revert)
  resizedCurvePct: number;         // best case: each crew curve buy shrunk to fit its own account's cap
  postGraduationPct: number;       // crew buys after graduation (no cap: hook revoked)
  blockedCurvePct: number;         // curve-phase crew tokens rejected when replayed as-is
  accountsNeeded: number | null;   // token accounts needed at the slot-0 cap to reach originalCurvePct on the curve
  perMember: { label: string; requestedPct: number; asIsPct: number; maxPct: number | null; blockedPct: number; phase: string; accountsNeeded: number | null }[];
}
export function summarize(f: Fixture, s: Schedule): CrewSummary {
  const res = replay(f, s); const crew = new Set(f.crew);
  const mine = res.filter(r => crew.has(r.row.label) && r.requested > 0n);
  const curve = mine.filter(r => r.phase === 'curve'); const post = mine.filter(r => r.phase === 'post-graduation');
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const cap0 = curve[0]?.cap ?? effectiveCap({ launchSlot: 0n, supply: SUPPLY, steps: s.steps, uncappedAfter: s.uncappedAfter }, { lifted: false, raisedFloorBps: 0 }, false, 0n);
  const origCurve = sum(curve.map(r => r.requested));
  const resized = sum(curve.map(r => (r.maxThisAccount === null ? r.requested : r.requested < r.maxThisAccount ? r.requested : r.maxThisAccount)));
  return {
    fixture: f.name, schedule: s.name, capAtBuyBps: cap0 === null ? null : Number((cap0 * 10_000n) / SUPPLY),
    originalCrewPct: pct(sum(mine.map(r => r.requested))), originalCurvePct: pct(origCurve),
    replayAsIsPct: pct(sum(mine.map(r => r.received))), resizedCurvePct: pct(resized), postGraduationPct: pct(sum(post.map(r => r.requested))),
    blockedCurvePct: pct(sum(curve.map(r => r.requested - r.received))),
    accountsNeeded: cap0 === null || origCurve === 0n ? null : Number(ceilDiv(origCurve, cap0)),
    perMember: mine.map(r => ({ label: r.row.label, requestedPct: pct(r.requested), asIsPct: pct(r.received), maxPct: r.maxThisAccount === null ? null : pct(r.maxThisAccount < r.requested ? r.maxThisAccount : r.requested), blockedPct: pct(r.requested - r.received), phase: r.phase, accountsNeeded: r.cap === null ? null : Number(ceilDiv(r.requested, r.cap)) })),
  };
}

// ---- fixture loading -------------------------------------------------------------------------
const OFFENSIVE = /nigger/i; // Research redacts one vanity bot address in prose; we redact it everywhere we write
export const redact = (s: string) => (OFFENSIVE.test(s) ? '[redacted-vanity]' + s.slice(-4) : s);
/** Parse Research's CSV (header: slot_offset,slot,block_index,label,owner,token_account,kind,venue,sol_lamports,tokens_raw,pct_supply,jito_tip_lamports,fee_payer,sig). */
export function parseCsv(name: string, text: string): Fixture {
  const [head, ...lines] = text.trim().split(/\r?\n/); const h = head.split(',');
  const ix = (k: string) => { const i = h.indexOf(k); if (i < 0) throw new Error(`${name}: missing column ${k}`); return i; };
  const rows: Row[] = lines.map(l => { const c = l.split(','); return {
    slotOffset: Number(c[ix('slot_offset')]), blockIndex: Number(c[ix('block_index')]), label: c[ix('label')],
    owner: redact(c[ix('owner')]), tokenAccount: c[ix('token_account')], kind: c[ix('kind')], venue: c[ix('venue')],
    tokensRaw: BigInt(c[ix('tokens_raw')] || '0'), sig: c[ix('sig')] }; });
  return { name, file: `${name}.csv`, crew: CREWS[name] ?? [], rows };
}
/** Anonymise ids: owners, token accounts and tx signatures become per-fixture labels (<fixture>-W01, <fixture>-T01,
 *  <fixture>-TX001) in order of first appearance. Equality inside a fixture is kept (same owner / account / tx -> same
 *  label), so replay results are unchanged. Exempt pool-authority owners are kept as-is (they are program PDAs).
 *  Ids are compared on their first 8 (owner/account) / 12 (sig) characters, as the earlier shortened snapshot did. */
export function anonymise(f: Fixture): Fixture {
  const maps = { W: new Map<string, string>(), T: new Map<string, string>(), TX: new Map<string, string>() };
  const lab = (k: 'W' | 'T' | 'TX', v: string, n: number, w: number) => {
    if (!v) return v; const key = v.slice(0, n); const m = maps[k];
    if (!m.has(key)) m.set(key, `${f.name}-${k}${String(m.size + 1).padStart(w, '0')}`);
    return m.get(key)!;
  };
  return { ...f, rows: f.rows.map(r => ({ ...r, owner: EXEMPT_OWNERS.has(r.owner) ? r.owner : lab('W', r.owner, 8, 2), tokenAccount: lab('T', r.tokenAccount, 8, 2), sig: lab('TX', r.sig, 12, 3) })) };
}
/** Minimal snapshot committed in tests/fixtures: anonymised ids only (no mainnet addresses, no token names). */
export function toSnapshot(f: Fixture) {
  const a = anonymise(f);
  return { name: a.name, rows: a.rows.map(r => [r.slotOffset, r.blockIndex, r.label, r.owner, r.tokenAccount, r.kind, r.venue, r.tokensRaw.toString(), r.sig]) };
}
export function fromSnapshot(s: { name: string; rows: any[][] }): Fixture {
  return { name: s.name, file: 'tests/fixtures/replay_v0.min.json', crew: CREWS[s.name] ?? [], rows: s.rows.map(([so, bi, label, owner, ta, kind, venue, tok, sig]) => ({ slotOffset: so, blockIndex: bi, label, owner: redact(owner), tokenAccount: ta, kind, venue, tokensRaw: BigInt(tok), sig })) };
}
/** Anonymised fixture names. Full CSVs, if present locally, are expected as <dir>/A.csv … E.csv (not in the repo). */
export const FIXTURE_NAMES = ['A', 'B', 'C', 'D', 'E'];
