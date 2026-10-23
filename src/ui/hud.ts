/**
 * The match screen's DOM layer: a plate per player (crest, name, spoils, material, clock), the turn medallion, the
 * champion inspector, the chronicle of moves, the action dock, cinematic banners and screen flashes, the kill feed,
 * the promotion picker, the battle menu and the result screen. Dynamic strings use textContent.
 *
 * Nothing here runs per frame except setClock, which only touches the DOM when the shown second changes.
 */
import type { Card } from '../roster';
import { ELEMENT_COLOR, PIECE_NAME } from '../roster';
import type { PieceType, Side } from '../rules/chessRules';
import { ART, championCard, statRows } from './cardview';
import { embers, h, icon, stagger } from './dom';
import { prefs, setPref } from './prefs';
import type { Screen } from './router';
import { crest } from './widgets';

export interface Fallen { card: Card; type: PieceType }
export interface ResultInfo {
  outcome: 'win' | 'loss' | 'draw';
  title: string;
  detail: string;
  stats: Array<[string, string]>;
  mvp: { card: Card; kills: number } | null;
  footnote?: string;
  relay: boolean;
}
export interface HudHandlers {
  onFlip(): void;
  onConcede(): void;
  onPromotion(piece: PieceType): void;
  onLeave(): void;
  onRematch(): void;
  onStakes(): void;
  onQuality(q: string): void;
  /** Draw offers (rules v2 relayed matches): whether an offer would take effect now, and the three words. */
  canOfferDraw(): boolean;
  onOfferDraw(): void;
  onAcceptDraw(): void;
  onDeclineDraw(): void;
}
/** Both clocks as the relay reports them (see RelayClock in game/relay.ts). */
export interface ClockView { side: Side; deadline: number; left: [number, number]; timed: boolean; firstMove: boolean }
const mmss = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const QUALITIES: Array<[string, string]> = [['auto', 'Auto'], ['lite', 'Lite'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']];

class Plate {
  readonly el: HTMLElement;
  private readonly name = h('span', { class: 'pl-name' });
  private readonly sub = h('span', { class: 'pl-sub' });
  private readonly spoils = h('span', { class: 'pl-spoils' });
  private readonly mat = h('span', { class: 'pl-mat tabnum' });
  readonly clock = h('span', { class: 'pl-clock tabnum', hidden: true });
  private readonly think = h('span', { class: 'pl-think', hidden: true }, h('i'), h('i'), h('i'));
  constructor(readonly pos: 'top' | 'bottom') {
    this.el = h('div', { class: `plate ${pos}` },
      h('span', { class: 'pl-crest' }),
      h('div', { class: 'pl-id' }, this.name, this.sub),
      h('div', { class: 'pl-right' }, h('div', { class: 'pl-tally' }, this.spoils, this.mat), this.think, this.clock));
  }
  set(side: Side, name: string, sub: string): void {
    this.el.dataset.side = String(side);
    this.el.querySelector('.pl-crest')!.replaceChildren(crest(side));
    this.name.textContent = name;
    this.sub.textContent = sub;
  }
  showClock(text: string | null, running: boolean, urgent: boolean): void {
    this.clock.hidden = text === null;
    if (text === null) return;
    this.clock.textContent = text;
    this.clock.classList.toggle('running', running);
    this.clock.classList.toggle('urgent', urgent);
  }
  active(on: boolean, thinking: boolean): void { this.el.classList.toggle('active', on); this.think.hidden = !(on && thinking); }
  tally(taken: Fallen[], lost: Fallen[]): void {
    this.spoils.replaceChildren(...taken.slice(-7).map((f) => {
      const i = h('img', { alt: f.card.name, title: f.card.name, decoding: 'async' });
      i.src = ART(f.card.slug);
      i.style.setProperty('--el', ELEMENT_COLOR[f.card.element]);
      return i;
    }));
    if (taken.length > 7) this.spoils.append(h('span', { class: 'more', text: `+${taken.length - 7}` }));
    const diff = taken.reduce((a, f) => a + VALUE[f.type], 0) - lost.reduce((a, f) => a + VALUE[f.type], 0);
    this.mat.textContent = diff > 0 ? `+${diff}` : '';
  }
}

export class Hud {
  private handlers!: HudHandlers;
  readonly el: HTMLElement;
  private readonly top = new Plate('top');
  private readonly bottom = new Plate('bottom');
  private you: Side = 0;
  private readonly medallion = h('div', { class: 'medallion', aria: { live: 'polite' } });
  private readonly medText = h('span', { class: 'md-text' });
  private readonly status = h('p', { class: 'hud-status' });
  private readonly drawBar = h('div', { class: 'draw-bar', hidden: true, role: 'status' });
  private readonly inspect = h('aside', { class: 'inspect', hidden: true });
  private readonly chronicle = h('aside', { class: 'chronicle panel soft' });
  private readonly moves = h('ol', { class: 'moves tabnum' });
  private readonly feed = h('div', { class: 'killfeed', aria: { live: 'polite' } });
  private readonly banner = h('div', { class: 'cine', aria: { hidden: 'true' } });
  private readonly fx = h('div', { class: 'screen-fx', aria: { hidden: 'true' } });
  private readonly promo = h('div', { class: 'promo panel frame', hidden: true, role: 'dialog', aria: { label: 'Choose a promotion' } });
  private readonly pauseEl = h('div', { class: 'pause', hidden: true, role: 'dialog', aria: { modal: 'true', label: 'Battle menu' } });
  private readonly result = h('div', { class: 'result', hidden: true, role: 'dialog', aria: { label: 'Match result' } });
  private readonly fps = h('span', { class: 'fps-chip tabnum', hidden: true });
  private readonly stakesBtn: HTMLButtonElement;
  private readonly chronBtn: HTMLButtonElement;
  private clockShown = '';
  private relay = false;

  constructor() {
    this.medallion.append(h('span', { class: 'md-ring' }), this.medText);
    this.chronicle.append(h('div', { class: 'panel-head' }, icon('scroll'), h('h3', { text: 'Chronicle' })), this.moves);
    this.chronBtn = h('button', { class: 'icon-btn', title: 'Chronicle (M)', aria: { label: 'Chronicle' }, on: { click: () => this.toggleChronicle() } }, icon('scroll'));
    this.stakesBtn = h('button', { class: 'icon-btn', title: 'Stakes', aria: { label: 'Stakes' }, hidden: true, on: { click: () => this.handlers.onStakes() } }, icon('stake'));
    const dock = h('nav', { class: 'dock', aria: { label: 'Match controls' } },
      this.chronBtn,
      h('button', { class: 'icon-btn', title: 'Flip view (F)', aria: { label: 'Flip view' }, on: { click: () => this.handlers.onFlip() } }, icon('flip')),
      this.stakesBtn,
      h('button', { class: 'icon-btn', title: 'Battle menu (Esc)', aria: { label: 'Battle menu' }, on: { click: () => this.pause(true) } }, icon('menu')));
    this.el = h('section', { class: 'match', aria: { label: 'Match' } },
      this.fx, this.top.el, h('div', { class: 'hud-center' }, this.medallion, this.status), this.drawBar, this.inspect, this.chronicle, this.feed,
      this.bottom.el, dock, this.fps, this.banner, this.promo, this.pauseEl, this.result);
    const narrow = matchMedia('(max-width: 900px)').matches;
    this.chronicle.classList.toggle('closed', narrow);
    this.chronBtn.classList.toggle('on', !narrow);
  }

  screen(): Screen { return { id: 'match', el: this.el }; }

  bind(handlers: HudHandlers): void {
    this.handlers = handlers;
    this.promo.replaceChildren(h('span', { class: 'eyebrow', text: 'Ascend as' }), h('div', { class: 'promo-row' }, ...(['q', 'r', 'b', 'n'] as PieceType[]).map((p) =>
      h('button', { class: 'promo-btn', on: { click: () => { this.promo.hidden = true; handlers.onPromotion(p); } } },
        h('b', { class: 'display', text: PIECE_NAME[p] }), h('span', { text: p === 'q' ? 'God' : p === 'r' ? 'Titan' : p === 'b' ? 'King' : 'Demigod' })))));
  }

  // ------------------------------------------------------------------ players and turn
  setPlayers(you: Side, names: [string, string], subs: [string, string], relay: boolean): void {
    this.you = you;
    this.relay = relay;
    const opp: Side = you === 0 ? 1 : 0;
    this.bottom.set(you, names[you], subs[you]);
    this.top.set(opp, names[opp], subs[opp]);
    this.stakesBtn.hidden = !relay;
    this.el.dataset.you = String(you);
    this.clockShown = '';
  }
  setTurn(side: Side, over: boolean, thinking = false): void {
    const yours = side === this.you;
    this.bottom.active(!over && yours, false);
    this.top.active(!over && !yours, thinking);
    this.medallion.dataset.side = String(side);
    this.medallion.classList.toggle('yours', !over && yours);
    this.medText.textContent = over ? 'Battle over' : yours ? 'Your move' : side === 0 ? 'Alliance moves' : 'Horde moves';
  }
  setStatus(text: string): void { this.status.textContent = text; }
  /** Both clocks: the side to move counts down to `deadline`; in a timed game the other shows what it has left.
   *  Before each side's first move (and in v1) only the mover's window shows. Touches the DOM only when a second changes. */
  setClocks(c: ClockView | null): void {
    const plate = (side: Side) => (side === this.you ? this.bottom : this.top);
    if (!c) {
      if (this.clockShown === '') return;
      this.clockShown = '';
      this.top.showClock(null, false, false); this.bottom.showClock(null, false, false);
      return;
    }
    const other: Side = c.side === 0 ? 1 : 0;
    const run = c.deadline - Date.now();
    const runText = c.firstMove ? `First ${mmss(run)}` : mmss(run);
    const restText = c.timed && !c.firstMove ? mmss(c.left[other]) : null;
    const key = `${c.side}|${runText}|${restText}`;
    if (key === this.clockShown) return;
    this.clockShown = key;
    plate(c.side).showClock(runText, true, run < 10_000);
    plate(other).showClock(restText, false, false);
  }

  /** The draw-offer bar: the opponent's standing offer (accept / decline) or your own (waiting). */
  setDraw(offer: -1 | 0 | 1, enabled: boolean): void {
    if (!enabled || offer === -1) { this.drawBar.hidden = true; return; }
    if (offer === this.you) {
      this.drawBar.replaceChildren(icon('shield'), h('span', { text: 'Draw offered. Waiting for your opponent.' }));
    } else {
      this.drawBar.replaceChildren(icon('shield'), h('span', { text: 'Your opponent offers a draw' }),
        h('button', { class: 'btn sm primary', on: { click: () => this.handlers.onAcceptDraw() } }, 'Accept'),
        h('button', { class: 'btn sm ghost', on: { click: () => this.handlers.onDeclineDraw() } }, 'Decline'));
    }
    this.drawBar.hidden = false;
  }
  /** fallen[side] = that side's champions that have fallen. */
  setFallen(fallen: [Fallen[], Fallen[]]): void {
    const opp: Side = this.you === 0 ? 1 : 0;
    this.bottom.tally(fallen[opp], fallen[this.you]);
    this.top.tally(fallen[this.you], fallen[opp]);
  }

  // ------------------------------------------------------------------ the inspector
  showCard(card: Card | null, type: PieceType | null, held: boolean, side: Side | null): void {
    if (!card || !type) { this.inspect.hidden = true; return; }
    this.inspect.hidden = false;
    this.inspect.style.setProperty('--accent', ELEMENT_COLOR[card.element]);
    this.inspect.replaceChildren(
      h('div', { class: 'ins-card' }, championCard(card, { owned: held, type, eager: true })),
      h('div', { class: 'ins-body' },
        h('div', { class: 'ins-head' }, h('b', { class: 'display', text: card.name }), held ? h('span', { class: 'badge', text: 'Held' }) : null),
        h('p', { class: 'epithet', text: card.epithet }),
        h('p', { class: 'eyebrow', text: `${PIECE_NAME[type]} · ${card.kind} · ${card.element} · ${side === 0 ? 'Alliance' : 'Horde'}` }),
        statRows(card)));
    this.inspect.classList.remove('pop'); void this.inspect.offsetWidth; this.inspect.classList.add('pop');
  }

  setMoves(sans: string[]): void {
    const rows: HTMLElement[] = [];
    for (let i = 0; i < sans.length; i += 2) rows.push(h('li', null, h('span', { class: 'n', text: `${i / 2 + 1}` }), h('span', { class: 'w', text: sans[i] }), h('span', { class: 'b', text: sans[i + 1] ?? '' })));
    this.moves.replaceChildren(...rows);
    this.moves.lastElementChild?.classList.add('last');
    this.moves.scrollTop = this.moves.scrollHeight;
  }
  toggleChronicle(): void { this.chronicle.classList.toggle('closed'); this.chronBtn.classList.toggle('on', !this.chronicle.classList.contains('closed')); }

  promotion(on: boolean): void { this.promo.hidden = !on; }

  // ------------------------------------------------------------------ cinematics
  /** A banner across the middle of the screen. */
  cine(title: string, kind: 'gold' | 'red' | 'ice' = 'gold', sub = ''): void {
    if (prefs.still && kind === 'gold' && !sub) return;
    this.banner.dataset.kind = kind;
    this.banner.replaceChildren(...[h('i', { class: 'cine-line' }), h('b', { class: 'display', text: title }), sub ? h('span', { text: sub }) : null, h('i', { class: 'cine-line' })].filter((x): x is HTMLElement => !!x));
    this.banner.classList.remove('show'); void this.banner.offsetWidth; this.banner.classList.add('show');
  }
  flash(kind: 'check' | 'capture' | 'victory' | 'defeat'): void {
    const f = h('i', { class: `fx-${kind}` });
    this.fx.append(f);
    setTimeout(() => f.remove(), 1600);
  }
  kill(mover: Card | null, victim: Card): void {
    const img = (c: Card) => { const i = h('img', { alt: '', decoding: 'async' }); i.src = ART(c.slug); i.style.setProperty('--el', ELEMENT_COLOR[c.element]); return i; };
    const row = h('div', { class: 'kf' }, mover ? img(mover) : null, icon('swords'), img(victim),
      h('span', null, h('b', { text: mover?.name ?? 'The enemy' }), ' slays ', h('b', { text: victim.name })));
    this.feed.prepend(row);
    while (this.feed.children.length > 3) this.feed.lastElementChild!.remove();
    setTimeout(() => row.classList.add('gone'), 4200);
    setTimeout(() => row.remove(), 4700);
  }

  setFps(fps: number, quality: string): void { if (!this.fps.hidden) this.fps.textContent = `${Math.round(fps)} fps · ${quality}`; }
  showFps(on: boolean): void { this.fps.hidden = !on; }

  // ------------------------------------------------------------------ battle menu
  isPaused(): boolean { return !this.pauseEl.hidden; }
  pause(on: boolean): void {
    if (!on) { this.pauseEl.hidden = true; return; }
    const qseg = h('div', { class: 'seg q5' }, ...QUALITIES.map(([v, label]) => h('button', { class: prefs.quality === v ? 'on' : '', text: label, on: { click: () => { prefs.quality = v; this.handlers.onQuality(v); this.pause(true); } } })));
    let confirming = false;
    const concedeLabel = h('span', { text: 'Concede' });
    const concede = h('button', { class: 'btn danger block', on: { click: () => {
      if (!confirming) { confirming = true; concedeLabel.textContent = 'Tap again to concede'; return; }
      this.pause(false); this.handlers.onConcede();
    } } }, icon('flag'), concedeLabel);
    const fpsT = h('button', { class: 'toggle', role: 'switch', aria: { checked: String(prefs.showFps), label: 'Frame rate readout' }, on: { click: () => { setPref('showFps', !prefs.showFps); this.showFps(prefs.showFps); this.pause(true); } } });
    this.pauseEl.replaceChildren(h('div', { class: 'pause-panel panel frame' },
      h('div', { class: 'panel-head' }, icon('pause'), h('h2', { text: 'Battle menu' })),
      stagger(h('div', { class: 'panel-body pause-body' },
        h('button', { class: 'btn primary block', on: { click: () => this.pause(false) } }, icon('play'), 'Resume'),
        h('button', { class: 'btn block', on: { click: () => { this.pause(false); this.handlers.onFlip(); } } }, icon('flip'), 'Flip view'),
        this.relay ? h('button', { class: 'btn block', on: { click: () => { this.pause(false); this.handlers.onStakes(); } } }, icon('stake'), 'Stakes') : null,
        this.handlers.canOfferDraw() ? h('button', { class: 'btn block', on: { click: () => { this.pause(false); this.handlers.onOfferDraw(); } } }, icon('shield'), 'Offer a draw') : null,
        h('div', { class: 'field' }, h('span', { text: 'Graphics' }), qseg),
        h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', { text: 'Frame rate readout' })), fpsT),
        h('hr', { class: 'rule' }),
        concede,
        h('button', { class: 'btn ghost block', on: { click: () => { this.pause(false); this.handlers.onLeave(); } } }, icon('back'), this.relay ? 'Leave the table' : 'Main menu')))));
    this.pauseEl.hidden = false;
  }

  // ------------------------------------------------------------------ result
  showResult(r: ResultInfo | null): void {
    if (!r) { this.result.hidden = true; return; }
    const stats = h('div', { class: 'res-stats' }, ...r.stats.map(([k, v]) => h('div', null, h('b', { class: 'tabnum', text: v }), h('span', { text: k }))));
    const mvp = r.mvp ? h('div', { class: 'res-mvp' }, h('div', { class: 'res-mvp-card' }, championCard(r.mvp.card, { eager: true })),
      h('div', null, h('span', { class: 'eyebrow', text: 'Champion of the battle' }), h('b', { class: 'display', text: r.mvp.card.name }), h('span', { class: 'hint', text: r.mvp.kills === 1 ? '1 foe slain' : `${r.mvp.kills} foes slain` }))) : null;
    this.result.dataset.outcome = r.outcome;
    this.result.replaceChildren(
      h('div', { class: 'res-rays' }),
      r.outcome === 'win' ? embers(26, ['#ffe2a0', '#ffc95e', '#fff4d2']) : embers(14, r.outcome === 'loss' ? ['#ff4b3a', '#ff7438'] : ['#8fd0ff', '#dff1ff']),
      stagger(h('div', { class: 'res-inner' },
        h('div', { class: 'res-emblem' }, icon(r.outcome === 'loss' ? 'shield' : 'crown')),
        h('h1', { class: 'res-title display', text: r.title }),
        h('p', { class: 'res-detail', text: r.detail }),
        stats,
        mvp,
        r.footnote ? h('p', { class: 'hint', text: r.footnote }) : null,
        h('div', { class: 'res-actions' },
          r.relay ? h('button', { class: 'btn primary', on: { click: () => this.handlers.onStakes() } }, icon('stake'), 'Stakes and claim')
            : h('button', { class: 'btn primary pulse', on: { click: () => this.handlers.onRematch() } }, icon('swords'), 'Rematch'),
          h('button', { class: 'btn ghost', on: { click: () => this.handlers.onLeave() } }, icon('back'), 'Main menu'))), 350));
    this.result.hidden = false;
  }
}
