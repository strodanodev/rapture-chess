/**
 * Chess glyphs for the role marks, drawn for this game on a 40-unit grid. Each glyph is one path of separate parts
 * (head, collar, body, base) filled with --f; the stroke is --o painted under the fill, so it shows as a halo round
 * the silhouette and as the thin seams between the parts. Details (the bishop's slit, the knight's eye) are in --o.
 */
import type { PieceType } from '../rules/chessRules';

const BASE = 'M9 32.5h22v4H9z';
const svg = (parts: string, detail = ''): string =>
  `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="${parts} ${BASE}" fill="var(--f)" stroke="var(--o)" stroke-width="3.2" stroke-linejoin="round" paint-order="stroke"/>${detail}</svg>`;
const dot = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const GLYPH: Record<PieceType, string> = {
  p: svg(`${dot(20, 11, 5)} M14.5 17.5h11V20h-11z M16 21h8l3.5 10.5h-15z`),
  r: svg('M11 7h4v3h3.25V7h3.5v3H25V7h4v7H11z M13 15h14l1.2 16.5H11.8z'),
  b: svg(`${dot(20, 6.5, 2.5)} M20 10c4.8 3.2 7 7.6 5.6 12.5H14.4C13 17.6 15.2 13.2 20 10z M14 23.5h12V26H14z M15.5 27h9l2.8 4.5H12.7z`,
    '<path d="M22.6 13.6l-4.4 5.4" stroke="var(--o)" stroke-width="1.7" stroke-linecap="round"/>'),
  n: svg('M28 31.5C28.6 25 28.6 18 25.4 13.3L26.3 7l-3.7 3.3C17.2 9.9 12.7 13.6 10.8 18.9L9.2 23.2C8.8 24.5 9.9 25.8 11.2 25.6L16.4 24C17.8 23.7 18.6 25 17.8 26.1C15.4 28.6 13.6 30.2 13 31.5z',
    `<path d="${dot(16.4, 15.4, 1.35)}" fill="var(--o)"/>`),
  q: svg(`M13 25.5L9 13.5l5.4 6.5.2-9.5L18 18.6l2-9.8 2 9.8 3.4-8.1.2 9.5 5.4-6.5-4 12z ${dot(9, 10.8, 1.8)} ${dot(14.6, 7.8, 1.8)} ${dot(20, 6.1, 1.8)} ${dot(25.4, 7.8, 1.8)} ${dot(31, 10.8, 1.8)} M13 26.5h14l.9 5H12.1z`),
  k: svg('M18.6 3h2.8v2.6H24v2.8h-2.6V11h-2.8V8.4H16V5.6h2.6z M20 13c1-1.3 2.4-2 4-2 4.4 0 6.6 4.8 3.6 13.5H12.4C9.4 15.8 11.6 11 16 11c1.6 0 3 .7 4 2z M12.6 25.5h14.8l.8 6H11.8z'),
};
