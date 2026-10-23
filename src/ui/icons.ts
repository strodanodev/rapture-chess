/** The UI's icon set: 24px line icons in currentColor, plus the two faction crests and the game emblem. */
const s = (body: string, extra = ''): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</svg>`;

export const ICONS = {
  play: s('<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>'),
  swords: s('<path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5 21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2"/>'),
  crown: s('<path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 11H5z"/><path d="M5 21h14"/>'),
  bag: s('<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
  trophy: s('<path d="M8 4h8v5a4 4 0 0 1-8 0zM16 5h3v2a3 3 0 0 1-3 3M8 5H5v2a3 3 0 0 0 3 3M12 13v4M8 21h8M9 17h6"/>'),
  gear: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  wallet: s('<path d="M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11v3"/><circle cx="16" cy="13.5" r="1.2" fill="currentColor"/>'),
  close: s('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: s('<path d="M15 5l-7 7 7 7"/>'),
  flip: s('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/>'),
  scroll: s('<path d="M8 3h11v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2h11v2a3 3 0 0 0 3 3M8 3a3 3 0 0 0-3 3v10M11 8h5M11 12h5"/>'),
  menu: s('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  flag: s('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  alert: s('<path d="M12 3 2 20h20zM12 10v4M12 17.5v.01"/>'),
  spark: s('<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>'),
  shield: s('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  check: s('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  coin: s('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.5 9.5h3.8a1.7 1.7 0 0 1 0 3.4h-2.6a1.7 1.7 0 0 0 0 3.4H14.5"/>'),
  grid: s('<rect x="4" y="4" width="7" height="9" rx="1"/><rect x="13" y="4" width="7" height="9" rx="1"/><rect x="4" y="15" width="7" height="5" rx="1"/><rect x="13" y="15" width="7" height="5" rx="1"/>'),
  external: s('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  user: s('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  bolt: s('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  globe: s('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  eye: s('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  stake: s('<path d="M12 3 4 7l8 4 8-4zM4 12l8 4 8-4M4 17l8 4 8-4"/>'),
  refresh: s('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  rune: s('<path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="M12 7v10M8.5 9.5 12 12l3.5-2.5"/>'),
  pause: s('<path d="M8 5v14M16 5v14"/>'),
  alliance: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M32 4 52 12v18c0 15-9 24-20 30C21 54 12 45 12 30V12z" fill="currentColor" fill-opacity=".08"/><circle cx="32" cy="28" r="7"/><path d="M32 13v6M32 37v6M17 28h6M41 28h6M21.5 17.5l4 4M38.5 34.5l4 4M42.5 17.5l-4 4M25.5 34.5l-4 4"/><path d="M22 50c3-2 6-3 10-3s7 1 10 3" stroke-width="1.6"/></svg>`,
  horde: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M32 4 52 12v18c0 15-9 24-20 30C21 54 12 45 12 30V12z" fill="currentColor" fill-opacity=".08"/><path d="M20 16c0 8 4 12 8 13M44 16c0 8-4 12-8 13"/><path d="M32 22c-5 6-6 10-6 13a6 6 0 0 0 12 0c0-3-1-7-6-13z" fill="currentColor" fill-opacity=".25"/><path d="M32 30c-2 3-2.5 4.5-2.5 6a2.5 2.5 0 0 0 5 0c0-1.5-.5-3-2.5-6z"/><path d="M22 50c3-2 6-3 10-3s7 1 10 3" stroke-width="1.6"/></svg>`,
  emblem: `<svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-linejoin="round"><circle cx="60" cy="60" r="56" stroke-width="1.2" stroke-opacity=".6"/><circle cx="60" cy="60" r="49" stroke-width="2.4"/><path d="M60 4v10M60 106v10M4 60h10M106 60h10" stroke-width="2"/><path d="M60 22 88 60 60 98 32 60z" stroke-width="2.2" fill="currentColor" fill-opacity=".07"/><path d="M47 75h26M50 70l-2-15 7 5 5-11 5 11 7-5-2 15z" stroke-width="2.4" fill="currentColor" fill-opacity=".18"/><path d="M60 32v6" stroke-width="2.4"/></svg>`,
  pack: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M32 6 54 18v28L32 58 10 46V18z"/><path d="M32 6v52M10 18l22 12 22-12" stroke-opacity=".5"/><circle cx="32" cy="30" r="6"/></svg>`,
} as const;

export type IconName = keyof typeof ICONS;
