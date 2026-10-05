// Static files for the launch page. Two UIs:
//   classic (default) -> app/public (the original page; the e2e test targets it)
//   web (--web)       -> web/dist  (the new front end, built with `cd web && pnpm build`); any non-file path falls back
//                        to index.html so client-side routes (/token/<mint>, /create, ...) load on refresh
// Pure: decides what to serve; app/server.ts writes it through send(). Read-only (no file writes, ticket 8.5b C11).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

export type UiMode = 'classic' | 'web';
export const UI_ROOTS: Record<UiMode, string> = { classic: 'app/public', web: 'web/dist' };

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const TEXT = /^(text\/|application\/json|image\/svg)/;

export interface StaticReply { code: number; body: string | Buffer | { error: string }; type?: string }

/** `--web` selects the new UI; it must have been built first. */
export function uiModeFromArgs(argv: string[]): UiMode { return argv.includes('--web') ? 'web' : 'classic'; }
export function assertUiBuilt(mode: UiMode, cwd = process.cwd()) {
  if (mode === 'web' && !existsSync(resolve(cwd, UI_ROOTS.web, 'index.html'))) throw new Error('--web: web/dist is missing. Build it first: cd web && pnpm install && pnpm build');
}

/** A file strictly inside `root` (no '..', no absolute paths, no drive letters, no encoded escapes), or null. */
export function safeFile(root: string, rel: string, cwd = process.cwd()): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(decoded) || /^[\\/]|^[a-z]:/i.test(decoded)) return null;
  const base = resolve(cwd, root);
  const p = resolve(base, decoded);
  if (p !== base && !p.startsWith(base + sep)) return null;
  try { return existsSync(p) && statSync(p).isFile() ? p : null; } catch { return null; }
}

const fileReply = (p: string): StaticReply => {
  const type = MIME[extname(p).toLowerCase()] ?? 'application/octet-stream';
  return { code: 200, type, body: TEXT.test(type) ? readFileSync(p, 'utf8') : readFileSync(p) };
};
const NOT_FOUND: StaticReply = { code: 404, body: { error: 'not found' } };

/** What to serve for a non-API GET path. */
export function staticReply(pathname: string, mode: UiMode, cwd = process.cwd()): StaticReply {
  const root = UI_ROOTS[mode];
  if (mode === 'classic') {
    const rel = pathname === '/' || pathname.startsWith('/token/') ? 'index.html' : pathname.slice(1);
    const p = safeFile(root, rel, cwd);
    return p ? fileReply(p) : NOT_FOUND;
  }
  if (pathname.startsWith('/api/')) return NOT_FOUND;
  const rel = pathname.slice(1);
  const p = rel ? safeFile(root, rel, cwd) : null;
  if (p) return fileReply(p);
  // a missing asset is a real 404 (so a broken build shows up); any route path gets the app shell
  if (extname(pathname) && !pathname.startsWith('/token/')) return NOT_FOUND;
  const index = safeFile(root, 'index.html', cwd);
  return index ? fileReply(index) : NOT_FOUND;
}
