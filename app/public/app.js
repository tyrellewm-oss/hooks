// Launch page front end. Cap math comes from the same module the tests use (sdk/capMath.ts, bundled at /capMath.js).
import { effectiveCap, capAt, nextChange, roomUnderCap, validate, RELEASE_LIMITS } from '/capMath.js';
import { explainerKey, explainerTemplate, allowRetry } from './explainer.js';
import { fill, tok, pctOf, pageVars, explainVars } from './pagevars.js';
import { supplySoldText } from './format.js';
export { fill };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const SLOT_SECONDS = 0.4; // approximate; shown as "about"
let META = null;

const api = async (p, opts) => { const r = await fetch(p, opts); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const aboutTime = (slots) => { const s = Number(slots) * SLOT_SECONDS; return s < 90 ? `about ${Math.round(s)} seconds` : `about ${Math.round(s / 60)} minutes`; };

const commonVars = (view) => pageVars(META, view);

function renderChrome() {
  const c = META.content;
  $('#banner').textContent = c.banner;
  $('#badge').textContent = c.devnet_label;
  $('#cluster').textContent = `cluster: ${META.cluster} · ${META.rpc}`;
  $('#footer').textContent = fill(c.footer, commonVars(null));
}

// ---------- checklist gate (AC-24)
const CK = 'trenches-checklist';
function checklistValid() {
  try { const s = JSON.parse(localStorage.getItem(CK) || 'null'); return !!s && s.version === META.content.version && s.ticked.length === 8 && s.ticked.every(Boolean) && Date.now() - s.at < 30 * 864e5; } catch { return false; }
}
function renderChecklist(vars, onChange) {
  const c = META.content;
  const items = c.checklist.map((t) => fill(t, vars));
  const el = document.createElement('div'); el.className = 'card checklist';
  el.innerHTML = `<h2>${esc(c.checklist_title)}</h2>` + items.map((t, i) => `<label><input type="checkbox" data-i="${i}"> <span>${esc(t)}</span></label>`).join('') + `<button id="ck-btn" disabled>${esc(c.checklist_button)}</button> <span id="ck-state" class="muted"></span>`;
  const boxes = () => [...el.querySelectorAll('input[type=checkbox]')];
  if (checklistValid()) boxes().forEach((b) => (b.checked = true));
  const sync = () => { const all = boxes().every((b) => b.checked); el.querySelector('#ck-btn').disabled = !all; el.querySelector('#ck-state').textContent = checklistValid() ? 'confirmed (valid 30 days)' : 'not confirmed'; };
  el.addEventListener('change', sync);
  el.querySelector('#ck-btn').onclick = () => { localStorage.setItem(CK, JSON.stringify({ version: c.version, ticked: boxes().map((b) => b.checked), at: Date.now() })); sync(); onChange(); };
  setTimeout(sync); return el;
}

// ---------- home
async function home() {
  const m = $('#main');
  const rows = META.launches.map((l) => `<tr><td class="mono"><a href="/token/${l.mint}">${l.mint}</a></td><td>${esc(l.time)}</td></tr>`).join('') || '<tr><td colspan=2 class="muted">no launches yet</td></tr>';
  m.innerHTML = `
  <div class="card"><h2>Test tokens on ${META.cluster}</h2><table><tr><th>Mint</th><th>Launched</th></tr>${rows}</table></div>
  <div class="card"><h2>Create a test token (${META.cluster}, studio test key only - no public self-serve)</h2>
    <p class="muted">Signed server-side by a throwaway ${META.cluster === 'DEVNET' ? 'devnet' : 'local'} test key. Creates a Meteora DBC config with the transfer hook, the pool, and the frozen cap config in one go.</p>
    <label>Name <input id="c-name" value="Hookd Test" maxlength="32"></label>
    <label>Ticker <input id="c-sym" value="TTEST" maxlength="10"></label>
    <p class="muted">Default schedule: <b>${esc(META.defaultSchedule.name)}</b> (${esc(META.defaultSchedule.label)})</p>
    <label>Cap steps (slot offset : % of supply), one per line <br><textarea id="c-steps" rows="4" cols="30"></textarea></label>
    <label>No cap after (slots) <input id="c-unc" value="${esc(META.defaultSchedule.uncappedAfter)}" size="8"></label>
    <label>Migration threshold (SOL, tiny curve) <input id="c-thr" value="1" size="6"></label>
    <div id="c-preview" class="muted"></div>
    <button id="c-go">Create on ${META.cluster}</button> <span id="c-out"></span>
  </div>`;
  $('#c-steps').value = META.defaultSchedule.steps.map((x) => `${x.slotOffset}:${x.maxBps / 100}`).join('\n');
  const parse = () => ({ steps: $('#c-steps').value.trim().split(/\n+/).map((l) => { const [o, p] = l.split(':'); return { slotOffset: BigInt(o.trim()), maxBps: Math.round(Number(p) * 100) }; }), uncappedAfter: BigInt($('#c-unc').value) });
  const preview = () => { try { const s = parse(); const e = validate({ launchSlot: 0n, supply: 1n, ...s }, RELEASE_LIMITS); $('#c-preview').textContent = e ? `InvalidCapSchedule: ${e}` : `valid: ${s.steps.map((x) => `${pctOf(x.maxBps)} from slot +${x.slotOffset}`).join(', ')}, no cap from slot +${s.uncappedAfter} (${aboutTime(s.uncappedAfter)})`; $('#c-go').disabled = !!e; } catch (er) { $('#c-preview').textContent = String(er); $('#c-go').disabled = true; } };
  m.addEventListener('input', preview); preview();
  $('#c-go').onclick = async () => {
    const s = parse(); $('#c-out').textContent = 'creating… (2 transactions)'; $('#c-go').disabled = true;
    try { const r = await api('/api/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('#c-name').value, symbol: $('#c-sym').value, steps: s.steps.map((x) => ({ slotOffset: x.slotOffset.toString(), maxBps: x.maxBps })), uncappedAfter: s.uncappedAfter.toString(), thresholdSol: Number($('#c-thr').value) }) });
      // 8.5b: the page shows registry mints only; a new mint stays off the page until it is added to keeper/registry.json
      if (r.registered === false) { $('#c-out').innerHTML = `created <code>${esc(r.mint)}</code>: ${esc(r.note)}`; $('#c-go').disabled = false; return; }
      location.href = `/token/${r.mint}`; }
    catch (e) { $('#c-out').innerHTML = `<span class="fail">${esc(e.message)}</span>`; $('#c-go').disabled = false; }
  };
}

// ---------- token page
function capCfg(st) { return { launchSlot: BigInt(st.launchSlot), supply: BigInt(st.supply), steps: st.steps.map((s) => ({ slotOffset: BigInt(s.slotOffset), maxBps: s.maxBps })), uncappedAfter: BigInt(st.uncappedAfter) }; }

async function tokenPage(mint) {
  const m = $('#main');
  let view = await api(`/api/token/${mint}`);
  const vars = () => commonVars(view);
  m.innerHTML = `<div class="grid"><div id="left"></div><div id="right"></div></div><div id="rr"></div><div id="hist"></div>`;
  const left = $('#left'), right = $('#right');
  const ck = renderChecklist(vars(), () => drawTrade());
  right.appendChild(ck);
  const trade = document.createElement('div'); trade.className = 'card'; right.prepend(trade);
  const state = document.createElement('div'); state.className = 'card'; left.appendChild(state);

  function drawState() {
    const st = view.status;
    const hooked = st.transferHookProgram !== null;
    const cur = st.currentCap === null || st.currentCap === undefined ? 'no cap' : `${tok(st.currentCap)} tokens`;
    const nc = st.nextChange ? `${st.nextChange.bps === null ? 'no cap' : pctOf(st.nextChange.bps)} at slot ${st.nextChange.slot} (${aboutTime(BigInt(st.nextChange.slot) - BigInt(st.slot))} from now)` : 'none (no cap)';
    state.innerHTML = `<h2>Token state (live from ${META.cluster})</h2>
      <table>
      <tr><td>Mint</td><td class="mono"><a href="${view.explorer.mint}" target="_blank">${st.mint}</a></td></tr>
      <tr><td>Pool</td><td class="mono">${view.explorer.pool ? `<a href="${view.explorer.pool}" target="_blank">${view.launch.pool}</a>` : '-'}</td></tr>
      <tr><td>Supply</td><td>${tok(st.supply)} (mint authority: ${st.mintAuthority ?? 'none'}, freeze: ${st.freezeAuthority ?? 'none'})</td></tr>
      <tr><td>Transfer hook</td><td class="mono">${hooked ? `${st.transferHookProgram} (authority ${st.transferHookAuthority}, DBC pool authority)` : 'none: removed at graduation (plain Token-2022)'}</td></tr>
      <tr><td>Slot</td><td>${st.slot} (launch slot ${st.launchSlot ?? '-'})</td></tr>
      <tr><td><b>Current cap per token account</b></td><td><b>${hooked ? cur : 'no cap (hook removed)'}</b></td></tr>
      <tr><td>Next change</td><td>${hooked ? nc : '-'}</td></tr>
      <tr><td>Schedule (frozen)</td><td>${(st.steps || []).map((s) => `${pctOf(s.maxBps)} from +${s.slotOffset}`).join(', ')}, no cap from +${st.uncappedAfter} slots ${st.testSlotsBuild ? '<b class="fail">(test-slots build)</b>' : '(release build)'}</td></tr>
      <tr><td>Exempt receivers</td><td class="mono">DBC pool authority FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM (owns the pool vaults), DAMM v2 pool authority HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC (migration)${(st.exemptOwners || []).map((e) => ', ' + e).join('')}</td></tr>
      <tr><td>Lift switch</td><td>global lifted: ${st.globalLifted}, this token lifted: ${st.mintLifted}, raised minimum cap: ${st.raisedFloorBps ? pctOf(st.raisedFloorBps) : 'none'}</td></tr>
      <tr><td>Anti-sniper fee schedule</td><td>${view.fee ? `${view.fee.cliffPct}% falling to ${view.fee.endPct}% over ${view.fee.totalSlots} slots (${view.fee.mode})` : '-'}</td></tr>
      <tr><td>Supply split</td><td>${supplySoldText(view.feeConfig?.percentageSupplyOnMigration)}</td></tr>
      <tr><td>Curve</td><td>${view.pool ? `${view.pool.quoteReserveSol} SOL of ${view.fee?.migrationQuoteThresholdSol} SOL threshold${view.pool.curveComplete ? ' · complete' : ''}${view.pool.isMigrated ? ' · migrated to DAMM v2' : ''}` : '-'}</td></tr>
      <tr><td>Test wallets</td><td class="mono">A ${META.wallets.A}: ${tok(view.balances.A)}<br>B ${META.wallets.B}: ${tok(view.balances.B)}</td></tr>
      </table>`;
  }
  function roomFor(walletKey) {
    const st = view.status; if (!st.steps || st.transferHookProgram === null) return null;
    const cap = effectiveCap(capCfg(st), { lifted: st.mintLifted, raisedFloorBps: st.raisedFloorBps }, st.globalLifted, BigInt(st.slot));
    return { cap, room: roomUnderCap(cap, BigInt(view.balances[walletKey])) };
  }
  let lastResult = '';
  function drawTrade() {
    const enabled = checklistValid();
    const keep = { w: trade.querySelector('#t-w')?.value ?? 'A', a: trade.querySelector('#t-amt')?.value ?? '5000000' };
    trade.innerHTML = `<h2>Trade (${META.cluster}, test wallets)</h2>
      <label>Wallet <select id="t-w"><option>A</option><option>B</option></select></label>
      <label>Amount (tokens) <input id="t-amt" size="14"></label>
      <div id="t-prev" class="muted"></div>
      <button id="t-buy" ${enabled ? '' : 'disabled'}>Buy</button> <button id="t-sell" ${enabled ? '' : 'disabled'}>Sell</button>
      ${enabled ? '' : '<div class="muted">Tick all 8 lines in the checklist below to enable trading.</div>'}
      <div id="t-out">${lastResult}</div>`;
    trade.querySelector('#t-w').value = keep.w; trade.querySelector('#t-amt').value = keep.a;
    const prev = () => { const r = roomFor(trade.querySelector('#t-w').value); trade.querySelector('#t-prev').textContent = r === null ? 'No cap applies right now.' : r.cap === null ? 'No cap right now (ramp over or lifted).' : `Room under the current cap for the token account of test wallet ${trade.querySelector('#t-w').value}: ${tok(r.room)} tokens (cap ${tok(r.cap)}).`; };
    trade.oninput = prev; prev();
    trade.querySelector('#t-buy').onclick = () => doTrade('buy');
    trade.querySelector('#t-sell').onclick = () => doTrade('sell');
    const rb = trade.querySelector('#t-retry'); if (rb) rb.onclick = () => doTrade(rb.dataset.side);
  }
  async function doTrade(side) {
    const w = trade.querySelector('#t-w').value, amount = trade.querySelector('#t-amt').value;
    trade.querySelector('#t-out').textContent = 'sending…';
    try {
      const r = await api('/api/trade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mint, wallet: w, side, amount }) });
      view = await api(`/api/token/${mint}`);
      lastResult = r.ok ? `<p class="ok">OK: <a href="${r.link}" target="_blank">${r.sig.slice(0, 20)}…</a></p>` : `<p class="fail">Failed: <a href="${r.link}" target="_blank">${(r.sig || '').slice(0, 20)}…</a></p>${explain(r, side, w)}`;
    } catch (e) { lastResult = `<p class="fail">${esc(e.message)}</p>`; }
    drawState(); drawTrade();
  }
  function explain(r, side, w) {
    const t = META.content.trade_fail_explainer; const v = vars();
    const key = explainerKey(r, side);
    const extra = explainVars(r, view, w);
    const retry = allowRetry(key) ? `<button id="t-retry" data-side="${esc(side)}">Try again</button>` : '';
    return `<div class="explainer" data-key="${esc(key)}"><b>${esc(t.title)}</b><p>${esc(fill(explainerTemplate(t, key), { ...v, ...extra }))}</p>${retry}</div>`;
  }
  function drawRR() {
    const rr = META.content.rules_and_risks; const v = vars();
    $('#rr').innerHTML = `<div class="card"><h2>${esc(fill(rr.title, v))}</h2><ul>${rr.items.map((i) => `<li>${esc(fill(i, v))}</li>`).join('')}</ul></div>`;
    const h = view.switchHistory;
    $('#hist').innerHTML = `<div class="card"><h2>Lift-only switch history (RestrictionsLifted events)</h2>${h.length ? `<table><tr><th>Scope</th><th>Raised min cap</th><th>Lifted</th><th>Slot</th><th>Signer</th><th>Tx</th></tr>${h.map((e) => `<tr><td>${e.scope}</td><td>${e.newMinCapBps === 10000 ? '-' : pctOf(e.newMinCapBps)}</td><td>${e.lifted}</td><td>${e.slot}</td><td class="mono">${e.signer.slice(0, 8)}…</td><td><a href="${e.link}" target="_blank">tx</a></td></tr>`).join('')}</table>` : '<p class="muted">none</p>'}</div>`;
  }
  drawState(); drawTrade(); drawRR();
  setInterval(async () => { try { view = await api(`/api/token/${mint}`); drawState(); drawRR(); const p = trade.querySelector('#t-prev'); if (p) trade.oninput(); } catch {} }, 6000);
}

(async () => {
  META = await api('/api/meta');
  renderChrome();
  const mm = location.pathname.match(/^\/token\/(\w+)/);
  if (mm) await tokenPage(mm[1]); else await home();
})().catch((e) => { $('#main').innerHTML = `<p class="fail">${esc(e.message)}</p>`; });
