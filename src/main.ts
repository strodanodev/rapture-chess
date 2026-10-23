/**
 * Rapture Chess: the Rapture ARC 1 champions play chess on a Blender-built board, rendered with three.js.
 * Deckwright brings the wallet, the collection snapshot and the replayable match log; chess.js brings the rules.
 *
 * Three ways to play: against the worker bot; a LitNode match (the arcade launched this page for a placed match,
 * the node hosts the relay, replays the log and settles it, and the LitNodeWager escrow pays on that result);
 * or a dev relay room (`?relay=ws://127.0.0.1:7831&room=x&name=alice`).
 */
import * as THREE from 'three';
import { Chess } from 'chess.js';
import type { Move } from 'chess.js';
import { parseLaunch } from 'deckwright/src/client/shell.ts';
import { Stage } from './scene/stage';
import { BoardView, squareToWorld, worldToSquare } from './scene/board';
import { Army, PieceView } from './scene/pieces';
import { VFX } from './scene/vfx';
import { Realm, type RealmId } from './scene/realm';
import { loadSet, preloadAvatars } from './scene/assets';
import { Hud } from './ui/hud';
import { LocalMatch, type Match, type MatchEvents } from './game/session';
import { RelayMatch } from './game/relay';
import { mountWager, type WagerPanel } from './wager';
import { encodeMove, type ChessState, type PieceType, type Side } from './rules/chessRules';
import { buildRoster, ELEMENT_COLOR, type Card, type Collection } from './roster';
import { createWeb3Link } from './web3/wallet';

const hud = new Hud();
const canvas = document.getElementById('stage') as HTMLCanvasElement;
let stage: Stage | null = null;
let board: BoardView | null = null;
let army: Army | null = null;
let vfx: VFX | null = null;
let realm: Realm | null = null;
let match: Match | null = null;
let you: Side = 0;
let selected: PieceView | null = null;
let legal: Move[] = [];
let busy = false;           // a move is animating: input waits
let pendingPromotion: { from: string; to: string } | null = null;
const fallen: [Card[], Card[]] = [[], []];
const query = new URLSearchParams(location.search);
const launch = parseLaunch();

const snapshot: Collection = await fetch(`${import.meta.env.BASE_URL}data/collection.json`).then((r) => r.json());
const web3 = createWeb3Link(snapshot);
const refreshWallet = () => hud.setWallet(web3.shortAddress(), web3.owned.size);
web3.onChange(refreshWallet);
web3.wallet.subscribe(refreshWallet);
refreshWallet();
void web3.restore();

hud.bind({
  onPlay: (side) => { void startGame(side); },
  onWallet: () => { web3.toggle().catch((e: Error) => hud.toast(e.message)); },
  onNewGame: () => { if (match instanceof RelayMatch) hud.toast('A relayed match cannot be restarted here.'); else void startGame(you); },
  onFlip: () => { void flyToSide(you === 0 ? 1 : 0, true); },
  onConcede: () => { if (match && !match.state.over) match.concede(); },
  onPromotion: (piece) => { if (pendingPromotion) { void playMove(pendingPromotion.from, pendingPromotion.to, piece); pendingPromotion = null; } },
  onQuality: (q) => { stage?.choose(q as never); },
});
hud.setQualityChoice(localStorage.getItem('rapture-chess.quality') ?? 'auto');

// the zkLTC wager panel: stakes bound to the player's LitNode key, paid out from the node's settled delta
const wager: WagerPanel = mountWager({
  root: document.getElementById('wager-title')!,
  web3,
  playerKey: () => (match instanceof RelayMatch ? match.playerId : null),
  nodeUrl: () => (match instanceof RelayMatch ? match.nodeUrl : null),
});
const placeWager = (slot: 'wager-title' | 'wager-hud') => {
  const from = slot === 'wager-hud' ? 'wager-title' : 'wager-hud';
  const box = document.getElementById(from)?.firstElementChild;
  if (box) document.getElementById(slot)!.append(box);
};

// ------------------------------------------------------------------ stage and board (built once)
async function ensureStage(): Promise<void> {
  if (stage) return;
  stage = new Stage(canvas);
  vfx = new VFX(stage.scene);
  realm = new Realm(stage);
  const set = await loadSet();
  board = new BoardView(set);
  stage.scene.add(board.group);
  army = new Army(board.plinths, vfx);
  stage.scene.add(army.group);
  stage.onUpdate((dt, t) => { board!.update(dt); army!.update(dt, t); vfx!.update(dt); realm!.update(dt, t); tickClock(); });
  stage.onQuality((q, fps) => { hud.setFps(fps, q); vfx!.rich = q !== 'low'; });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  stage.start();
  if (import.meta.env.DEV) {
    // debug hook for the browser console: screen position of a square, and the live objects
    (window as unknown as { rc: unknown }).rc = {
      get stage() { return stage; }, get army() { return army; }, get match() { return match; }, get realm() { return realm; },
      screen(sq: string) {
        const v = squareToWorld(sq, 0.3).project(stage!.camera), r = canvas.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
      },
    };
  }
}

/** The realm for a game: the title choice, or the player's side (Alliance in Valhalla, Horde in the Underworld). */
function realmFor(side: Side): RealmId {
  const c = hud.realmChoice();
  return c === 'valhalla' || c === 'underworld' ? c : side === 0 ? 'valhalla' : 'underworld';
}

// ------------------------------------------------------------------ a game
let seedCounter = 0;

/** Common setup for any match: the stage, the realm, the two armies for a seed, the HUD. */
async function prepare(side: Side, seed: string, loadingText: string, owned: Set<string>): Promise<void> {
  you = side;
  hud.showTitle(false);
  hud.showOver(null);
  hud.loading('Raising the board…', 0.05);
  await ensureStage();
  stage!.governing = false;
  army!.clear();
  fallen[0] = []; fallen[1] = [];
  clearSelection();
  board!.setLastMove(null, null); board!.setCheck(null);
  const r = realmFor(side);
  await realm!.load(r);
  vfx!.embers(new THREE.Color(realm!.preset.embers));

  const rosters = [buildRoster(snapshot.cards, 0, owned, seed), buildRoster(snapshot.cards, 1, owned, seed)] as const;
  const types = new Map<string, PieceType>();
  for (const [sq, p] of new Chess().board().flat().map((p, i) => [`${'abcdefgh'[i % 8]}${8 - Math.floor(i / 8)}`, p] as const)) if (p) types.set(sq, p.type);
  hud.loading(loadingText, 0.1);
  const slugs = [...rosters[0].values(), ...rosters[1].values()].map((c) => c.slug);
  await preloadAvatars(slugs, (done, total) => hud.loading(`${loadingText} ${done}/${total}`, 0.1 + 0.85 * (done / total)));
  await army!.muster(0, rosters[0], types);
  await army!.muster(1, rosters[1], types);
  hud.loading(null);
  hud.showHud(true);
  placeWager('wager-hud');
  setTimeout(() => { if (stage) stage.governing = true; }, 3000); // let the first frames settle (shader compiles) before judging
  hud.setMoves([]);
  hud.setCaptured(0, []); hud.setCaptured(1, []);
  hud.showCard(null, null, false, null);
  hud.setClock(null, false);
  stage!.setAccentColors(side === 0 ? 0x38a8ff : 0xff6a2a, side === 0 ? 0xff6a2a : 0x38a8ff);
}

const events: MatchEvents = {
  onStep: (_entry, move, state) => { void onStep(move, state); },
  onStatus: (text) => hud.setStatus(text),
};

async function startGame(side: Side): Promise<void> {
  // seed: wallet + time, like a placement seed; the log replays from it
  const seed = `${web3.wallet.snapshot().address ?? 'guest'}:${Date.now().toString(16)}:${seedCounter++}`;
  match?.close();
  await prepare(side, seed, 'Summoning champions…', web3.owned);
  match = new LocalMatch(seed, you, events);
  hud.setTurn(0, you, false);
  hud.setStatus(you === 0 ? 'Alliance opens. Pick a champion.' : 'The Alliance opens…');
  await flyToSide(you, false);
  match.poke();
}

/** A relayed match: placed by LitNode (the arcade launched this page) or a dev room. Both screens draw the armies
 *  from the relay's seed alone, so they agree on who stands where. */
async function startRelay(open: () => Promise<RelayMatch> | RelayMatch): Promise<void> {
  hud.showTitle(false);
  hud.loading('Joining the match…', 0.02);
  let m: RelayMatch;
  try { m = await open(); } catch (e) { hud.loading(null); hud.showTitle(true); hud.toast((e as Error).message); return; }
  match?.close();
  match = m;
  hud.loading('Waiting for the opponent…', 0.04);
  while (!m.seed && match === m) await new Promise((r) => setTimeout(r, 250));
  if (match !== m) return;
  await prepare(m.you, m.seed, 'Summoning champions…', new Set());
  match = m; // prepare() touched nothing else
  m.onClock(() => tickClock());
  m.onSettled((s) => { if (s.delta && !s.dev) wager.showMatch(s.matchId); });
  hud.setTurn(m.state.turn, you, m.state.over);
  await flyToSide(you, false);
  // moves that arrived while the armies loaded are already in the state: play them onto the board
  const replay = new Chess();
  for (const san of m.state.sans) { const mv = replay.move(san); if (mv) await army!.apply(mv); }
  hud.setMoves(m.state.sans);
  if (m.state.over) hud.showOver(m.state.winner === 2 ? 'Draw' : m.state.winner === you ? 'Victory' : 'Defeat', m.state.reason);
  else hud.setStatus(m.yourTurn ? 'Your move.' : 'Waiting for the opponent…');
}

function tickClock(): void {
  if (!(match instanceof RelayMatch)) return;
  if (!match.clock || match.state.over) { hud.setClock(null, false); return; }
  hud.setClock((match.clock.deadline - Date.now()) / 1000, match.clock.side === you);
}

async function onStep(move: Move | null, state: ChessState): Promise<void> {
  const m = match!;
  busy = true;
  clearSelection();
  hud.setMoves(state.sans);
  if (move) {
    const mover = army!.at(move.from);
    const victimSquare = move.flags.includes('e') ? `${move.to[0]}${move.from[1]}` : move.to;
    const victim = move.captured ? army!.at(victimSquare) : undefined;
    if (mover) hud.showCard(mover.card, (move.promotion as PieceType) ?? mover.type, web3.owned.has(mover.card.tokenId), mover.side);
    board!.setLastMove(move.from, move.to);
    board!.setCheck(null);
    await army!.apply(move);
    if (victim) {
      fallen[victim.side].push(victim.card);
      hud.setCaptured(victim.side, fallen[victim.side]);
      hud.toast(`${victim.card.name} has fallen to ${mover?.card.name ?? 'the enemy'}`);
    }
  }
  busy = false;
  if (match !== m) return; // a new game started while animating
  hud.setTurn(state.turn, you, state.over);
  const pos = new Chess(state.fen);
  const kingOf = (side: Side) => [...army!.pieces.values()].find((p) => p.type === 'k' && p.side === side);
  if (!state.over && pos.inCheck()) {
    const king = kingOf(state.turn);
    if (king) { board!.setCheck(king.square); vfx!.check(king.group.position); }
    hud.toast('Check!');
  }
  if (state.over) {
    const youWon = state.winner === you, draw = state.winner === 2;
    const title = draw ? 'Draw' : youWon ? 'Victory' : 'Defeat';
    const detail = draw ? `Drawn by ${state.reason}.` : `${state.winner === 0 ? 'The Alliance' : 'The Horde'} wins by ${state.reason}. ${state.sans.length} moves recorded in the match log.`;
    hud.setStatus(detail);
    hud.setClock(null, false);
    if (!draw) { const king = kingOf(state.winner as Side); if (king) vfx!.finale(king.group.position, king.color); }
    setTimeout(() => { if (match === m) hud.showOver(title, m instanceof RelayMatch ? `${detail} The node settles the ledger; the wager panel claims the pot once it has.` : detail); }, draw ? 600 : 2200);
    console.info('[chess] match log', JSON.stringify({ seed: m.seed, log: m.log }));
    return;
  }
  if (state.turn === you) hud.setStatus('Your move.');
  else m.poke();
}

// ------------------------------------------------------------------ input
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
function cast(ev: PointerEvent): { piece: PieceView | null; square: string | null } {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, stage!.camera);
  const hitPiece = raycaster.intersectObjects(army!.pickables(), false)[0];
  const piece = (hitPiece?.object.userData.piece as PieceView | undefined) ?? null;
  const hitBoard = raycaster.intersectObject(board!.pickPlane, false)[0];
  return { piece, square: piece?.square ?? (hitBoard ? worldToSquare(hitBoard.point) : null) };
}

let hoverAt = 0;
function onPointerMove(ev: PointerEvent): void {
  if (!match || !board) return;
  const now = performance.now();
  if (now - hoverAt < 40) return; // hover picking at 25 Hz is plenty
  hoverAt = now;
  const { square } = cast(ev);
  board.setHover(square);
  canvas.style.cursor = square && (selected || army!.at(square)?.side === you) ? 'pointer' : 'default';
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 || !match || busy || !match.yourTurn || pendingPromotion) return;
  const { piece, square } = cast(ev);
  if (selected && square) {
    const target = legal.filter((m) => m.to === square);
    if (target.length) {
      if (target.some((m) => m.promotion)) { pendingPromotion = { from: selected.square, to: square }; hud.promotion(true); return; }
      void playMove(selected.square, square, '');
      return;
    }
  }
  if (piece && piece.side === you) select(piece);
  else clearSelection();
}

function select(piece: PieceView): void {
  clearSelection();
  selected = piece;
  piece.setHighlight(true);
  legal = match!.legalMoves().filter((m) => m.from === piece.square);
  board!.setSelected(piece.square);
  board!.showTargets(legal.map((m) => m.to), new Set(legal.filter((m) => m.captured).map((m) => m.to)));
  hud.showCard(piece.card, piece.type, web3.owned.has(piece.card.tokenId), piece.side);
  vfx!.select(piece.group.position, piece.color);
}

function clearSelection(): void {
  selected?.setHighlight(false);
  selected = null;
  legal = [];
  board?.setSelected(null);
  board?.clearTargets();
}

async function playMove(from: string, to: string, promotion: string): Promise<void> {
  if (!match) return;
  if (!match.act(encodeMove(from, to, promotion))) hud.toast('That move is not legal.');
}

// ------------------------------------------------------------------ camera
async function flyToSide(side: Side, quick: boolean): Promise<void> {
  if (!stage) return;
  const z = side === 0 ? 11.5 : -11.5;
  if (!quick) {
    // an opening sweep: from high and far, down behind your army
    stage.camera.position.set(side === 0 ? 9 : -9, 14, z * 1.4);
    stage.camera.lookAt(stage.controls.target);
  }
  await stage.flyTo(new THREE.Vector3(0, 9.2, z), quick ? 1.1 : 2.4);
}

// a little life on the title screen: the element colours drift through the accent lights
void (async () => {
  const colors = Object.values(ELEMENT_COLOR);
  let i = 0;
  setInterval(() => { if (stage && !match) stage.setAccentColors(colors[i % 4], colors[(i + 2) % 4]); i++; }, 4000);
})();

// ------------------------------------------------------------------ launch
if (launch.matchId) {
  // The LitNode arcade opened this page for a placed match: seat through the shell and play.
  void startRelay(() => RelayMatch.placed(events));
} else if (query.get('relay')) {
  void startRelay(() => RelayMatch.dev(events, query.get('relay')!, query.get('room') ?? 'lobby', query.get('name') ?? `player-${Math.floor(Math.random() * 1e6)}`));
}
