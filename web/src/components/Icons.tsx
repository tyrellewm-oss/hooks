// Minimal line icons (24px grid, currentColor stroke).
import type { ReactNode } from 'react';

const I = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

export const IconGrid = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></I>;
export const IconRamp = (p: { size?: number }) => <I {...p}><path d="M4 18h4v-4h5v-5h7" /><path d="M4 21h16" /></I>;
export const IconPlus = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M12 8.5v7M8.5 12h7" /></I>;
export const IconCode = (p: { size?: number }) => <I {...p}><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" /></I>;
export const IconEye = (p: { size?: number }) => <I {...p}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></I>;
export const IconSearch = (p: { size?: number }) => <I {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.2-4.2" /></I>;
export const IconMenu = (p: { size?: number }) => <I {...p}><path d="M4 7h16M4 12h16M4 17h16" /></I>;
export const IconSun = (p: { size?: number }) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1" /></I>;
export const IconMoon = (p: { size?: number }) => <I {...p}><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" /></I>;
export const IconBack = (p: { size?: number }) => <I {...p}><path d="M15 6l-6 6 6 6" /></I>;
export const IconCopy = (p: { size?: number }) => <I {...p}><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></I>;
export const IconCheck = (p: { size?: number }) => <I {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></I>;
export const IconArrow = (p: { size?: number }) => <I {...p}><path d="M5 12h14M13 6l6 6-6 6" /></I>;
export const LogoMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18h4.5v-5H13V8h7" /></svg>
);
