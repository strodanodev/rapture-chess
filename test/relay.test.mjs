// The relay in both modes: a dev room (two named players, a scholar's mate, an unsigned finish) and a gauntlet
// match (HMAC seat tickets like node/gauntlet.js mints them, the sign request, both signatures, the /ledger post
// to a stub node, the settled delta broadcast). The chess log shape is { k, inputs: [alliance, horde] }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

// the same encoding as src/rules/chessRules.ts: op 1 | from << 3 | to << 9
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (Number(s[1]) - 1) * 8;
const move = (from, to) => 1 | (sq(from) << 3) | (sq(to) << 9);
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
  const child = spawn(process.execPath, [tsxCli, 'relay/server.mts'], { cwd: root, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function play(a, b) {
  for (let i = 0; i < SCHOLARS.length; i++) {
    const mover = i % 2 === 0 ? a : b;
    mover.send({ t: 'act', x: move(...SCHOLARS[i]) });
    const ea = await a.next('entry'), eb = await b.next('entry');
    assert.equal(ea.entry.k, i);
    assert.deepEqual(ea.entry, eb.entry);
    assert.deepEqual(ea.entry.inputs, i % 2 === 0 ? [move(...SCHOLARS[i]), 0] : [0, move(...SCHOLARS[i])]);
  }
}

test('dev room: two named players, a scholar\'s mate, an unsigned finish', async () => {
  const relay = await startRelay({ RELAY_DEV: '1' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const a = client(url, { t: 'hello', room: 'test', player: 'alice' });
    const b = client(url, { t: 'hello', room: 'test', player: 'bob' });
    await a.hello();
    const seatedA = await a.next('seated');
    assert.equal(seatedA.side, 0);
    await b.hello();
    const startA = await a.next('start'), startB = await b.next('start');
    assert.equal(startA.seed, startB.seed);
    assert.deepEqual(startA.participants, ['alice', 'bob']);
    // not your turn
    b.send({ t: 'act', x: move('e7', 'e5') });
    assert.equal((await b.next('reject')).reason, 'not your turn');
    // illegal
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
    assert.equal(view.entries.length, 7);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); }
});

test('gauntlet match: tickets, signatures, the ledger post and the settled delta', async () => {
  // a stub node: accepts the ledger, checks its shape, answers with a delta
  const posts = [];
  const node = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      posts.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ matchId: posts[0].body.matchId, attestation: 'players', proof: 'verified', placed: true, scores: { p0: 1, p1: 0 } }));
    });
  });
  await new Promise((r) => node.listen(0, '127.0.0.1', r));
  const nodeUrl = `http://127.0.0.1:${node.address().port}`;
  const secret = 'a'.repeat(64);
  const matchId = 'c'.repeat(64);
  const seed = 'd'.repeat(64);
  const p0 = '1'.repeat(64), p1 = '2'.repeat(64);
  const mint = (claims) => { const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`; };
  const exp = Date.now() + 600_000;
  const relay = await startRelay({ GAUNTLET_SECRET: secret, GAUNTLET_MATCH_ID: matchId, GAUNTLET_SEED: seed, GAUNTLET_SEATS: JSON.stringify([{ sub: p0, team: 0, slot: 0 }, { sub: p1, team: 1, slot: 0 }]), GAUNTLET_NODE_URL: nodeUrl, GAUNTLET_BUILD: 'b'.repeat(64), GAUNTLET_PLACED_MODE: 'ranked' });
  try {
    const url = `ws://127.0.0.1:${relay.port}`;
    const bad = client(url, { t: 'hello', ticket: mint({ sub: p0, matchId, exp }).replace(/.$/, 'x') });
    await bad.hello();
    assert.match((await bad.next('error')).message, /bad ticket/);
    const a = client(url, { t: 'hello', ticket: mint({ sub: p0, matchId, team: 0, slot: 0, mode: 'singles', exp }) });
    const b = client(url, { t: 'hello', ticket: mint({ sub: p1, matchId, team: 1, slot: 0, mode: 'singles', exp }) });
    await a.hello(); await a.next('seated');
    await b.hello();
    const start = await a.next('start'); await b.next('start');
    assert.equal(start.seed, seed);
    assert.equal(start.matchId, matchId);
    assert.deepEqual(start.participants, [p0, p1]);
    await play(a, b);
    await a.next('over');
    const signA = await a.next('sign'), signB = await b.next('sign');
    assert.equal(signA.ticks, 7);
    assert.equal(signB.buildHash, 'b'.repeat(64));
    a.send({ t: 'sig', sig: 'e'.repeat(128) });
    b.send({ t: 'sig', sig: 'f'.repeat(128) });
    const settled = await a.next('settled');
    assert.equal(settled.delta.attestation, 'players');
    assert.equal(posts.length, 1);
    const sub = posts[0].body;
    assert.equal(posts[0].url, '/ledger');
    assert.equal(sub.rulesetId, 'rapture-chess.v1');
    assert.equal(sub.mode, 'ranked');
    assert.deepEqual(sub.participants, [p0, p1]);
    assert.equal(sub.entries.length, 7);
    assert.deepEqual(sub.signatures, { [p0]: 'e'.repeat(128), [p1]: 'f'.repeat(128) });
    for (let i = 0; i < 7; i++) assert.equal(sub.entries[i].k, i);
    a.ws.close(); b.ws.close();
  } finally { relay.stop(); node.close(); }
});
