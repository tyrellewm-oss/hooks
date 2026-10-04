// FW-17 path redaction for anything written to a public log, evidence line or error that may be published.
// Generic patterns only (no host paths named in source). Each rule below is a separate pass so each can be tested
// and mutated on its own. Left alone on purpose: tx signatures and base58 pubkeys (no separators), http(s) URLs
// ("//" never starts a segment, and a path after the host is preceded by a host character), relative paths and
// ratios such as 1/2 or 15/85 (preceded by a word character). A path right after a colon ("EACCES:/x") is redacted.
// Not caught (documented limits): unexpanded variables such as $HOME or %USERPROFILE%, and fully percent-encoded
// separators such as %2F followed by home%2F.

/** One path segment: optional leading dots ('.config'), no trailing dot so a sentence's full stop is kept. */
const SEG = String.raw`(?:\.*[\w%$\-]+(?:\.+[\w%$\-]+)*|\.\.?)`;
/** A segment may hold up to three single spaces ('my user'), but only when another separator follows.
 *  POSIX paths do not allow this in their first segment ('/tmp then x/y' stays prose). */
const seg = (sep: string) => String.raw`(?:${SEG}(?: ${SEG}){1,3}(?=${sep})|${SEG})`;
const segs = (sep: string) => String.raw`(?:${sep}+${seg(sep)})*${sep}*`;

/** Home prefixes (case-insensitive), bare or inside a file: URL:
 *  - Users, home, root or mnt/<drive>/Users (WSL) under the root, with '/' or a JSON-escaped '\/' as the separator;
 *  - <drive>:\Users\ (one to four backslashes, i.e. raw, JSON-escaped or escaped twice) and <drive>:/Users/;
 *  - a UNC share \\host\ (the share and everything after it), raw or JSON-escaped (\\\\host\\);
 *  - ~/ and ~user/, where the user name may hold single spaces ('~jane lee/x').
 *  After a home prefix EVERYTHING goes up to the end of the line, a quote, or a backslash-quote: the user name, the
 *  rest of the path and any prose after it on that line (fails safe). Runs first, on single values only: it reads to the
 *  end of the line, so it is never applied to an already-serialised JSON line (see redactedJson). */
const S = String.raw`\\?\/`;
const ROOT_POSIX = String.raw`${S}(?:Users|home|root|mnt${S}[a-z]${S}Users)${S}`;
const ROOT_WIN = String.raw`[a-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)`;
const ROOT_UNC = String.raw`(?:\\\\){1,2}[\w.$\-]+\\`;
const ROOT_TILDE = String.raw`~(?:[\w.\-]+(?: [\w.\-]+)*)?${S}`;
const TAIL = String.raw`(?:[^\r\n'"\`\\]|\\(?!['"\`]))*`;
export const HOME_ROOT = new RegExp(String.raw`(?:\bfile:(?:\/\/[\w.\-]*)?(?:${ROOT_POSIX}|\/${ROOT_WIN})|(?<![\w/\\])${ROOT_POSIX}|(?<![\w\\])${ROOT_WIN}|(?<![\w\\:])${ROOT_UNC}|(?<![\w~/\\])${ROOT_TILDE})${TAIL}`, 'gi');
/** file: URLs, any form (file:/x, file:///x, file://host/x, percent-encoded spaces). Unquoted, a raw space ends it
 *  and trailing punctuation is kept. */
export const FILE_URL = /\bfile:[^\s'"`<>()]*[^\s'"`<>().,;:!?]/gi;
/** A quoted path or file: URL: the quotes stay, everything between them goes (spaces included). */
export const QUOTED_PATH = /(["'`])(?:\/|[A-Za-z]:[\\/]|file:)[^"'`\r\n]*?\1/gi;
/** Windows drive paths (C:\, C:\x\y, C:/x, doubled backslashes). */
export const WINDOWS_PATH = new RegExp(String.raw`(?<![\w\\])[A-Za-z]:[\\/]+(?:${seg(String.raw`[\\/]`)}${segs(String.raw`[\\/]`)})?`, 'g');
/** Absolute POSIX paths. Multi-component as before, plus a single component (/root, /tmp, /x/) that starts with a letter, '_' or '.'. */
export const POSIX_PATH = new RegExp(String.raw`(?<![\w/~\\])\/(?:${SEG}(?=\/)|\.?[A-Za-z_][\w%$\-]*(?:\.+[\w%$\-]+)*)${segs('/')}`, 'g');

/** Secrets (ticket #5): the value of every environment variable named here is replaced with '<secret>' wherever it
 *  appears, as given, trimmed and percent-encoded. The value is read from the environment at each call, so every sink
 *  that redacts (Keeper.log, the public log, CLI output and evidence lines, the site's send() and serverError) covers it
 *  from the moment it is set, whatever the order of construction. Any non-empty value is redacted, whatever its length. */
export const SECRET_ENV_VARS = ['FW_JUPITER_API_KEY'] as const;
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const n of SECRET_ENV_VARS) {
    const v = env[n];
    if (typeof v !== 'string' || !v.trim()) continue;
    for (const x of [v, v.trim(), encodeURIComponent(v.trim())]) if (x) out.add(x);
  }
  return [...out].sort((a, b) => b.length - a.length);
}
/** user:pass@ (or user@) userinfo in a URL: the userinfo becomes '<secret>'. */
export const URL_USERINFO = /\b([a-z][a-z0-9+.\-]*:\/\/)[^\s\/?#@'"`<>]+@/gi;
/** Credential-like query or form parameters (apikey, api_key, api-key, x-api-key, key, token, access_token, auth,
 *  password, secret) after '?', '&', ';', whitespace, a quote or the start of the text: the value becomes '<secret>'. */
export const SECRET_PARAM = /(^|[?&;\s"'`])((?:x-)?api[_\-]?key|key|token|access[_\-]?token|auth|password|secret)=([^&\s"'`#<>]+)/gi;
/** Replaces every secret value (see SECRET_ENV_VARS) with '<secret>', then any URL userinfo and credential query
 *  parameter values. */
export function redactSecrets(t: string, env: NodeJS.ProcessEnv = process.env): string {
  let s = t;
  for (const v of secretValues(env)) s = s.split(v).join('<secret>');
  return s.replace(URL_USERINFO, '$1<secret>@').replace(SECRET_PARAM, '$1$2=<secret>');
}

/** Redacts one value. Anything that is not a string is converted first (undefined and null become ''). Secrets go first. */
export function redactPaths(t: unknown): string {
  return redactSecrets(String(t ?? ''))
    .replace(HOME_ROOT, '<path>')
    .replace(QUOTED_PATH, '$1<path>$1')
    .replace(FILE_URL, '<path>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, '<path>');
}
/** JSON.stringify replacer: each string VALUE is redacted before it is escaped. A replacer cannot change keys; use
 *  redactedJson (or redactDeep) when keys may carry text. */
export function redactingReplacer(_key: string, value: unknown): unknown { return typeof value === 'string' ? redactPaths(value) : value; }
/** Deep copy with every string redacted, keys included.
 *  Converted (then walked): arrays; plain objects, Object.create(null) objects and class instances WITHOUT toJSON (own
 *  enumerable properties); an Error becomes { name, message, stack, cause, ...its other own properties }; a Map becomes
 *  a plain object of redacted keys and values; a Set becomes an array. A repeated (circular) reference becomes
 *  '[Circular]'.
 *  Passed through unchanged: numbers, booleans, bigint, null/undefined, functions, symbols, objects WITH toJSON
 *  (PublicKey, Date, Buffer) and typed arrays/ArrayBuffer views; a Buffer or typed array serialises as numbers, so text
 *  inside its bytes is not inspected. */
export function redactDeep<T>(v: T, f: (s: string) => string = redactPaths): T {
  const seen = new WeakSet<object>();
  const obj = (entries: [string, unknown][]) => Object.fromEntries(entries.map(([k, y]) => [f(k), r(y)]));
  const r = (x: any): any => {
    if (typeof x === 'string') return f(x);
    if (!x || typeof x !== 'object') return x;
    if (ArrayBuffer.isView(x) || x instanceof ArrayBuffer) return x;
    if (typeof x.toJSON === 'function' && !(x instanceof Error)) return x;
    if (seen.has(x)) return '[Circular]';
    seen.add(x);
    try {
      if (Array.isArray(x)) return x.map(r);
      if (x instanceof Error) {
        const out: Record<string, unknown> = { name: f(x.name), message: f(x.message), stack: f(x.stack ?? '') };
        if ('cause' in x) out.cause = r((x as any).cause);
        return { ...out, ...obj(Object.entries(x).filter(([k]) => !(k in out))) };
      }
      if (x instanceof Map) return obj([...x].map(([k, y]) => [String(k), y]));
      if (x instanceof Set) return [...x].map(r);
      return obj(Object.entries(x));
    } finally { seen.delete(x); }
  };
  return r(v);
}
/** One JSON line with every string (keys and values) redacted first: the only way public evidence lines are built.
 *  `f` may add passes of its own; it is still applied to single strings, never to the serialised line. */
export function redactedJson(v: unknown, f: (s: string) => string = redactPaths): string { return JSON.stringify(redactDeep(v, f)); }
