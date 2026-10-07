// Minimal line icons (24px grid, currentColor stroke).
import type { ReactNode } from 'react';

const I = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const IconGrid = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></I>;
export const IconRamp = (p: { size?: number }) => <I {...p}><path d="M4 18h4v-4h5v-5h7" /><path d="M4 21h16" /></I>;
export const IconPlus = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></I>;
export const IconEye = (p: { size?: number }) => <I {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></I>;
export const IconSearch = (p: { size?: number }) => <I {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></I>;
export const IconMenu = (p: { size?: number }) => <I {...p}><path d="M4 7h16M4 12h16M4 17h16" /></I>;
export const IconSun = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1" /></I>;
export const IconMoon = (p: { size?: number }) => <I {...p}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" /></I>;
export const IconBack = (p: { size?: number }) => <I {...p}><path d="M15 6l-6 6 6 6" /></I>;
export const IconCopy = (p: { size?: number }) => <I {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></I>;
export const IconCheck = (p: { size?: number }) => <I {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></I>;
export const IconArrow = (p: { size?: number }) => <I {...p}><path d="M5 12h14M13 6l6 6-6 6" /></I>;
export const IconHook = (p: { size?: number }) => <I {...p}><circle cx="14" cy="4.5" r="1.8" /><path d="M14 6.3v8.2a4.8 4.8 0 0 1-9.6 0V12l-1.6 1.6" /></I>;
export const IconShield = (p: { size?: number }) => <I {...p}><path className="duo" d="M12 3l7 2.8v5.6c0 4.5-3 7.4-7 8.6-4-1.2-7-4.1-7-8.6V5.8L12 3z" /><path d="M12 3l7 2.8v5.6c0 4.5-3 7.4-7 8.6-4-1.2-7-4.1-7-8.6V5.8L12 3z" /><path d="M8.8 12l2.2 2.2 4.2-4.4" /></I>;
export const IconFee = (p: { size?: number }) => <I {...p}><circle className="duo" cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="8.5" /><path d="M9 15l6-6" /><circle cx="9.3" cy="9.3" r="1" /><circle cx="14.7" cy="14.7" r="1" /></I>;
export const IconFlame = (p: { size?: number }) => <I {...p}><path className="duo" d="M12 3c.8 3.6-3.2 5.6-3.2 9.2a3.2 3.2 0 0 0 6.4 0c0-1.5-.7-2.4-1.3-3.2 2.7 1.2 4.6 3.7 4.6 6.6A6.5 6.5 0 0 1 5.5 15.6C5.5 10.2 11 8 12 3z" /><path d="M12 3c.8 3.6-3.2 5.6-3.2 9.2a3.2 3.2 0 0 0 6.4 0c0-1.5-.7-2.4-1.3-3.2 2.7 1.2 4.6 3.7 4.6 6.6A6.5 6.5 0 0 1 5.5 15.6C5.5 10.2 11 8 12 3z" /></I>;
export const IconSwitch = (p: { size?: number }) => <I {...p}><rect className="duo" x="3" y="7" width="18" height="10" rx="5" /><rect x="3" y="7" width="18" height="10" rx="5" /><circle cx="16" cy="12" r="2.6" /></I>;
export const IconLock = (p: { size?: number }) => <I {...p}><rect className="duo" x="5" y="10.5" width="14" height="10" rx="2.5" /><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></I>;
export const IconInfo = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.8v.2" /></I>;
export const IconHome = (p: { size?: number }) => <I {...p}><path d="M4 11l8-6.5 8 6.5" /><path d="M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5" /></I>;
export const IconBook = (p: { size?: number }) => <I {...p}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z" /></I>;
export const IconCeiling = (p: { size?: number }) => <I {...p}><rect className="duo" x="9" y="9" width="6" height="11" rx="1" /><path d="M4 5h16" /><path d="M12 20V9M8 13l4-4 4 4" /></I>;
export const IconBlocks = (p: { size?: number }) => <I {...p}><rect className="duo" x="8.5" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /><rect x="8.5" y="4" width="7" height="7" rx="1.5" /></I>;
export const IconClock = (p: { size?: number }) => <I {...p}><circle className="duo" cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></I>;
export const IconTrophy = (p: { size?: number }) => <I {...p}><path className="duo" d="M8 4h8v5a4 4 0 0 1-8 0V4z" /><path d="M8 4h8v5a4 4 0 0 1-8 0V4z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v3.5M8.5 20h7M10 16.5h4" /></I>;
/** The X (Twitter) mark, filled like the original. */
export const IconX = (p: { size?: number }) => <I {...p}><path fill="currentColor" stroke="none" d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.65l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23zm-1.16 17.52h1.83L7.08 4.13H5.12z" /></I>;
export const IconChart = (p: { size?: number }) => <I {...p}><path d="M4 4v16h16" /><path d="M7.5 15l3.5-4 3 2.5 5-6.5" /><path d="M15.5 7h3.5v3.5" /></I>;
// Social marks as line icons (paths after Tabler Icons, MIT), same grid and stroke as the rest.
export const IconGlobe = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M3.6 9h16.8M3.6 15h16.8M11.5 3a17 17 0 0 0 0 18M12.5 3a17 17 0 0 1 0 18" /></I>;
export const IconTelegram = (p: { size?: number }) => <I {...p}><path d="M15 10l-4 4 6 6 4-16-18 7 4 2 2 6 3-4" /></I>;
export const IconDiscord = (p: { size?: number }) => <I {...p}><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><path d="M15.5 17c0 1 1.5 3 2 3 1.5 0 2.83-1.67 3.5-3 .67-1.67.5-5.83-1.5-11.5-1.46-1.02-3-1.34-4.5-1.5l-.97 1.92a11.9 11.9 0 0 0-4.06 0L9 4c-1.5.16-3.04.48-4.5 1.5-2 5.67-2.17 9.83-1.5 11.5.67 1.33 2 3 3.5 3 .5 0 2-2 2-3" /><path d="M7 16.5c3.5 1 6.5 1 10 0" /></I>;
export const IconTiktok = (p: { size?: number }) => <I {...p}><path d="M21 7.92v4.03a9.95 9.95 0 0 1-5-1.95v4.5a6.5 6.5 0 1 1-8-6.33v4.33a2.5 2.5 0 1 0 4 2V3h4.08A6 6 0 0 0 21 7.92z" /></I>;
export const IconInstagram = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="16" height="16" rx="4" /><circle cx="12" cy="12" r="3" /><path d="M16.5 7.5v.01" /></I>;
export const IconYoutube = (p: { size?: number }) => <I {...p}><rect x="2" y="4" width="20" height="16" rx="4" /><path d="M10 9l5 3-5 3z" /></I>;
/** Candles, for DEX Screener. */
export const IconCandles = (p: { size?: number }) => <I {...p}><path d="M7 3.5v3M7 15.5v5M17 3.5v5M17 17.5v3" /><rect x="5" y="6.5" width="4" height="9" rx="1" /><rect x="15" y="8.5" width="4" height="9" rx="1" /></I>;
