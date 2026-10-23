/** Small shared widgets: the wallet chip and the faction crest. */
import { formatZkLtc } from '../web3/wager';
import type { App } from './app';
import { h, icon, toast } from './dom';

/** Connect button, or address · balance · held count once connected. Keeps itself current. */
export function walletChip(app: App): HTMLElement {
  const label = h('span', { class: 'wc-label' });
  const sub = h('span', { class: 'wc-sub tabnum' });
  const chip = h('button', { class: 'wallet-chip', on: { click: () => void app.connect().catch((e: Error) => toast(e.message, 'err')) } },
    h('span', { class: 'wc-ico' }, icon('wallet')), h('span', { class: 'wc-text' }, label, sub));
  let gen = 0;
  const render = async () => {
    const my = ++gen;
    const addr = app.web3.shortAddress();
    chip.classList.toggle('on', !!addr);
    label.textContent = addr || 'Connect wallet';
    sub.textContent = addr ? `${app.web3.owned.size} held` : 'Liteforge';
    if (!addr) return;
    const bal = await app.balance().catch(() => null);
    if (my === gen && bal !== null) sub.textContent = `${formatZkLtc(bal, 3)} zkLTC · ${app.web3.owned.size} held`;
  };
  app.web3.onChange(() => void render());
  app.web3.wallet.subscribe(() => void render());
  void render();
  return chip;
}

export function crest(side: 0 | 1, cls = ''): HTMLElement {
  return h('span', { class: `crest ${side === 0 ? 'alliance' : 'horde'} ${cls}` }, icon(side === 0 ? 'alliance' : 'horde'));
}
