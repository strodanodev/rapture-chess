/**
 * The Shop: the live Rapture ARC 1 booster from PackShop on Liteforge. Buy, wait for the reveal block, open, and
 * watch the five champions turn over. Sealed packs from an earlier visit can be opened (or refunded once expired).
 */
import type { Card } from '../../roster';
import { formatZkLtc } from '../../web3/wager';
import { KIND_ORDER, PACKSHOP, Phase, buyPack, openPack, packsLeftToday, readShop, recentPacks, refundPack, shopMessage, type PackRef, type ShopConfig } from '../../web3/packshop';
import { EXPLORER, type App } from '../app';
import { cardBack, championCard, RARITY } from '../cardview';
import { embers, h, icon, toast } from '../dom';
import { go, pageHead, type Screen } from '../router';
import { walletChip } from '../widgets';
import { emblem } from '../brand';

const KIND_VAR: Record<string, string> = { God: '--r-god', Titan: '--r-titan', King: '--r-king', Demigod: '--r-demigod', Mortal: '--r-mortal' };

export function shopScreen(app: App): Screen {
  const CACHE = 'rapture-chess.shop.v1';
  let cfg: ShopConfig | null = (() => { try { const j = JSON.parse(localStorage.getItem(CACHE) ?? 'null'); return j ? { ...j, price: BigInt(j.price) } : null; } catch { return null; } })();
  let left: number | null = null;
  let sealed: PackRef[] = [];
  let working = false;

  const price = h('div', { class: 'price' });
  const meta = h('div', { class: 'pack-meta' });
  const odds = h('div', { class: 'odds' });
  const status = h('div', { class: 'shop-status', aria: { live: 'polite' } });
  const actions = h('div', { class: 'shop-actions' });
  const sealedBox = h('div', { class: 'sealed' });

  const pack = h('div', { class: 'pack3d', aria: { hidden: 'true' } },
    h('div', { class: 'pack-face' },
      h('div', { class: 'pack-foil' }),
      h('div', { class: 'pack-emblem' }, emblem()),
      h('div', { class: 'pack-title' }, h('span', { class: 'gilded', text: 'Rapture' }), h('small', { text: 'ARC 1 · Booster' })),
      h('div', { class: 'pack-count', text: '5 champions' })));

  const stage = (text: string, spin = true) => {
    status.replaceChildren(spin ? h('span', { class: 'spinner' }) : icon('check'), h('span', { text }));
    status.hidden = false;
  };

  const render = () => {
    const addr = app.web3.wallet.snapshot().address;
    price.replaceChildren(icon('coin'), h('span', { class: 'tabnum', text: cfg ? formatZkLtc(cfg.price, 4) : '…' }), h('small', { text: 'zkLTC' }));
    meta.replaceChildren(
      h('span', { class: 'chip' }, icon('grid'), `${cfg?.packSize ?? 5} champions per pack`),
      h('span', { class: 'chip' }, icon('shield'), cfg ? `${cfg.templates} designs in the pool` : 'Rapture ARC 1'),
      h('span', { class: 'chip' }, icon('bolt'), left === null ? `${cfg?.dailyLimit || '∞'} packs a day` : left === Infinity ? 'No daily limit' : `${left} of ${cfg?.dailyLimit} left today`));
    const total = cfg ? cfg.weights.reduce((a, b) => a + b, 0) : 0;
    odds.replaceChildren(h('span', { class: 'eyebrow', text: 'Odds per card' }), ...[...KIND_ORDER].reverse().map((k) => {
      const w = cfg ? cfg.weights[KIND_ORDER.indexOf(k)] : 0;
      const pct = total ? Math.round((w / total) * 100) : 0;
      return h('div', { class: 'odd', style: `--accent:var(${KIND_VAR[k]})` }, h('span', { class: 'k', text: `${k} · ${RARITY[k]}` }), h('div', { class: 'meter' }, h('i', { style: `--v:${pct}%` })), h('span', { class: 'v tabnum', text: `${pct}%` }));
    }));
    let closed = '';
    if (cfg && (cfg.paused || !cfg.ready)) closed = 'The forge is closed right now.';
    else if (left === 0) closed = 'You have opened today\'s packs. Come back after midnight UTC.';
    const buy = h('button', { class: 'btn primary lg pulse', disabled: working || !!closed || !cfg, on: { click: () => void doBuy() } }, icon('bag'), cfg ? `Buy pack · ${formatZkLtc(cfg.price, 4)} zkLTC` : 'Buy pack');
    actions.replaceChildren(addr ? buy : h('button', { class: 'btn primary lg', on: { click: () => void app.connect().catch((e: Error) => toast(e.message, 'err')) } }, icon('wallet'), 'Connect wallet to buy'),
      closed ? h('p', { class: 'hint', text: closed }) : h('p', { class: 'hint', text: 'Cards mint straight to your wallet and join your armies at once: held champions are seated first.' }));
    sealedBox.replaceChildren(...sealed.map((p) => h('div', { class: 'sealed-row' },
      icon('pack'), h('span', { text: `Pack #${p.id} · ${p.phase === Phase.Expired ? 'expired, refundable' : 'sealed'}` }),
      p.phase === Phase.Expired
        ? h('button', { class: 'btn sm ghost', disabled: working, on: { click: () => void doRefund(p.id) } }, 'Refund')
        : h('button', { class: 'btn sm', disabled: working, on: { click: () => void doOpen(p.id) } }, 'Open'))));
    sealedBox.hidden = !sealed.length;
  };

  async function load(): Promise<void> {
    try {
      const addr = app.web3.wallet.snapshot().address;
      const [c, l, packs] = await Promise.all([readShop(app.chain), addr ? packsLeftToday(app.chain, addr).catch(() => null) : null, addr ? recentPacks(app.chain, addr).catch(() => []) : []]);
      cfg = c; left = l; sealed = packs.filter((p) => p.phase === Phase.Waiting || p.phase === Phase.Openable || p.phase === Phase.Expired);
      try { localStorage.setItem(CACHE, JSON.stringify({ ...c, price: c.price.toString() })); } catch { /* private mode */ }
      if (!working) status.hidden = true;
    } catch {
      status.replaceChildren(icon('alert'), h('span', { text: 'Liteforge is busy right now. The prices shown may be from your last visit.' }), h('button', { class: 'btn sm ghost', on: { click: () => { status.hidden = true; void load(); } } }, icon('refresh'), 'Retry'));
      status.hidden = false;
    }
    render();
  }

  async function doBuy(): Promise<void> {
    if (working || !cfg) return;
    working = true; render();
    pack.classList.add('charging');
    try {
      const id = await buyPack(app.web3.wallet, app.chain, cfg.price, (s) => stage(s));
      await doOpen(id, true);
    } catch (e) { toast((e as Error).message, 'err'); status.hidden = true; }
    pack.classList.remove('charging');
    working = false;
    void load();
  }

  async function doOpen(id: bigint, chained = false): Promise<void> {
    if (working && !chained) return;
    working = true; render();
    pack.classList.add('charging');
    try {
      const tokens = await openPack(app.web3.wallet, app.chain, id, (s) => stage(s));
      stage('Your champions have arrived', false);
      const cards = await app.web3.identify(tokens).catch(() => [] as Card[]);
      void app.web3.refresh();
      reveal(cards, tokens.length);
    } catch (e) { toast(shopMessage(e), 'err'); status.hidden = true; }
    pack.classList.remove('charging');
    if (!chained) { working = false; void load(); }
  }

  async function doRefund(id: bigint): Promise<void> {
    working = true; render();
    try { stage('Refunding the pack'); await refundPack(app.web3.wallet, app.chain, id); stage('Refunded', false); } catch (e) { toast(shopMessage(e), 'err'); }
    working = false; void load();
  }

  /** The reveal: face-down cards fan out, then turn over one by one. */
  function reveal(cards: Card[], minted: number): void {
    const n = Math.max(cards.length, minted, 1);
    const slots = Array.from({ length: n }, (_, i) => {
      const c = cards[i];
      const front = c ? championCard(c, { owned: true, eager: true }) : h('div', { class: 'ccard' }, h('div', { class: 'inner unknown' }, h('span', { text: 'New champion' })));
      const flip = h('button', { class: 'flip', style: `--i:${i}`, data: { kind: c?.kind ?? 'Mortal' }, aria: { label: c ? `Reveal card ${i + 1}` : 'Card' } },
        h('div', { class: 'flip-inner' }, h('div', { class: 'flip-back' }, cardBack()), h('div', { class: 'flip-front' }, front)));
      flip.addEventListener('click', () => flip.classList.add('shown'));
      return flip;
    });
    const all = h('button', { class: 'btn primary', on: { click: () => slots.forEach((s, i) => setTimeout(() => s.classList.add('shown'), i * 220)) } }, icon('eye'), 'Reveal all');
    const done = h('button', { class: 'btn ghost', on: { click: () => { overlay.remove(); void go('armory'); } } }, icon('grid'), 'To the Armory');
    const close = h('button', { class: 'btn ghost', on: { click: () => overlay.remove() } }, 'Close');
    const best = cards.reduce<Card | null>((b, c) => (!b || KIND_ORDER.indexOf(c.kind) > KIND_ORDER.indexOf(b.kind) ? c : b), null);
    const overlay = h('div', { class: 'reveal' },
      embers(22, ['#ffe2a0', '#ffc95e', '#c58bff']),
      h('div', { class: 'reveal-rays' }),
      h('div', { class: 'reveal-head' }, h('span', { class: 'kicker', text: 'Pack opened' }), h('h2', { class: 'display gilded', text: best ? `${RARITY[best.kind]} pull` : 'New champions' })),
      h('div', { class: 'reveal-fan' }, ...slots),
      h('div', { class: 'reveal-actions' }, all, done, close));
    document.body.append(overlay);
    setTimeout(() => slots[0]?.focus(), 900);
  }

  app.web3.wallet.subscribe(() => { if (!el.hidden) void load(); });

  const el = h('section', { class: 'page shop' }, pageHead('Shop', 'The Forge', walletChip(app)),
    h('div', { class: 'page-body shop-body' },
      h('div', { class: 'shop-hero panel frame' },
        embers(10, ['#ffc95e', '#ffe2a0']),
        h('div', { class: 'pack-stage' }, h('div', { class: 'pack-glow' }), pack),
        h('div', { class: 'shop-info' },
          h('span', { class: 'badge live', style: 'justify-self:start', text: 'Live on Liteforge' }),
          h('h2', { class: 'display', text: 'Rapture ARC 1 Booster' }),
          h('p', { class: 'lede', text: 'Five sealed champions, drawn on chain. Gods, Titans, Kings, Demigods and Mortals: every card you hold takes the field first in your armies.' }),
          price, meta, actions, status, sealedBox)),
      h('div', { class: 'shop-side panel soft' }, h('div', { class: 'panel-body' }, odds,
        h('hr', { class: 'rule' }),
        h('p', { class: 'hint plain' }, 'Drawn from the blockhash after your purchase by ', h('a', { href: `${EXPLORER}/address/${PACKSHOP}`, target: '_blank', rel: 'noopener', text: 'PackShop' }), ' on Liteforge. Testnet zkLTC only.'),
        h('button', { class: 'link-btn', on: { click: () => void go('armory') } }, icon('grid'), 'Browse all fifty champions')))));
  status.hidden = true;
  return { id: 'shop', el, opaque: true, enter() { render(); void load(); } };
}
