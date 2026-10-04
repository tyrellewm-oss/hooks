// Durable journal (append-only JSONL, fsync) + state file (atomic replace, fsync). A failed write throws, and callers
// treat that as fail-closed (no next stage). No key material is ever written here.
import { openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1);
export function durableWrite(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w'); try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
export function durableAppend(path: string, line: string) {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a'); try { writeSync(fd, line.endsWith('\n') ? line : line + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}
export class Store {
  constructor(public dir: string) {}
  get journalPath() { return join(this.dir, 'journal.jsonl'); }
  get statePath() { return join(this.dir, 'state.json'); }
  get pauseFile() { return join(this.dir, 'PAUSE'); }
  journal(entry: Record<string, unknown>) { durableAppend(this.journalPath, ser({ at: new Date().toISOString(), ...entry }).replace(/\n\s*/g, ' ')); }
  loadState<T>(init: () => T): T { return existsSync(this.statePath) ? (JSON.parse(readFileSync(this.statePath, 'utf8')) as T) : init(); }
  saveState(s: unknown) { durableWrite(this.statePath, ser(s)); }
  pausedByFile() { return existsSync(this.pauseFile); }
}
export { ser };
