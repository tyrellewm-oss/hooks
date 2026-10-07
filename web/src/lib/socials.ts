// Token links: the social profiles a studio can add (the server checks the same hosts, SOCIAL_HOSTS in sdk/metadata.ts;
// tests/metadata.test.ts keeps the two lists equal) and the market sites every token links to by its mint.
export type SocialKey = 'website' | 'x' | 'telegram' | 'discord' | 'tiktok' | 'instagram' | 'youtube';

/** In display order. hosts = null: any https link. */
export const SOCIALS: { key: SocialKey; label: string; hosts: string[] | null; placeholder: string }[] = [
  { key: 'website', label: 'Website', hosts: null, placeholder: 'https://example.org' },
  { key: 'x', label: 'X', hosts: ['x.com', 'twitter.com'], placeholder: 'https://x.com/handle' },
  { key: 'telegram', label: 'Telegram', hosts: ['t.me'], placeholder: 'https://t.me/group' },
  { key: 'discord', label: 'Discord', hosts: ['discord.gg', 'discord.com'], placeholder: 'https://discord.gg/invite' },
  { key: 'tiktok', label: 'TikTok', hosts: ['tiktok.com', 'vm.tiktok.com'], placeholder: 'https://tiktok.com/@handle' },
  { key: 'instagram', label: 'Instagram', hosts: ['instagram.com'], placeholder: 'https://instagram.com/handle' },
  { key: 'youtube', label: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'm.youtube.com'], placeholder: 'https://youtube.com/@channel' },
];
/** [field, allowed hosts] for every social with a host rule (the website takes any https link). */
export const SOCIAL_HOSTS = SOCIALS.filter((s) => s.hosts).map((s) => [s.key, s.hosts!] as const);

/** The token's set links, in display order. */
export function socialLinks(m: Partial<Record<SocialKey, string | null>> | null | undefined): { key: SocialKey; label: string; href: string }[] {
  if (!m) return [];
  return SOCIALS.flatMap((s) => (m[s.key] ? [{ key: s.key, label: s.label, href: m[s.key]! }] : []));
}

/** Where anyone can look the token up by its mint. GMGN and DEX Screener list mainnet tokens only. */
export const marketLinks = (mint: string) => [
  { key: 'xsearch', label: 'Search on X', href: `https://x.com/search?q=${encodeURIComponent(mint)}&f=live` },
  { key: 'gmgn', label: 'GMGN', href: `https://gmgn.ai/sol/token/${mint}` },
  { key: 'dex', label: 'DEX Screener', href: `https://dexscreener.com/solana/${mint}` },
] as const;
