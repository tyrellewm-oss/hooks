#!/usr/bin/env python3
"""Builds the tables for flywheel_dryrun_log.md from the public logs + CLI event log (addresses and sigs only)."""
import json, sys
X = lambda s: f"[{s[:8]}…](https://explorer.solana.com/tx/{s}?cluster=devnet)" if s else "–"
def runs_table(path):
    l = json.load(open(path)); out = []
    out.append("| run_id (UTC) | status | claimed (lamports) | dev | buyback | swap in | min_out → out_raw | impact bps / halvings | carry-over (reason) | burned_raw (verified) | reconcile | gas | txs |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in l['runs']:
        cl = sum(int(c['claimed_lamports']) for c in r['claims'])
        sk = '; '.join(f"{c['source']} skipped: {c['skipped']}" for c in r['claims'] if c.get('skipped'))
        s = r.get('swap') or {}; b = r.get('burn') or {}; rc = r.get('reconcile') or {}
        txs = ' '.join(X(t) for t in r.get('txs', []))
        out.append(f"| {r['run_id'][7:]} | {r['status']}{(' — ' + r['reason'][:120]) if r['reason'] else ''} | {cl}{(' ('+sk+')') if sk else ''} | {r['dev_lamports']} | {r['buyback_lamports']} | {s.get('in_lamports','–')} | {s.get('min_out_raw','–')} → {s.get('out_raw','–')} | {s.get('price_impact_bps','–')} / {s.get('halvings','–')} | {r['carryover_lamports']} ({r['carryover_reason']}) | {b.get('burned_raw','–')} ({b.get('verified','–')}) | {'ok' if rc.get('ok') else ('–' if not rc else 'FAIL')} | {r['gas_lamports']} | {txs} |")
    return '\n'.join(out), l
if __name__ == '__main__':
    t, l = runs_table(sys.argv[1]); print(t); print(); print('totals_raw:', json.dumps(l['totals_raw']))
