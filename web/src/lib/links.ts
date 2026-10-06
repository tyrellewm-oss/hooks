// Hookd's own token and X account, linked from the top bar. Set each one once it exists; until then its icon shows
// disabled ("coming soon").
export const HOOKD_X_URL = '';   // e.g. https://x.com/<handle>
export const HOOKD_CA = '';      // the token's mint address, once it has launched

/** The token's chart on GMGN, or '' while there is no CA. */
export const hookdChartUrl = HOOKD_CA ? `https://gmgn.ai/sol/token/${HOOKD_CA}` : '';
