// AC-24: the 8-line pre-trade checklist. Buy/Sell stay disabled until all 8 are ticked; the confirmation is stored
// locally, expires after 30 days and resets when the copy version changes (lib/hooks.ts).
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CONTENT, fill } from '../lib/shared';
import { confirmChecklist } from '../lib/hooks';

export function ChecklistModal({ vars, onClose }: { vars: Record<string, string>; onClose: () => void }) {
  const items = CONTENT.checklist.map((t) => fill(t, vars) as string);
  const [ticked, setTicked] = useState<boolean[]>(() => items.map(() => false));
  const first = useRef<HTMLInputElement>(null);
  const n = ticked.filter(Boolean).length;
  const all = n === items.length;

  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [onClose]);

  return createPortal(   // on document.body: the overlay must sit above the chart's canvas layers wherever it is opened
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ck-title">
        <div className="spread" style={{ marginBottom: 4 }}>
          <h1 id="ck-title" style={{ fontSize: 18 }}>{CONTENT.checklist_title}</h1>
          <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <p className="muted small">All {items.length} lines must be ticked to enable Buy and Sell. Your confirmation is kept in this browser for 30 days, or until the wording changes.</p>
        <div style={{ margin: '10px -8px' }}>
          {items.map((t, i) => (
            <label key={i} className={`ck-item ${ticked[i] ? 'on' : ''}`}>
              <input ref={i === 0 ? first : undefined} type="checkbox" checked={ticked[i]} onChange={(e) => setTicked((s) => s.map((v, j) => (j === i ? e.target.checked : v)))} />
              <span>{t}</span>
            </label>
          ))}
        </div>
        <div className="spread" style={{ alignItems: 'center' }}>
          <span className="small muted num">{n} of {items.length} confirmed</span>
          <button className="primary" disabled={!all} onClick={() => { confirmChecklist(); onClose(); }}>{CONTENT.checklist_button}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
