/** Settings: graphics preset, the fps readout, reduced motion, the default battlefield, the wallet, and the contracts. */
import { CHESS_RULESET_ID } from '../../web3/wager';
import { PACKSHOP } from '../../web3/packshop';
import { EXPLORER, type App } from '../app';
import { h, icon, toast } from '../dom';
import { prefs, setPref, type RealmChoice } from '../prefs';
import { pageHead, type Screen } from '../router';

const QUALITY: Array<[string, string, string]> = [
  ['auto', 'Auto', 'Holds 60 fps: steps the preset down when frames drop and back up when there is headroom.'],
  ['lite', 'Lite', 'Three-quarter resolution and no shadows. For the weakest phones.'],
  ['low', 'Low', 'Native resolution, no mirror floor or ambient occlusion. For older phones.'],
  ['medium', 'Medium', 'Sharper, with bloom. The phone default.'],
  ['high', 'High', 'Ambient occlusion and a mirror floor. The desktop default.'],
  ['ultra', 'Ultra', 'Full resolution, large bloom, sharp reflections.'],
];

export function settingsScreen(app: App): Screen {
  const body = h('div', { class: 'settings-list' });
  const row = (title: string, desc: string, control: HTMLElement) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', { text: title }), h('span', { text: desc })), control);
  const toggle = (on: boolean, flip: () => void) => h('button', { class: 'toggle', role: 'switch', aria: { checked: String(on) }, on: { click: () => { flip(); render(); } } });

  const render = () => {
    const q = QUALITY.find((x) => x[0] === prefs.quality) ?? QUALITY[0];
    const qseg = h('div', { class: 'seg q5' }, ...QUALITY.map(([v, label]) => h('button', { class: prefs.quality === v ? 'on' : '', text: label, on: { click: () => { prefs.quality = v; app.setQuality(v); render(); } } })));
    const realms: Array<[RealmChoice, string]> = [['auto', 'By banner'], ['valhalla', 'Valhalla'], ['underworld', 'Underworld']];
    const addr = app.web3.wallet.snapshot().address;
    body.replaceChildren(
      h('h3', { class: 'set-group', text: 'Graphics' }),
      h('div', { class: 'set-row col' }, h('div', { class: 'set-text' }, h('b', { text: 'Quality' }), h('span', { text: q[2] })), qseg),
      row('Frame rate readout', 'Show frames per second and the live preset during a match.', toggle(prefs.showFps, () => setPref('showFps', !prefs.showFps))),
      row('Reduce motion', 'Calmer menus: no drifting embers, banner sweeps or camera shake.', toggle(prefs.still, () => setPref('still', !prefs.still))),
      h('h3', { class: 'set-group', text: 'Battle' }),
      h('div', { class: 'set-row col' }, h('div', { class: 'set-text' }, h('b', { text: 'Default battlefield' }), h('span', { text: 'By banner: Alliance fights in Valhalla, Horde in the Underworld.' })),
        h('div', { class: 'seg' }, ...realms.map(([v, label]) => h('button', { class: prefs.realm === v ? 'on' : '', text: label, on: { click: () => { setPref('realm', v); render(); } } })))),
      h('h3', { class: 'set-group', text: 'Wallet' }),
      row(addr ? app.web3.shortAddress() : 'Not connected', addr ? 'Liteforge testnet. Held Rapture champions are seated first.' : 'Connect a Liteforge wallet to field your champions, buy packs and stake.',
        h('button', { class: `btn sm${addr ? ' ghost' : ' primary'}`, on: { click: () => void app.web3.toggle().then(render).catch((e: Error) => toast(e.message, 'err')) } }, icon('wallet'), addr ? 'Disconnect' : 'Connect')),
      h('h3', { class: 'set-group', text: 'On chain' }),
      h('div', { class: 'set-links' },
        link('Rapture ARC 1 collection', `${EXPLORER}/address/${app.snapshot.collection.address}`),
        link('PackShop', `${EXPLORER}/address/${PACKSHOP}`),
        link('Stakes escrow', `${EXPLORER}/address/${(import.meta.env as Record<string, string>).VITE_WAGER_ADDRESS ?? ''}`),
        h('span', { class: 'chip' }, icon('rune'), `LitNode title ${CHESS_RULESET_ID}`)));
  };
  const link = (text: string, href: string) => h('a', { class: 'chip', href, target: '_blank', rel: 'noopener' }, icon('external'), text);

  const el = h('section', { class: 'page settings' }, pageHead('Settings', 'Options'), h('div', { class: 'page-body' }, h('div', { class: 'panel frame settings-panel' }, h('div', { class: 'panel-body' }, body))));
  return { id: 'settings', el, enter() { render(); } };
}
