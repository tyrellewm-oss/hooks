// Studio sign-in: the studio routes (create a launch, edit token details) need a session from a wallet on the
// allowlist. Sign-in = the wallet signs a one-time challenge message (no transaction, no fee); the server checks the
// ed25519 signature with node:crypto. Sessions are random tokens sent in the x-studio-session header (not a cookie, so
// another site can't ride on them). In memory only: a restart signs everyone out.
//
// Allowlist: STUDIO_WALLETS (comma-separated wallet addresses). Fails closed: on devnet an empty allowlist means the
// studio is closed. LOCAL (a local validator) without an allowlist stays open, so the local demo and e2e keep working.
//
// Open launch (sdk/launch_open.ts) adds two options: `anyWallet` lets every wallet sign in (the token-details route then
// lets a wallet edit only the tokens it created, or any token if it is on the allowlist), and `secret` makes challenges
// and sessions stateless (HMAC-signed instead of kept in memory), for a host that runs many short-lived instances.
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 8 * 3600_000;
const MAX_PENDING = 1000;

export class StudioAuthError extends Error { constructor(public readonly code: 400 | 401 | 403, m: string) { super(m); this.name = 'StudioAuthError'; } }

/** Parse STUDIO_WALLETS. A malformed entry stops the server at start (never silently skipped). */
export function parseAllowlist(v: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    let k: PublicKey;
    try { k = new PublicKey(raw); } catch { throw new Error(`STUDIO_WALLETS: "${raw}" is not a wallet address`); }
    if (k.toBase58() !== raw) throw new Error(`STUDIO_WALLETS: "${raw}" is not in canonical form`);
    out.add(raw);
  }
  return out;
}

/** The exact text the wallet signs. Fixed layout; the server rebuilds it, never takes it from the browser. */
export function challengeText(wallet: string, nonce: string, cluster: string, issued: number, expires: number): string {
  return ['Hookd studio sign-in', '', 'Sign this message to use the studio tools. It is not a transaction and costs nothing.', '',
    `Wallet: ${wallet}`, `Cluster: ${cluster}`, `Nonce: ${nonce}`, `Issued: ${new Date(issued).toISOString()}`, `Expires: ${new Date(expires).toISOString()}`].join('\n');
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
/** ed25519 verify of `message` by `wallet` (base58 public key). */
export function verifyWalletSignature(wallet: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, new PublicKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch { return false; }
}

interface Pending { wallet: string; text: string; expires: number }
interface Session { wallet: string; expires: number }
export interface StudioAuthOptions { anyWallet?: boolean; secret?: Buffer }

export class StudioAuth {
  private pending = new Map<string, Pending>();
  private sessions = new Map<string, Session>();
  readonly open: boolean;
  private readonly anyWallet: boolean;
  private readonly secret: Buffer | null;
  constructor(private readonly allow: ReadonlySet<string>, private readonly cluster: string, openWhenEmpty: boolean, private readonly now: () => number = Date.now, opts: StudioAuthOptions = {}) {
    this.open = allow.size === 0 && openWhenEmpty && !opts.anyWallet;
    this.anyWallet = !!opts.anyWallet;
    this.secret = opts.secret ?? null;
  }
  /** For the page: is there a studio at all, and is it open without sign-in. */
  status() { return { required: !this.open, configured: this.allow.size > 0 || this.anyWallet }; }
  /** On the allowlist (an admin studio wallet), as opposed to any wallet that signed in. */
  isStudioWallet(wallet: string) { return this.allow.has(wallet); }
  private mayUse(w: string) { return this.anyWallet || this.allow.has(w); }
  private closed() { return this.allow.size === 0 && !this.anyWallet; }
  private mac(...parts: (string | number)[]) { return createHmac('sha256', this.secret!).update(parts.join('|')).digest('hex'); }

  challenge(wallet: unknown): { nonce: string; message: string; expiresInMs: number } {
    this.sweep();
    if (this.closed()) throw new StudioAuthError(403, this.open ? 'the studio is open on this local cluster; no sign-in needed' : 'the studio is closed: no studio wallets are configured (STUDIO_WALLETS)');
    const w = typeof wallet === 'string' ? wallet : '';
    if (this.anyWallet) { try { if (new PublicKey(w).toBase58() !== w) throw 0; } catch { throw new StudioAuthError(400, 'wallet must be a wallet address'); } }
    if (!this.mayUse(w)) throw new StudioAuthError(403, 'this wallet is not on the studio list');
    const issued = this.now(), expires = issued + CHALLENGE_TTL_MS;
    if (this.secret) {   // stateless: the nonce carries its own issue time and MAC
      const nonce = `${issued}.${this.mac('challenge', w, this.cluster, issued).slice(0, 32)}`;
      return { nonce, message: challengeText(w, nonce, this.cluster, issued, expires), expiresInMs: CHALLENGE_TTL_MS };
    }
    if (this.pending.size >= MAX_PENDING) throw new StudioAuthError(403, 'too many sign-ins in progress; try again in a few minutes');
    const nonce = randomBytes(16).toString('hex');
    const text = challengeText(w, nonce, this.cluster, issued, expires);
    this.pending.set(nonce, { wallet: w, text, expires });
    return { nonce, message: text, expiresInMs: CHALLENGE_TTL_MS };
  }

  /** Exchange a signed challenge for a session token. One use per challenge (in memory; a stateless challenge can be
   *  exchanged again until it expires, which only ever yields another session for the same wallet). */
  signIn(wallet: unknown, nonce: unknown, signatureHex: unknown): { token: string; wallet: string; expiresInMs: number } {
    this.sweep();
    let p: Pending | undefined;
    if (this.secret) {
      const m = typeof nonce === 'string' ? /^(\d{13})\.([0-9a-f]{32})$/.exec(nonce) : null;
      const w = typeof wallet === 'string' ? wallet : '';
      if (m && w) {
        const issued = Number(m[1]);
        const ok = timingSafeEqual(Buffer.from(this.mac('challenge', w, this.cluster, issued).slice(0, 32)), Buffer.from(m[2]));
        if (ok && issued + CHALLENGE_TTL_MS > this.now() && issued <= this.now()) p = { wallet: w, text: challengeText(w, nonce as string, this.cluster, issued, issued + CHALLENGE_TTL_MS), expires: issued + CHALLENGE_TTL_MS };
      }
    } else {
      p = typeof nonce === 'string' ? this.pending.get(nonce) : undefined;
      if (p) this.pending.delete(nonce as string);
    }
    if (!p) throw new StudioAuthError(401, 'sign-in expired or already used; start again');
    if (wallet !== p.wallet) throw new StudioAuthError(401, 'the signing wallet is not the one the sign-in was started for');
    if (!this.mayUse(p.wallet)) throw new StudioAuthError(403, 'this wallet is not on the studio list');
    if (typeof signatureHex !== 'string' || !/^[0-9a-f]{128}$/i.test(signatureHex)) throw new StudioAuthError(400, 'signature must be 64 bytes, hex');
    if (!verifyWalletSignature(p.wallet, new TextEncoder().encode(p.text), Buffer.from(signatureHex, 'hex'))) throw new StudioAuthError(401, 'the signature does not match the sign-in message');
    const expires = this.now() + SESSION_TTL_MS;
    if (this.secret) return { token: `${p.wallet}.${expires}.${this.mac('session', p.wallet, this.cluster, expires)}`, wallet: p.wallet, expiresInMs: SESSION_TTL_MS };
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { wallet: p.wallet, expires });
    return { token, wallet: p.wallet, expiresInMs: SESSION_TTL_MS };
  }

  /** The signed-in studio wallet for a request, or a StudioAuthError. Open local studio -> 'local-open'. */
  require(header: unknown): string {
    if (this.open) return 'local-open';
    this.sweep();
    if (this.closed()) throw new StudioAuthError(403, 'the studio is closed: no studio wallets are configured (STUDIO_WALLETS)');
    const token = Array.isArray(header) ? header[0] : header;
    let s: Session | undefined;
    if (this.secret) {
      const m = typeof token === 'string' ? /^([1-9A-HJ-NP-Za-km-z]{32,44})\.(\d{13})\.([0-9a-f]{64})$/.exec(token) : null;
      if (m && timingSafeEqual(Buffer.from(this.mac('session', m[1], this.cluster, Number(m[2]))), Buffer.from(m[3])) && Number(m[2]) > this.now()) s = { wallet: m[1], expires: Number(m[2]) };
    } else s = typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) ? this.sessions.get(token) : undefined;
    if (!s) throw new StudioAuthError(401, 'studio sign-in required');
    if (!this.mayUse(s.wallet)) { this.sessions.delete(token as string); throw new StudioAuthError(403, 'this wallet is no longer on the studio list'); }
    return s.wallet;
  }

  /** In memory, the session ends now; a stateless session can't be revoked early and simply expires (the page forgets it). */
  signOut(header: unknown) { const t = Array.isArray(header) ? header[0] : header; if (typeof t === 'string') this.sessions.delete(t); }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
    for (const [k, v] of this.sessions) if (v.expires <= t) this.sessions.delete(k);
  }
}
