/** Settings: graphics preset, the fps readout, reduced motion, sound, the default battlefield, the wallet, and the contracts. */
import { CHESS_RULESET_ID } from '../../web3/wager';
import { PACKSHOP } from '../../web3/packshop';
import { EXPLORER, type App } from '../app';
import { h, icon, toast } from '../dom';
import { prefs, setPref, SOUND_MODES, type RealmChoice, type SoundMode } from '../prefs';
import { sound } from '../../audio';
import { pageHead, type Screen } from '../router';

const QUALITY: Array<[string, string, string]> = [
  ['auto', 'Auto', 'Holds 60 fps: lowers the render resolution when a frame runs long, then the preset, and climbs back when there is headroom.'],
  ['lite', 'Lite', 'Three-quarter resolution and no shadows. For the weakest phones.'],
  ['low', 'Low', 'Native resolution, no mirror floor or ambient occlusion. For older phones.'],
  ['medium', 'Medium', 'Sharper, with bloom, quarter-resolution godrays and two fire lights. The phone default.'],
  ['high', 'High', 'Ambient occlusion, godrays, every fire light and a mirror floor. The desktop default.'],
  ['ultra', 'Ultra', 'Large bloom, sharp reflections, finer godrays, shadows every frame.'],
];

export function settingsScreen(app: App): Screen {
  const body = h('div', { class: 'settings-list' });
  const row = (title: string, desc: string, control: HTMLElement) => h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', { text: title }), h('span', { text: desc })), control);
  // a volume slider; letting go plays a sample at the new level
  const slider = (label: string, value: number, set: (v: number) => void, sample: string | null) => h('input', { class: 'vol', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(value * 100)), aria: { label },
    on: { input: (e) => set(Number((e.target as HTMLInputElement).value) / 100), change: () => { if (sample) sound.play(sample); } } });
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
      h('h3', { class: 'set-group', text: 'Sound' }),
      h('div', { class: 'set-row col' }, h('div', { class: 'set-text' }, h('b', { text: 'Sound' }), h('span', { text: "Dark music, the realm's ambience and the battle. Effects only silences the music. S switches sound off and on anywhere." })),
        h('div', { class: 'seg' }, ...(Object.entries(SOUND_MODES) as Array<[SoundMode, string]>).map(([v, label]) => h('button', { class: prefs.sound === v ? 'on' : '', text: label, on: { click: () => { setPref('sound', v); render(); } } })))),
      row('Music', "Music and the realm's ambience.", slider('Music volume', prefs.musicVolume, (v) => setPref('musicVolume', v), null)),
      row('Effects', 'Champions, the board and the menus.', slider('Effects volume', prefs.sfxVolume, (v) => setPref('sfxVolume', v), 'strike')),
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
