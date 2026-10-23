/** The DOM layer: title, loading, the champion card, move list, status and controls. Dynamic strings use textContent. */
import type { Card } from '../roster';
import { ELEMENT_COLOR, PIECE_NAME, power } from '../roster';
import type { PieceType, Side } from '../rules/chessRules';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = (tag: string, cls = '', text = ''): HTMLElement => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

export interface HudHandlers {
  onPlay(side: Side): void;
  onWallet(): void;
  onNewGame(): void;
  onFlip(): void;
  onConcede(): void;
  onPromotion(piece: PieceType): void;
  onQuality(q: string): void;
}

export class Hud {
  private handlers!: HudHandlers;

  bind(h: HudHandlers): void {
    this.handlers = h;
    $('play-alliance').onclick = () => h.onPlay(0);
    $('play-horde').onclick = () => h.onPlay(1);
    for (const id of ['wallet', 'wallet-title']) $(id).onclick = () => h.onWallet();
    $('btn-new').onclick = () => h.onNewGame();
    $('btn-again').onclick = () => h.onNewGame();
    $('btn-flip').onclick = () => h.onFlip();
    $('btn-concede').onclick = () => h.onConcede();
    for (const b of $('promo').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => { $('promo').hidden = true; h.onPromotion(b.dataset.piece as PieceType); };
    for (const id of ['quality', 'quality-title']) $<HTMLSelectElement>(id).onchange = (e) => { const v = (e.target as HTMLSelectElement).value; this.setQualityChoice(v); h.onQuality(v); };
  }

  /** The realm picked on the title screen: 'auto' (by side), 'valhalla' or 'underworld'. */
  realmChoice(): string { return $<HTMLSelectElement>('realm').value; }
  setQualityChoice(v: string): void { for (const id of ['quality', 'quality-title']) $<HTMLSelectElement>(id).value = v; }
  setFps(fps: number, quality: string): void { $('fps').textContent = `${Math.round(fps)} fps · ${quality}`; }
  /** The turn clock of a relayed match: seconds left for the side to move, or null to hide it. */
  setClock(seconds: number | null, yours: boolean): void {
    const c = $('clock');
    c.hidden = seconds === null;
    if (seconds === null) return;
    c.textContent = `${yours ? 'You' : 'Opponent'} · ${Math.max(0, Math.ceil(seconds))}s`;
    c.classList.toggle('urgent', seconds < 10);
  }

  showTitle(on: boolean): void { $('title').hidden = !on; }
  showHud(on: boolean): void { $('hud').hidden = !on; }
  showOver(text: string | null, detail = ''): void {
    $('over').hidden = !text;
    if (text) { $('over-title').textContent = text; $('over-detail').textContent = detail; }
  }
  loading(text: string | null, progress = 0): void {
    const box = $('loading');
    box.hidden = !text;
    if (text) { $('loading-text').textContent = text; $<HTMLElement>('loading-bar').style.width = `${Math.round(progress * 100)}%`; }
  }
  promotion(on: boolean): void { $('promo').hidden = !on; }

  setStatus(text: string): void { $('status').textContent = text; }
  setTurn(side: Side, you: Side, over: boolean): void {
    const t = $('turn');
    t.textContent = over ? 'Game over' : side === you ? 'Your move' : side === 0 ? 'Alliance to move' : 'Horde to move';
    t.dataset.side = String(side);
  }
  setWallet(address: string, holding: number): void {
    for (const id of ['wallet', 'wallet-title']) $(id).textContent = address ? `${address} · ${holding} held` : 'Connect wallet';
    $('title-holdings').textContent = address ? (holding ? `${holding} Rapture champions in this wallet take the field first.` : 'No Rapture ARC 1 cards in this wallet yet. The armies are drawn from the full set.') : 'Connect a Liteforge wallet to field the champions you hold.';
  }

  /** The champion card for a piece: art, name, kind, element, stats. */
  showCard(card: Card | null, type: PieceType | null, held: boolean, side: Side | null): void {
    const box = $('card');
    box.hidden = !card;
    if (!card || !type) return;
    box.style.setProperty('--accent', ELEMENT_COLOR[card.element]);
    $<HTMLImageElement>('card-art').src = `${import.meta.env.BASE_URL}art/${card.slug}.webp`;
    $<HTMLImageElement>('card-art').alt = card.name;
    $('card-name').textContent = card.name;
    $('card-epithet').textContent = card.epithet;
    $('card-role').textContent = `${PIECE_NAME[type]} · ${card.kind} · ${card.element} · ${side === 0 ? 'Alliance' : 'Horde'}`;
    $('card-held').hidden = !held;
    const stats = $('card-stats');
    stats.replaceChildren();
    const max = 52000;
    for (const [k, label] of [['str', 'STR'], ['agi', 'AGI'], ['res', 'RES'], ['int', 'INT']] as const) {
      const row = el('div', 'stat');
      row.append(el('span', 'k', label));
      const bar = el('div', 'bar'); const fill = el('div', 'fill'); fill.style.width = `${(card.stats[k] / max) * 100}%`; bar.append(fill);
      row.append(bar, el('span', 'v', card.stats[k].toLocaleString()));
      stats.append(row);
    }
    $('card-power').textContent = `Power ${power(card).toLocaleString()} · token ${card.tokenId}`;
  }

  setMoves(sans: string[]): void {
    const list = $('moves');
    list.replaceChildren();
    for (let i = 0; i < sans.length; i += 2) {
      const row = el('div', 'mv');
      row.append(el('span', 'n', `${i / 2 + 1}.`), el('span', 'w', sans[i]), el('span', 'b', sans[i + 1] ?? ''));
      list.append(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  /** The captured champions, small, per side. */
  setCaptured(side: Side, cards: Card[]): void {
    const box = $(side === 0 ? 'fallen-alliance' : 'fallen-horde');
    box.replaceChildren();
    for (const c of cards) {
      const img = document.createElement('img');
      img.src = `${import.meta.env.BASE_URL}art/${c.slug}.webp`; img.alt = c.name; img.title = c.name;
      img.style.setProperty('--accent', ELEMENT_COLOR[c.element]);
      box.append(img);
    }
  }

  toast(text: string): void {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }
}
