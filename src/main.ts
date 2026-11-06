/**
 * Rapture Chess: the Rapture ARC 1 champions play chess on a Blender-built board, rendered with three.js.
 * Deckwright brings the wallet, the collection snapshot and the replayable match log; chess.js brings the rules.
 *
 * Three ways to play: against the worker bot; a LitNode match (the arcade launched this page for a placed match,
 * the node hosts the relay, replays the log and settles it, and the LitNodeWager escrow pays on that result);
 * or a dev relay room (`?relay=ws://127.0.0.1:7831&room=x&name=alice`).
 *
 * The page boots into the main menu over the live arena (the camera circling four god-kings); the menus are DOM
 * screens (src/ui/screens), the match is the HUD (src/ui/hud.ts) over the same stage.
 */
import './ui/theme.css';
import './ui/screens.css';
import './ui/hud.css';
import './ui/metal.css';
import './ui/mobile.css';
import * as THREE from 'three';
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { connectShell, parseLaunch, type CabinetShell } from 'tessaract/src/client/shell.ts';
import { Stage } from './scene/stage';
import { BoardView, squareToWorld, worldToSquare } from './scene/board';
import { Army, PieceView } from './scene/pieces';
import { VFX } from './scene/vfx';
import { Realm, REALM_NAME, type RealmId } from './scene/realm';
import { loadSet, preloadAvatars } from './scene/assets';
import { MATES } from './scene/mates';
import { tweens, ease } from './scene/tween';
import { Hud, type Fallen } from './ui/hud';
import { RoleMarks } from './ui/marks';
import { LocalMatch, type Match, type MatchEvents } from './game/session';
import { RelayMatch } from './game/relay';
import { mountWager, type WagerPanel } from './wager';
import { canHoldKey, meshNode, playerKey, playerKeyId } from './litnode/standalone';
import { openRanked as rankedPanel } from './ui/ranked';
import { encodeMove, offerDraw, type ChessState, type PieceType, type Side } from './rules/chessRules';
import { buildRoster, type Card, type Collection } from './roster';
import { createWeb3Link } from './web3/wallet';
import { createReadChain } from './web3/rpc';
import type { App } from './ui/app';
import { h, icon, modal, toast } from './ui/dom';
import { DIFFICULTY, onPrefs, prefs, recordResult, type Difficulty, type RealmChoice } from './ui/prefs';
import { currentScreen, go, onScreen, register, resetStack } from './ui/router';
import { homeScreen } from './ui/screens/home';
import { playScreen } from './ui/screens/play';
import { armoryScreen } from './ui/screens/armory';
import { shopScreen } from './ui/screens/shop';
import { ranksScreen } from './ui/screens/ranks';
import { settingsScreen } from './ui/screens/settings';
import { versusScreen } from './ui/screens/versus';

THREE.Cache.enabled = true; // realm previews swap arenas back and forth: keep the GLB bytes

// ------------------------------------------------------------------ boot screen (markup in index.html)
const bootBar = document.getElementById('boot-bar') as HTMLElement;
const bootText = document.getElementById('boot-text') as HTMLElement;
const boot = (p: number, text: string) => { bootBar.style.transform = `scaleX(${p})`; bootText.textContent = text; };
const applyMotion = () => document.documentElement.classList.toggle('still', prefs.still);
applyMotion();
onPrefs(applyMotion);

const hud = new Hud();
const canvas = document.getElementById('stage') as HTMLCanvasElement;
let stage: Stage | null = null;
let board: BoardView | null = null;
let army: Army | null = null;
let vfx: VFX | null = null;
let realm: Realm | null = null;
let marks: RoleMarks | null = null;
let match: Match | null = null;
let you: Side = 0;
let selected: PieceView | null = null;
let legal: Move[] = [];
let busy = false;           // a move is animating: input waits
let pendingPromotion: { from: string; to: string } | null = null;
const fallen: [Fallen[], Fallen[]] = [[], []];
const kills = new Map<Card, number>();
let startedAt = 0;
let difficulty: Difficulty = prefs.difficulty;
let realmChoice: RealmChoice = prefs.realm;
const query = new URLSearchParams(location.search);
const launch = parseLaunch();

boot(0.08, 'Reading the collection');
const snapshot: Collection = await fetch(`${import.meta.env.BASE_URL}data/collection.json`).then((r) => r.json());
const web3 = createWeb3Link(snapshot);
const chain = createReadChain();
void web3.restore();

// Opened by the arcade without a match ("Play now"): the shell still names the player, so a stake can be made before
// queueing instead of against the first move's clock. A placed match seats through its own shell (RelayMatch.placed).
let arcade: CabinetShell | null = null;
const inArcade = window.parent !== window;
// the zkLTC wager panel: stakes bound to the player's LitNode key, paid out from the node's settled delta
const wagerRoot = h('div', { class: 'wager-host' });
const wager: WagerPanel = mountWager({
  root: wagerRoot,
  web3,
  // in a match its key; in the arcade's frame the arcade's key; on the game's own page the key it queues with
  playerKey: () => (match instanceof RelayMatch ? match.playerId : inArcade ? arcade?.init.player?.id ?? null : playerKeyId()),
  nodeUrl: () => (match instanceof RelayMatch ? match.nodeUrl : inArcade ? arcade?.init.node?.url ?? null : meshNode()),
});
if (!inArcade && canHoldKey()) void playerKey().then(() => wager.refresh(), () => { /* no key here: stakes stay off */ });
if (!launch.matchId && inArcade) connectShell().then((s) => { arcade = s; wager.refresh(); }, () => { /* not the arcade */ });

const realmFor = (c: RealmChoice, side: Side): RealmId => (c === 'valhalla' || c === 'underworld' ? c : side === 0 ? 'valhalla' : 'underworld');
const accent = (side: Side) => stage?.setAccentColors(side === 0 ? 0x38a8ff : 0xff6a2a, side === 0 ? 0xff6a2a : 0x38a8ff);

// ------------------------------------------------------------------ the menu shell
const app: App = {
  snapshot, web3, chain,
  startSkirmish: (side, d, r) => { difficulty = d; realmChoice = r; void startGame(side); },
  preview: (r, side) => { accent(side); if (realm) void realm.load(r).then(() => vfx?.embers(new THREE.Color(realm!.preset.embers))); },
  realmFor,
  openStakes: () => { modal('zkLTC stakes', wagerRoot); wager.refresh(); },
  openRanked,
  setQuality: (q) => { prefs.quality = q; stage?.choose(q as never); },
  nodeHint: () => (match instanceof RelayMatch ? match.nodeUrl : null),
  balance: async () => { const a = web3.wallet.snapshot().address; return a ? (chain as unknown as { getBalance(a: string): Promise<bigint> }).getBalance(a) : null; },
  connect: () => web3.toggle(),
};

function openRanked(): void {
  rankedPanel({ chain, inArcade, openStakes: app.openStakes, play: (p) => void startRelay(() => RelayMatch.placed(events, p)) });
}

const home = homeScreen(app);
register(home);
register(playScreen(app));
register(armoryScreen(app));
register(shopScreen(app));
register(ranksScreen(app));
register(settingsScreen(app));
const versus = versusScreen();
register(versus);
register(hud.screen());
onScreen((s) => {
  if (!stage) return;
  stage.paused = !!s.opaque;
  // the phone HUD needs the board's place on screen: measure once the opening camera flight has settled
  if (s.id === 'match') for (const ms of [300, 2800, 4500]) setTimeout(layoutHud, ms);
  const menu = s.id !== 'match' && s.id !== 'versus';
  if (menu && !stage.attract) stage.setAttract(true);
  // judge the frame rate on menus over the arena; the match turns its governor on itself once the shaders settle
  if (s.opaque || s.id === 'match' || s.id === 'versus') stage.governing = false;
  else stage.governing = true;
});

hud.bind({
  onFlip: () => { void flyToSide(you === 0 ? 1 : 0, true); },
  onConcede: () => { if (match && !match.state.over) match.concede(); },
  onPromotion: (piece) => { if (pendingPromotion) { playMove(pendingPromotion.from, pendingPromotion.to, piece); pendingPromotion = null; } },
  onLeave: () => void leaveMatch(),
  onRematch: () => { if (!(match instanceof RelayMatch)) void startGame(you); },
  onStakes: () => app.openStakes(),
  onQuality: (q) => app.setQuality(q),
  canOfferDraw: () => !!match && match.drawOffers && !match.state.over && match.state.offer !== you && match.rules.canDraw(match.state, you, offerDraw()),
  onOfferDraw: () => { if (match?.offerDraw()) toast('Draw offered.'); else toast('A draw cannot be offered right now.', 'err'); },
  onAcceptDraw: () => { if (!match?.acceptDraw()) toast('That offer is no longer standing.', 'err'); },
  onDeclineDraw: () => { if (!match?.declineDraw()) hud.setDraw(-1, false); },
});
hud.showFps(prefs.showFps);

// ------------------------------------------------------------------ stage and board (built once, at boot)
async function ensureStage(): Promise<void> {
  if (stage) return;
  stage = new Stage(canvas);
  vfx = new VFX(stage.scene);
  realm = new Realm(stage);
  boot(0.3, 'Raising the board');
  const set = await loadSet();
  board = new BoardView(set);
  stage.scene.add(board.group);
  army = new Army(board.plinths, vfx);
  stage.scene.add(army.group);
  marks = new RoleMarks(stage.camera, canvas);
  marks.onPress = onMarkPress;
  document.getElementById('ui')!.before(marks.el);
  stage.onUpdate((dt, t) => {
    board!.update(dt); army!.update(dt, t); vfx!.update(dt); realm!.update(dt, t); tickClock();
    marks!.update(army!.pieces.values(), !!match && !stage!.attract && currentScreen() === 'match', dt);
  });
  stage.onQuality((q, fps, scale) => { hud.setFps(fps, scale < 1 ? `${q} ${Math.round(scale * 100)}%` : q); vfx!.rich = q !== 'low' && q !== 'lite'; });
  canvas.addEventListener('pointerdown', onPointerDown);
  stage.controls.addEventListener('end', () => layoutHud()); // the player orbited the board: re-fit the phone HUD
  canvas.addEventListener('pointermove', onPointerMove);
  stage.camera.position.set(0, 7, 16);
  stage.setAttract(true);
  stage.start();
  if (import.meta.env.DEV) {
    // debug hook for the browser console: screen position of a square, and the live objects
    (window as unknown as { rc: unknown }).rc = {
      get stage() { return stage; }, get army() { return army; }, get match() { return match; }, get realm() { return realm; }, hud, go,
      screen(sq: string) {
        const v = squareToWorld(sq, 0.3).project(stage!.camera), r = canvas.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
      },
    };
  }
}

// ------------------------------------------------------------------ the menu: the checkmate gallery

/** The board behind the menu re-enacts a famous checkmate: the final position of the game, the mating move marked,
 *  the mated god-king in check. Each side fields one champion per piece type, so a position loads a dozen avatars. */
let mateIndex = Math.floor(Math.random() * MATES.length);
let mateGen = 0;
let mateShown: { king: PieceView | undefined; mater: PieceView | undefined } | null = null;
async function tableau(advance = true): Promise<void> {
  const my = ++mateGen;
  if (advance) mateIndex = (mateIndex + 1) % MATES.length;
  const mate = MATES[mateIndex];
  const c = new Chess(mate.fen);
  let last: Move | null = null;
  if (mate.moves) for (const san of mate.moves.split(' ')) last = c.move(san);
  const champions = [0, 1].map((side) => {
    const r = buildRoster(snapshot.cards, side as Side, web3.owned, `rapture-mate:${mate.name}`);
    const at = side === 0 ? { k: 'e1', q: 'd1', r: 'a1', b: 'c1', n: 'b1', p: 'a2' } : { k: 'e8', q: 'd8', r: 'a8', b: 'c8', n: 'b8', p: 'a7' };
    return (t: PieceType) => r.get(at[t])!;
  });
  const rosters: [Map<string, Card>, Map<string, Card>] = [new Map(), new Map()];
  const types: [Map<string, PieceType>, Map<string, PieceType>] = [new Map(), new Map()];
  for (const row of c.board()) for (const p of row) {
    if (!p) continue;
    const side: Side = p.color === 'w' ? 0 : 1;
    rosters[side].set(p.square, champions[side](p.type));
    types[side].set(p.square, p.type);
  }
  const kingSq = [...types[c.turn() === 'w' ? 0 : 1]].find(([, t]) => t === 'k')?.[0] ?? null;
  // the new position is built off the board and its shaders compiled in parallel while the old one still stands,
  // then it swaps in within one frame: no empty board, no frame stalled on a compile
  const swapped = await army!.replace(
    [{ side: 0, roster: rosters[0], types: types[0] }, { side: 1, roster: rosters[1], types: types[1] }],
    async (staged) => { await stage!.renderer.compileAsync(staged, stage!.camera, stage!.scene); },
    () => my !== mateGen || !!match);
  if (!swapped) return;
  stage!.hold(); // the swap's uploads say nothing about the frame rate
  clearSelection();
  board!.setLastMove(last?.from ?? null, last?.to ?? null);
  board!.setCheck(kingSq);
  home.setMate(mate.name, mate.where, last?.san ?? 'Checkmate');
  mateShown = { king: kingSq ? army!.at(kingSq) : undefined, mater: last ? army!.at(last.to) : undefined };
  mateShown.mater?.setHighlight(true);
  pulseMate();
}
/** The mating champion strikes, the god-king reels, the rune ring of check rises. */
function pulseMate(): void {
  if (!mateShown || match || !stage?.attract) return;
  const { king, mater } = mateShown;
  mater?.play('attack', 1.2);
  if (king) { setTimeout(() => king.play('hit', 1), 450); vfx!.check(king.group.position); }
}
let mateTick = 0;
setInterval(() => {
  if (match || !stage?.attract || document.hidden) return;
  mateTick++;
  if (mateTick % 4 === 0) void tableau();
  else if (mateTick % 4 === 2) pulseMate();
}, 4000);

// ------------------------------------------------------------------ a game
let seedCounter = 0;
const startSquares = (() => {
  const types = new Map<string, PieceType>();
  for (const [sq, p] of new Chess().board().flat().map((p, i) => [`${'abcdefgh'[i % 8]}${8 - Math.floor(i / 8)}`, p] as const)) if (p) types.set(sq, p.type);
  return types;
})();

/** Common setup for any match: the realm, the two armies for a seed, the HUD. Reports progress to the versus screen. */
async function prepare(side: Side, seed: string, owned: Set<string>, names: [string, string], subs: [string, string], relay: boolean): Promise<void> {
  you = side;
  const r = realmFor(realmChoice, side);
  const rosters = [buildRoster(snapshot.cards, 0, owned, seed), buildRoster(snapshot.cards, 1, owned, seed)] as const;
  versus.show({ you: side, names, subs, gods: [rosters[0].get('e1') ?? null, rosters[1].get('e8') ?? null], realm: REALM_NAME[r] });
  await go('versus', { wipe: true });
  versus.progress(0.04, 'Opening the gates');
  await ensureStage();
  stage!.governing = false;
  mateGen++; // a gallery position still loading must not land on this board
  mateShown = null;
  army!.clear();
  fallen[0] = []; fallen[1] = [];
  kills.clear();
  clearSelection();
  board!.setLastMove(null, null); board!.setCheck(null);
  marks!.check = null;
  marks!.you = side;
  await realm!.load(r);
  vfx!.embers(new THREE.Color(realm!.preset.embers));
  versus.progress(0.12, 'Summoning champions');
  const slugs = [...rosters[0].values(), ...rosters[1].values()].map((c) => c.slug);
  await preloadAvatars(slugs, (done, total) => versus.progress(0.12 + 0.8 * (done / total), `Summoning champions ${done}/${total}`));
  await army!.muster(0, rosters[0], startSquares);
  await army!.muster(1, rosters[1], startSquares);
  // compile the avatars' shaders now (in parallel where the driver allows), then draw one frame under the versus
  // screen so the shadow and post variants are built too: nothing compiles on the first visible frame
  await stage!.renderer.compileAsync(stage!.scene, stage!.camera);
  stage!.warm();
  versus.progress(1, 'To battle');
  hud.setPlayers(side, names, subs, relay);
  hud.setMoves([]);
  hud.setFallen(fallen);
  hud.showCard(null, null, false, null);
  hud.showResult(null);
  hud.pause(false);
  hud.setClocks(null);
  hud.setDraw(-1, false);
  accent(side);
  await new Promise((res) => setTimeout(res, 450));
  stage!.setAttract(false);
  stage!.camera.position.set(side === 0 ? 9 : -9, 14, (side === 0 ? 11.5 : -11.5) * 1.4);
  stage!.camera.lookAt(stage!.controls.target);
  await go('match', { wipe: true });
  setTimeout(() => { if (stage) stage.governing = true; }, 3000); // let the first frames settle (shader compiles) before judging
  startedAt = Date.now();
}

const events: MatchEvents = {
  onStep: (_entry, move, state) => { void onStep(move, state); },
  onStatus: (text) => hud.setStatus(text),
};

async function startGame(side: Side): Promise<void> {
  // seed: wallet + time, like a placement seed; the log replays from it
  const seed = `${web3.wallet.snapshot().address ?? 'guest'}:${Date.now().toString(16)}:${seedCounter++}`;
  match?.close();
  match = null;
  const d = DIFFICULTY[difficulty];
  const names: [string, string] = side === 0 ? ['You', 'The Oracle'] : ['The Oracle', 'You'];
  const yourSub = web3.shortAddress() ? `${web3.shortAddress()} · ${web3.owned.size} held` : 'Guest';
  const subs: [string, string] = side === 0 ? [yourSub, `${d.name} · ${d.blurb}`] : [`${d.name} · ${d.blurb}`, yourSub];
  await prepare(side, seed, web3.owned, names, subs, false);
  const local = new LocalMatch(seed, you, events, d.budgetMs, d.maxDepth);
  match = local;
  hud.setTurn(0, false, you !== 0);
  hud.setStatus(you === 0 ? 'The Alliance opens. Pick a champion.' : 'The Alliance opens…');
  hud.cine('The battle begins', 'gold', `${REALM_NAME[realmFor(realmChoice, you)]} · ${you === 0 ? 'Alliance' : 'Horde'} vs the Oracle`);
  await flyToSide(you, false);
  if (match === local) local.poke(); // the player may have left during the opening flight
}

/** A relayed match: placed by LitNode (the arcade launched this page) or a dev room. Both screens draw the armies
 *  from the relay's seed alone, so they agree on who stands where. */
async function startRelay(open: () => Promise<RelayMatch> | RelayMatch): Promise<void> {
  versus.show({ you: 0, names: ['Alliance', 'Horde'], subs: ['Joining the table', 'Waiting for the opponent'], gods: [null, null], realm: 'LitNode' });
  await go('versus', { wipe: true });
  versus.progress(0.02, 'Joining the match');
  let m: RelayMatch;
  try { m = await open(); } catch (e) { toast((e as Error).message, 'err'); await go('home', { wipe: true }); return; }
  match?.close();
  match = m;
  versus.progress(0.04, 'Waiting for the opponent');
  while (!m.seed && match === m) await new Promise((r) => setTimeout(r, 250));
  if (match !== m) return;
  const short = (k: string) => (k.length > 14 ? `${k.slice(0, 6)}…${k.slice(-4)}` : k);
  const names: [string, string] = m.you === 0 ? ['You', 'Opponent'] : ['Opponent', 'You'];
  const subs: [string, string] = [short(m.participants[0]), short(m.participants[1])];
  await prepare(m.you, m.seed, new Set(), names, subs, true);
  match = m; // prepare() touched nothing else
  m.onClock(() => tickClock());
  m.onSettled((s) => { if (s.delta && !s.dev) { wager.showMatch(s.matchId, s.signatures); toast('The node settled the match: claim from Stakes.'); } });
  hud.setTurn(m.state.turn, m.state.over);
  hud.cine('The battle begins', 'gold', 'Placed by LitNode');
  await flyToSide(you, false);
  // moves that arrived while the armies loaded are already in the state: play them onto the board
  const replay = new Chess();
  for (const san of m.state.sans) { const mv = replay.move(san); if (mv) await army!.apply(mv); }
  hud.setMoves(m.state.sans);
  if (m.state.over) finish(m.state, m);
  else hud.setStatus(m.yourTurn ? 'Your move.' : 'Waiting for the opponent…');
}

async function leaveMatch(): Promise<void> {
  match?.close();
  match = null;
  hud.showResult(null);
  hud.pause(false);
  resetStack();
  await go('home', { wipe: true, before: async () => { stage?.setAttract(true); mateTick = 0; await Promise.race([tableau(), new Promise((r) => setTimeout(r, 1500))]); } });
}

let lastClock = 0;
function tickClock(): void {
  if (!(match instanceof RelayMatch)) return;
  const now = performance.now();
  if (now - lastClock < 200) return;
  lastClock = now;
  hud.setClocks(!match.clock || match.state.over ? null : match.clock);
}

async function onStep(move: Move | null, state: ChessState): Promise<void> {
  const m = match!;
  busy = true;
  if (move) clearSelection(); // a draw word from the opponent leaves your selection alone
  hud.setMoves(state.sans);
  if (move) {
    const mover = army!.at(move.from);
    const victimSquare = move.flags.includes('e') ? `${move.to[0]}${move.from[1]}` : move.to;
    const victim = move.captured ? army!.at(victimSquare) : undefined;
    if (mover) hud.showCard(mover.card, (move.promotion as PieceType) ?? mover.type, web3.owned.has(mover.card.tokenId), mover.side);
    board!.setLastMove(move.from, move.to);
    board!.setCheck(null);
    marks!.check = null;
    await army!.apply(move);
    if (victim) {
      fallen[victim.side].push({ card: victim.card, type: victim.type });
      if (mover) kills.set(mover.card, (kills.get(mover.card) ?? 0) + 1);
      hud.setFallen(fallen);
      hud.kill(mover?.card ?? null, victim.card);
      hud.flash('capture');
      if (!prefs.still) stage?.shake(0.05, 0.25);
    }
    if (move.promotion) hud.cine('Ascension', 'gold', `${mover?.card.name ?? 'A champion'} rises`);
  }
  busy = false;
  if (match !== m) return; // a new game started while animating
  hud.setDraw(state.offer, m.drawOffers && !state.over);
  const pos = new Chess(state.fen);
  if (!state.over && pos.inCheck()) {
    const king = kingOf(state.turn);
    if (king) { board!.setCheck(king.square); vfx!.check(king.group.position); marks!.check = king; }
    hud.cine('Check', 'red', state.turn === you ? 'Your god-king is threatened' : 'The enemy god-king is threatened');
    hud.flash('check');
  }
  hud.setTurn(state.turn, state.over, m instanceof LocalMatch && state.turn !== you);
  if (state.over) { finish(state, m); return; }
  if (state.turn === you) hud.setStatus('Your move.');
  else m.poke();
}

/** End reasons (chessRules) in the result screen's words. */
const DRAWN: Record<string, string> = {
  agreement: 'Drawn by agreement', stalemate: 'Drawn by stalemate', 'threefold repetition': 'Drawn by threefold repetition',
  'insufficient material': 'Drawn: neither side can mate', 'timeout vs insufficient material': 'Drawn: the flag fell, but the opponent could not mate',
  'move limit': 'Drawn at the move limit', 'fifty-move rule': 'Drawn by the fifty-move rule',
};
const WON: Record<string, string> = { checkmate: 'by checkmate', concession: 'by concession', timeout: 'on time' };

const kingOf = (side: Side) => [...army!.pieces.values()].find((p) => p.type === 'k' && p.side === side);

function finish(state: ChessState, m: Match): void {
  const youWon = state.winner === you, draw = state.winner === 2;
  const outcome = draw ? 'draw' : youWon ? 'win' : 'loss';
  const winnerName = state.winner === 0 ? 'The Alliance' : 'The Horde';
  const detail = draw ? `${DRAWN[state.reason] ?? `Drawn by ${state.reason}`}.` : `${winnerName} wins ${WON[state.reason] ?? `by ${state.reason}`}.`;
  hud.setStatus(detail);
  hud.setClocks(null);
  hud.setDraw(-1, false);
  hud.setTurn(state.turn, true);
  if (!draw) { const king = kingOf(state.winner as Side); if (king) vfx!.finale(king.group.position, king.color); }
  hud.cine(draw ? (state.reason === 'stalemate' ? 'Stalemate' : 'Draw') : youWon ? 'Victory' : 'Defeat', draw ? 'ice' : youWon ? 'gold' : 'red', detail);
  hud.flash(youWon ? 'victory' : 'defeat');
  const relay = m instanceof RelayMatch;
  let footnote = relay ? 'The host node replays and settles the ledger; claim the pot from Stakes once it has.' : undefined;
  if (!relay) {
    const r = recordResult(outcome, difficulty, state.sans.length, you);
    footnote = `Record against the Oracle: ${r.wins} wins, ${r.losses} losses, ${r.draws} draws${r.streak > 1 ? ` · ${r.streak} in a row` : ''}`;
  }
  const opp: Side = you === 0 ? 1 : 0;
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const mine = [...kills].filter(([c]) => c.faction === (you === 0 ? 'Alliance' : 'Horde')).sort((a, b) => b[1] - a[1])[0];
  console.info('[chess] match log', JSON.stringify({ seed: m.seed, log: m.log }));
  setTimeout(() => {
    if (match !== m) return;
    hud.showResult({
      outcome, relay, footnote,
      title: draw ? 'Draw' : youWon ? 'Victory' : 'Defeat',
      detail: `${detail} ${state.sans.length} moves recorded in the match log.`,
      stats: [['Moves', String(Math.ceil(state.sans.length / 2))], ['Slain', String(fallen[opp].length)], ['Lost', String(fallen[you].length)], ['Time', `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`]],
      mvp: mine ? { card: mine[0], kills: mine[1] } : null,
    });
  }, draw ? 900 : 2400);
}

// ------------------------------------------------------------------ input
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
/** What is under the pointer: the champion the ray meets first, and the board square the ray lands on. A tall
 *  champion in front can cover the base of the one behind it, so callers weigh both (see onPointerDown). */
function cast(ev: PointerEvent): { piece: PieceView | null; square: string | null; floor: string | null } {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage!.camera);
  const hitPiece = raycaster.intersectObjects(army!.pickables(), false)[0];
  const piece = (hitPiece?.object.userData.piece as PieceView | undefined) ?? null;
  const hitBoard = raycaster.intersectObject(board!.pickPlane, false)[0];
  const floor = hitBoard ? worldToSquare(hitBoard.point) : null;
  return { piece, square: piece?.square ?? floor, floor };
}

let hoverAt = 0;
function onPointerMove(ev: PointerEvent): void {
  if (!match || !board || currentScreen() !== 'match' || ev.pointerType === 'touch') return;
  const now = performance.now();
  if (now - hoverAt < 40) return; // hover picking at 25 Hz is plenty
  hoverAt = now;
  const { square } = cast(ev);
  board.setHover(square);
  canvas.style.cursor = square && (selected || army!.at(square)?.side === you) ? 'pointer' : 'default';
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 || !match || currentScreen() !== 'match' || hud.isPaused()) return;
  const { piece, floor } = cast(ev);
  // the square tapped wins over a champion whose body happens to cover it
  const onFloor = floor ? army!.at(floor) : undefined;
  const target = onFloor ?? piece;
  // any champion can be inspected, any time
  if (target && target.side !== you) hud.showCard(target.card, target.type, web3.owned.has(target.card.tokenId), target.side);
  if (busy || !match.yourTurn || pendingPromotion) return;
  if (selected) {
    // a legal destination under the pointer: the floor square first, then the square of the champion hit
    const to = [floor, piece?.square].find((sq) => sq && legal.some((m) => m.to === sq));
    if (to) { tryMove(selected.square, to); return; }
  }
  const mine = onFloor?.side === you ? onFloor : piece?.side === you ? piece : null;
  if (mine) select(mine);
  else clearSelection();
}

function select(piece: PieceView): void {
  clearSelection();
  selected = piece;
  piece.setHighlight(true);
  legal = match!.legalMoves().filter((m) => m.from === piece.square);
  board!.setSelected(piece.square);
  const captures = new Set(legal.filter((m) => m.captured).map((m) => m.to));
  board!.showTargets(legal.map((m) => m.to), captures);
  if (marks) { marks.selected = piece; marks.targets = captures; }
  hud.showCard(piece.card, piece.type, web3.owned.has(piece.card.tokenId), piece.side);
  vfx!.select(piece.group.position, piece.color);
}

function clearSelection(): void {
  selected?.setHighlight(false);
  selected = null;
  legal = [];
  board?.setSelected(null);
  board?.clearTargets();
  if (marks) { marks.selected = null; marks.targets = new Set(); }
}

/** Play a legal move of the selected champion, or open the promotion picker first. False if nothing was played. */
function tryMove(from: string, to: string): boolean {
  if (legal.some((m) => m.to === to && m.promotion)) { pendingPromotion = { from, to }; hud.promotion(true); return false; }
  return playMove(from, to, '');
}

function playMove(from: string, to: string, promotion: string): boolean {
  if (!match) return false;
  if (match.act(encodeMove(from, to, promotion))) return true;
  toast('That move is not legal.', 'err');
  return false;
}

// ------------------------------------------------------------------ role marks: press to select, drag to move
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const dragHit = new THREE.Vector3();
const DRAG_LIFT = 0.18;

/** Where the pointer's ray meets the horizontal plane at `y`. */
function rayAt(ev: PointerEvent, y: number): THREE.Vector3 | null {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage!.camera);
  dragPlane.constant = -y;
  return raycaster.ray.intersectPlane(dragPlane, dragHit);
}

/** A mark was pressed. An enemy mark shows its card (or is captured, if the selected champion can take it); your own
 *  mark selects its champion, and dragging it carries the champion across the board to drop on a square. */
function onMarkPress(piece: PieceView, ev: PointerEvent, el: HTMLElement): void {
  if (!match || currentScreen() !== 'match' || hud.isPaused() || marks!.held) return;
  const owned = web3.owned.has(piece.card.tokenId);
  const canAct = !busy && match.yourTurn && !pendingPromotion;
  if (piece.side !== you) {
    if (canAct && selected && legal.some((m) => m.to === piece.square)) { tryMove(selected.square, piece.square); return; }
    hud.showCard(piece.card, piece.type, owned, piece.side);
    return;
  }
  if (!canAct) { hud.showCard(piece.card, piece.type, owned, piece.side); return; }
  const wasSelected = selected === piece;
  if (!wasSelected) select(piece);

  const home = piece.group.position.clone();
  const height = piece.crown(new THREE.Vector3()).y;
  const start = rayAt(ev, height + DRAG_LIFT);
  const grab = start ? new THREE.Vector3(start.x - home.x, 0, start.z - home.z) : new THREE.Vector3();
  const x0 = ev.clientX, y0 = ev.clientY;
  let moved = false;
  try { el.setPointerCapture(ev.pointerId); } catch { /* the pointer is already up */ }
  marks!.held = piece;

  const move = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 6) return;
    moved = true;
    const at = rayAt(e, height + DRAG_LIFT);
    if (!at) return;
    piece.group.position.set(THREE.MathUtils.clamp(at.x - grab.x, -4.2, 4.2), DRAG_LIFT, THREE.MathUtils.clamp(at.z - grab.z, -4.2, 4.2));
    board!.setHover(worldToSquare(piece.group.position));
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    marks!.held = null;
    board!.setHover(null);
    if (!moved) { if (wasSelected) clearSelection(); return; } // a tap: select, or a second tap to let go
    const to = e.type === 'pointerup' ? worldToSquare(piece.group.position) : null;
    if (to && to !== piece.square && selected === piece && legal.some((m) => m.to === to) && match?.yourTurn && !busy) {
      piece.group.position.y = 0;
      if (tryMove(piece.square, to)) return; // the move glides on from where the champion was dropped
    }
    const from = piece.group.position.clone();
    void tweens.run(0.22, (k) => { piece.group.position.lerpVectors(from, home, k); }, ease.outCubic);
  };
  // on the window, so the drag still ends if the capture could not be taken
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

document.addEventListener('keydown', (e) => {
  if (currentScreen() !== 'match' || document.querySelector('.scrim')) return;
  if (e.key === 'Escape') hud.pause(!hud.isPaused());
  else if (hud.isPaused()) return;
  else if (e.key === 'f' || e.key === 'F') void flyToSide(you === 0 ? 1 : 0, true);
  else if (e.key === 'm' || e.key === 'M') hud.toggleChronicle();
  else if ((e.key === 'i' || e.key === 'I') && marks) marks.enabled = !marks.enabled;
});

// ------------------------------------------------------------------ camera
/** Portrait phones: the board already spans the width, so a higher, steeper camera is what makes it bigger (taller). */
const portrait = () => innerWidth / innerHeight < 0.8;

async function flyToSide(side: Side, quick: boolean): Promise<void> {
  if (!stage) return;
  const s = side === 0 ? 1 : -1;
  const to = portrait() ? new THREE.Vector3(0, 12.6, 7.2 * s) : new THREE.Vector3(0, 9.2, 11.5 * s);
  await stage.flyTo(to, quick ? 1.1 : 2.4);
  layoutHud();
}

/** Tell the HUD where the board is on screen (--board-top / --board-bottom, CSS px), so the phone layout can keep the
 *  inspector, the moves, the banners and the feed in the bands above and below it instead of over it. Measured from
 *  the board's corners at the floor and at a champion's height. */
const boardBox = [-4.7, 4.7].flatMap((x) => [-4.7, 4.7].flatMap((z) => [0, 1.2].map((y) => new THREE.Vector3(x, y, z))));
function layoutHud(): void {
  if (!stage || currentScreen() !== 'match') return;
  const r = canvas.getBoundingClientRect(), v = new THREE.Vector3();
  let top = Infinity, bottom = -Infinity;
  for (const p of boardBox) {
    v.copy(p).project(stage.camera);
    const y = r.top + (1 - v.y) / 2 * r.height;
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  hud.setBoardBand(Math.max(0, top), Math.min(r.height, bottom));
}
let hudT = 0;
addEventListener('resize', () => { clearTimeout(hudT); hudT = window.setTimeout(layoutHud, 150); });

// ------------------------------------------------------------------ launch
await ensureStage();
boot(0.55, 'Opening the realm');
await realm!.load(realmFor(prefs.realm, prefs.side));
vfx!.embers(new THREE.Color(realm!.preset.embers));
accent(prefs.side);
boot(0.75, 'Awakening the gods');
// the first position streams its champions in behind the menu; the boot only waits for the fonts
void tableau(false);
await document.fonts.ready;
boot(1, 'Ready');
const bootEl = document.getElementById('boot')!;
bootEl.classList.add('done');
setTimeout(() => bootEl.remove(), 900);

if (launch.matchId) {
  // The LitNode arcade opened this page for a placed match: seat through the shell and play.
  void startRelay(() => RelayMatch.placed(events));
} else if (query.get('relay')) {
  void startRelay(() => RelayMatch.dev(events, query.get('relay')!, query.get('room') ?? 'lobby', query.get('name') ?? `player-${Math.floor(Math.random() * 1e6)}`));
} else {
  void go('home');
}
