// The relay: dev rooms (untimed, draw offers), gauntlet matches under v1 (no clock in the log) and v2 (the time
// control and clock stamps in the log, flags), HMAC seat tickets like node/gauntlet.js mints them, the sign request,
// and settlement that never waits on the loser: players → relay key → host, with the signatures that did arrive
// broadcast for the escrow. The chess log shape is { k, inputs: [alliance, horde] }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const litnode = join(root, '../LITNODE/litnode');

// the same encodings as src/rules/chessRules.ts
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (Number(s[1]) - 1) * 8;
const move = (from, to) => 1 | (sq(from) << 3) | (sq(to) << 9);
const OFFER = 3, ACCEPT = 4;
const actionOf = (inputs) => inputs.find((w) => w && (w & 7) !== 7) ?? 0;
const stampOf = (inputs) => inputs.find((w) => (w & 7) === 7);
const SCHOLARS = [['e2', 'e4'], ['e7', 'e5'], ['f1', 'c4'], ['b8', 'c6'], ['d1', 'h5'], ['g8', 'f6'], ['h5', 'f7']];

function client(url, hello) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); inbox.push(m); for (const w of waiters.splice(0)) w(); });
  const next = (t, timeoutMs = 8000) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}; got ${inbox.map((m) => m.t).join(',')}`)), timeoutMs);
    const poll = () => { const i = inbox.findIndex((m) => m.t === t); if (i >= 0) { clearTimeout(timer); res(inbox.splice(i, 1)[0]); } else waiters.push(poll); };
    poll();
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const ready = new Promise((res) => ws.once('open', res));
  return { ws, next, send, ready, inbox, hello: async () => { await ready; send(hello); } };
}

async function startRelay(env) {
  const port = 7900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [tsxCli, 'relay/server.mts'], { cwd: root, env: { ...process.env, PORT: String(port), CHESS_RELAY_KEY_FILE: 'no-such-file.json', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (out.join('').includes('[chess relay]')) break;
    if (child.exitCode != null) throw new Error(`relay exited: ${out.join('')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, out, stop: () => child.kill() };
}

/** Play the scholar's mate; `k0` is the first move's entry index (1 when entry 0 sets the time control). */
async function play(a, b, k0 = 0, moves = SCHOLARS) {
  for (let i = 0; i < moves.length; i++) {
    const mover = i % 2 === 0 ? a : b;
    mover.send({ t: 'act', x: move(...moves[i]) });
    const ea = await a.next('entry'), eb = await b.next('entry');
    assert.equal(ea.entry.k, k0 + i);
    assert.deepEqual(ea.entry, eb.entry);
    assert.equal(ea.entry.inputs[i % 2], move(...moves[i]));
    assert.equal(actionOf(ea.entry.inputs), move(...moves[i]));
  }
}

/** A stub LitNode: records /ledger posts; `answer(body, n)` returns [status, json]. */
async function stubNode(answer) {
  const posts = [];
  const node = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const b = JSON.parse(body);
      posts.push({ url: req.url, body: b });
      const [status, json] = answer(b, posts.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => node.listen(0, '127.0.0.1', r));
  return { posts, url: `http://127.0.0.1:${node.address().port}`, close: () => node.close() };
}

const secret = 'a'.repeat(64);
const matchId = 'c'.repeat(64);
const p0 = '1'.repeat(64), p1 = '2'.repeat(64);
const mint = (claims) => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
const gauntletEnv = (nodeUrl, extra) => ({
  GAUNTLET_SECRET: secret, GAUNTLET_MATCH_ID: matchId, GAUNTLET_SEED: 'd'.repeat(64), GAUNTLET_SEATS: JSON.stringify([{ sub: p0, team: 0, slot: 0 }, { sub: p1, team: 1, slot: 0 }]),
  GAUNTLET_NODE_URL: nodeUrl, GAUNTLET_BUILD: 'b'.repeat(64), GAUNTLET_PLACED_MODE: 'casual', ...extra,
});
async function seatBoth(url) {
  const exp = Date.now() + 600_000;
  const a = client(url, { t: 'hello', ticket: mint({ sub: p0, matchId, team: 0, slot: 0, mode: 'singles', exp }) });
  const b = client(url, { t: 'hello', ticket: mint({ sub: p1, matchId, team: 1, slot: 0, mode: 'singles', exp }) });
  await a.hello(); await a.next('seated');
  await b.hello();
  const start = await a.next('start'); await b.next('start');
  return { a, b, start };
}

test('dev room (untimed v2): turn order, illegal moves, a scholar\'s mate, an unsigned finish', async () => {
  const relay = await startRelay({ RELAY_DEV: '1', CHESS_TC: 'none' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const a = client(url, { t: 'hello', room: 'test', player: 'alice' });
    const b = client(url, { t: 'hello', room: 'test', player: 'bob' });
    await a.hello();
    assert.equal((await a.next('seated')).side, 0);
    await b.hello();
    const startA = await a.next('start'), startB = await b.next('start');
    assert.equal(startA.seed, startB.seed);
    assert.equal(startA.rulesetId, 'rapture-chess.v2');
    assert.equal(startA.tc, null);
    assert.deepEqual(startA.participants, ['alice', 'bob']);
    b.send({ t: 'act', x: move('e7', 'e5') });
    assert.equal((await b.next('reject')).reason, 'not your turn');
    a.send({ t: 'act', x: move('e2', 'e5') });
    assert.equal((await a.next('reject')).reason, 'illegal');
    await play(a, b);
    const over = await a.next('over');
    assert.equal(over.winner, 0);
    assert.equal(over.reason, 'checkmate');
    await a.next('sign');
    const settled = await a.next('settled');
    assert.equal(settled.dev, true);
    assert.equal(settled.entries.length, 7);
    const view = await fetch(`http://127.0.0.1:${relay.port}/match/test`).then((r) => r.json());
    assert.equal(view.over, true);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('dev room: a draw offer, a premature accept refused, the acceptance', async () => {
  const relay = await startRelay({ RELAY_DEV: '1', CHESS_TC: 'none' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const a = client(url, { t: 'hello', room: 'draw', player: 'alice' });
    const b = client(url, { t: 'hello', room: 'draw', player: 'bob' });
    await a.hello(); await a.next('seated'); await b.hello(); await a.next('start'); await b.next('start');
    b.send({ t: 'act', x: ACCEPT });
    assert.match((await b.next('reject')).reason, /no draw offer/);
    b.send({ t: 'act', x: OFFER });                       // out of turn: allowed
    const offered = await a.next('entry'); await b.next('entry');
    assert.equal(offered.entry.inputs[1], OFFER);
    a.send({ t: 'act', x: ACCEPT });
    await a.next('entry');
    const over = await a.next('over');
    assert.equal(over.winner, 2);
    assert.equal(over.reason, 'agreement');
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('gauntlet v1 match: no clock in the log, draw offers refused, both signatures, the players ledger', async () => {
  const node = await stubNode(() => [200, { matchId, attestation: 'players', proof: 'verified', placed: true, scores: { [p0]: 1, [p1]: 0 } }]);
  const relay = await startRelay(gauntletEnv(node.url, { GAUNTLET_RULESET: 'rapture-chess.v1', GAUNTLET_PLACED_MODE: 'ranked' }));
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const bad = client(url, { t: 'hello', ticket: mint({ sub: p0, matchId, exp: Date.now() + 600_000 }).replace(/.$/, 'x') });
    await bad.hello();
    assert.match((await bad.next('error')).message, /bad ticket/);
    const { a, b, start } = await seatBoth(url);
    assert.equal(start.rulesetId, 'rapture-chess.v1');
    assert.equal(start.entries.length, 0);
    assert.deepEqual(start.participants, [p0, p1]);
    a.send({ t: 'act', x: OFFER });
    assert.match((await a.next('reject')).reason, /rapture-chess\.v2/);
    await play(a, b);
    await a.next('over');
    const signA = await a.next('sign'); await b.next('sign');
    assert.equal(signA.ticks, 7);
    a.send({ t: 'sig', sig: 'e'.repeat(128) });
    b.send({ t: 'sig', sig: 'f'.repeat(128) });
    const settled = await a.next('settled');
    assert.equal(settled.delta.attestation, 'players');
    assert.equal(node.posts.length, 1);
    const sub = node.posts[0].body;
    assert.equal(node.posts[0].url, '/ledger');
    assert.equal(sub.rulesetId, 'rapture-chess.v1');
    assert.equal(sub.mode, 'ranked');
    assert.deepEqual(sub.signatures, { [p0]: 'e'.repeat(128), [p1]: 'f'.repeat(128) });
    for (const e of sub.entries) assert.equal(e.inputs.filter((w) => w).length, 1);   // no stamps in v1
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});

test('gauntlet v2 match: the time control opens the log, every move is stamped, both sign', async () => {
  const node = await stubNode(() => [200, { matchId, attestation: 'players', proof: 'verified', placed: true }]);
  const relay = await startRelay(gauntletEnv(node.url, { GAUNTLET_RULESET: 'rapture-chess.v2', CHESS_TC: '3+2' }));
  try {
    const { a, b, start } = await seatBoth(`ws://127.0.0.1:${relay.port}`);
    assert.equal(start.rulesetId, 'rapture-chess.v2');
    assert.deepEqual(start.tc, { base: 180_000, inc: 2_000 });
    assert.equal(start.entries.length, 1);
    assert.equal(start.entries[0].inputs[0] & 7, 6);
    assert.equal(start.firstMove, true);
    await play(a, b, 1);
    await a.next('over');
    await a.next('sign'); await b.next('sign');
    a.send({ t: 'sig', sig: 'e'.repeat(128) });
    b.send({ t: 'sig', sig: 'f'.repeat(128) });
    await a.next('settled');
    const sub = node.posts[0].body;
    assert.equal(sub.rulesetId, 'rapture-chess.v2');
    assert.equal(sub.entries.length, 8);
    for (const e of sub.entries.slice(1)) assert.notEqual(stampOf(e.inputs), undefined);
    assert.equal(stampOf(sub.entries[1].inputs) >>> 3, 0);              // first moves are off the clock
    assert.equal(stampOf(sub.entries[2].inputs) >>> 3, 0);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});

test('a flag: the side to move runs out, the bare stamp ends the game', async () => {
  const node = await stubNode(() => [200, { matchId, attestation: 'players', proof: 'verified' }]);
  const relay = await startRelay(gauntletEnv(node.url, { GAUNTLET_RULESET: 'rapture-chess.v2', CHESS_TC: '0.02+0' }));   // 1 s (whole seconds)
  try {
    const { a, b } = await seatBoth(`ws://127.0.0.1:${relay.port}`);
    await play(a, b, 1, SCHOLARS.slice(0, 2));
    const flag = await a.next('entry', 5000);
    assert.equal(actionOf(flag.entry.inputs), 0);
    assert.ok((stampOf(flag.entry.inputs) >>> 3) >= 1000);
    const over = await a.next('over');
    assert.equal(over.winner, 1);
    assert.equal(over.reason, 'timeout');
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});

test('the loser leaves without signing: the relay key, then the host, and the winner\'s signature for the escrow', async () => {
  // the node refuses the relay (as one whose RELAY_KEYS does not list it would) and takes the host attestation
  const node = await stubNode((b) => (b.relay ? [400, { error: 'relay is not a relay this host trusts' }] : [200, { matchId, attestation: 'host', proof: 'replayed', placed: true }]));
  const seed = '9'.repeat(64);
  const relay = await startRelay(gauntletEnv(node.url, { GAUNTLET_RULESET: 'rapture-chess.v2', CHESS_TC: '3+2', CHESS_RELAY_KEY: seed, CHESS_SIGN_MS: '3000' }));
  try {
    const { a, b } = await seatBoth(`ws://127.0.0.1:${relay.port}`);
    await play(a, b, 1);
    await a.next('over');
    b.ws.close();                                          // Black, mated, leaves before signing
    await a.next('sign');
    a.send({ t: 'sig', sig: 'e'.repeat(128) });
    const settled = await a.next('settled', 8000);
    assert.equal(settled.delta.attestation, 'host');
    assert.deepEqual(settled.signatures, { [p0]: 'e'.repeat(128) });
    assert.equal(node.posts.length, 2);
    const [viaRelay, viaHost] = node.posts.map((p) => p.body);
    assert.equal(viaRelay.signatures, undefined);         // partial signatures would be refused outright
    assert.match(viaRelay.relay.id, /^[0-9a-f]{64}$/);
    assert.equal(viaHost.relay, undefined);
    assert.equal(viaHost.signatures, undefined);
    // exactly what LitNode's settle.js checks: RELAY_TAG over { matchId, head, ticks, expected } with its own chainHead
    if (existsSync(join(litnode, 'protocol/log.js'))) {
      const { chainHead } = await import(pathToFileURL(join(litnode, 'protocol/log.js')).href);
      const { verify } = await import(pathToFileURL(join(litnode, 'protocol/keys.js')).href);
      const body = { matchId, head: chainHead(viaRelay.entries), ticks: viaRelay.entries.length, expected: null };
      assert.equal(await verify('relay', body, viaRelay.relay.sig, viaRelay.relay.id), true);
      // and LitNode's own sandbox replays the clocked log through the built v2 ruleset to the same result
      const ruleset = join(root, 'rulesets/rapture-chess.v2.js');
      if (existsSync(ruleset)) {
        const { createSandbox } = await import(pathToFileURL(join(litnode, 'node/sandbox.js')).href);
        const { readFileSync } = await import('node:fs');
        const r = await createSandbox().one(readFileSync(ruleset, 'utf8'), { kind: 'replay', seed: 'd'.repeat(64), participants: [p0, p1], entries: viaRelay.entries, maxTicks: 2000 });
        assert.equal(r.done, true);
        assert.deepEqual(r.scores, { [p0]: 1, [p1]: 0 });
        const final = JSON.parse(r.serialized);
        assert.equal(final.reason, 'checkmate');
        assert.deepEqual(final.tc, { base: 180_000, inc: 2_000 });
      }
    }
    a.ws.close();
  } finally { relay.stop(); node.close(); }
});
