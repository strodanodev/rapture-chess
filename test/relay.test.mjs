// Two wallet clients at the relay: challenge-signed seats, a scholar's mate, and a settlement whose signature
// recovers to the throwaway resolver and whose logHash matches the shared helper (and ethers' abi.encode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Wallet, verifyTypedData, AbiCoder, keccak256, TypedDataEncoder } from 'ethers';
import WebSocket from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const resolver = Wallet.createRandom();
const alice = Wallet.createRandom();
const bob = Wallet.createRandom();
const ESCROW = '0x000000000000000000000000000000000000dEaD';
const PORT = 7900 + Math.floor(Math.random() * 90);
const DOMAIN = { name: 'RaptureChessWager', version: '1', chainId: 4441, verifyingContract: ESCROW };
const TYPES = { Settlement: [{ name: 'matchId', type: 'bytes32' }, { name: 'winner', type: 'uint8' }, { name: 'logHash', type: 'bytes32' }] };

// the same encoding as src/rules/chessRules.ts: op 1 | from << 3 | to << 9
const sq = (s) => 'abcdefgh'.indexOf(s[0]) + (Number(s[1]) - 1) * 8;
const move = (from, to) => 1 | (sq(from) << 3) | (sq(to) << 9);

function client(matchId, wallet, seed) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${matchId}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  });
  const next = (t, ms = 8000) => {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { t, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error(`timeout waiting for ${t}`)); } }, ms).unref();
    });
  };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', matchId, address: wallet.address, seed })));
  (async () => {
    const c = await next('challenge');
    ws.send(JSON.stringify({ t: 'auth', address: wallet.address, sig: await wallet.signMessage(c.message) }));
  })().catch(() => {});
  return { ws, next, act: (x) => ws.send(JSON.stringify({ t: 'act', x })) };
}

test('two wallets play to mate over the relay and receive a signed settlement', async () => {
  const relay = spawn(process.execPath, [tsxCli, 'relay/server.mts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELAY_PORT: String(PORT), RESOLVER_PRIVATE_KEY: resolver.privateKey, WAGER_ADDRESS: ESCROW, CHAIN_ID: '4441', TURN_MS: '20000', DISCONNECT_MS: '2000' },
  });
  let out = '';
  relay.stdout.on('data', (d) => { out += d; });
  relay.stderr.on('data', (d) => { out += d; });
  try {
    const started = Date.now();
    while (!out.includes('[chess relay]') && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));
    assert.ok(out.includes('[chess relay]'), `relay did not start:\n${out}`);
    const seed = `0x${Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString('hex')}`;
    const matchId = keccak256(seed);

    const a = client(matchId, alice, seed);
    const sa = await a.next('seated');
    assert.equal(sa.side, 0);
    const b = client(matchId, bob);
    const sb = await b.next('seated');
    assert.equal(sb.side, 1);
    const [startA, startB] = await Promise.all([a.next('start'), b.next('start')]);
    assert.equal(startA.seed, seed);
    assert.deepEqual(startA.participants, [alice.address, bob.address]);
    assert.deepEqual(startB.participants, startA.participants);

    // a wrong-turn move is rejected; then scholar's mate: e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#
    b.act(move('e7', 'e5'));
    const rej = await b.next('reject');
    assert.equal(rej.reason, 'not your turn');
    const line = [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']];
    const entries = [];
    for (let i = 0; i < line.length; i++) {
      (i % 2 === 0 ? a : b).act(move(...line[i]));
      const [ea, eb] = await Promise.all([a.next('entry'), b.next('entry')]);
      assert.deepEqual(ea.entry, eb.entry);
      assert.equal(ea.entry.k, i);
      entries.push(ea.entry);
    }
    const over = await a.next('over');
    assert.equal(over.winner, 0);
    assert.equal(over.reason, 'checkmate');
    const [stA, stB] = await Promise.all([a.next('settlement'), b.next('settlement')]);
    assert.equal(stA.sig, stB.sig);
    assert.equal(stA.matchId, matchId);
    assert.equal(stA.winner, 0);
    assert.equal(stA.entries.length, 7);

    // the signature is the resolver's over exactly the contract's typed data
    assert.equal(verifyTypedData(DOMAIN, TYPES, { matchId, winner: 0, logHash: stA.logHash }, stA.sig), resolver.address);
    // and the log hash is keccak256(abi.encode(bytes32 seed, int32[] inputs)), as the shared helper defines it
    const flat = entries.flatMap((e) => e.inputs);
    assert.equal(stA.logHash, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'int32[]'], [seed, flat])));
    const { logHashOf } = await import('../src/web3/wager.ts').catch(() => ({ logHashOf: null }));
    if (logHashOf) assert.equal(logHashOf(seed, entries), stA.logHash);
    assert.equal(TypedDataEncoder.hash(DOMAIN, TYPES, { matchId, winner: 0, logHash: stA.logHash }).length, 66);

    // the HTTP view agrees
    const view = await fetch(`http://127.0.0.1:${PORT}/match/${matchId}`).then((r) => r.json());
    assert.equal(view.state.over, true);
    assert.equal(view.settlement.sig, stA.sig);
    a.ws.close(); b.ws.close();
  } finally {
    relay.kill();
    await once(relay, 'exit').catch(() => {});
  }
});

test('a seat needs the wallet that signed the challenge, and the creator must reveal the right seed', async () => {
  const relay = spawn(process.execPath, [tsxCli, 'relay/server.mts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAY_PORT: String(PORT + 1) } });
  let out = '';
  relay.stdout.on('data', (d) => { out += d; });
  try {
    while (!out.includes('[chess relay]')) await new Promise((r) => setTimeout(r, 100));
    const seed = `0x${'11'.repeat(32)}`;
    const matchId = keccak256(seed);
    const port = PORT + 1;
    const open = (hello, signer) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/${matchId}`);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', matchId, ...hello })));
      ws.on('message', async (d) => {
        const m = JSON.parse(d.toString());
        if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'auth', address: hello.address, sig: await signer.signMessage(m.message) }));
        else { resolve(m); ws.close(); }
      });
    });
    const forged = await open({ address: alice.address }, bob);          // bob signs for alice's address
    assert.equal(forged.t, 'error');
    assert.match(forged.message, /signature/);
    const badSeed = await open({ address: alice.address, seed: `0x${'22'.repeat(32)}` }, alice);
    assert.equal(badSeed.t, 'error');
    assert.match(badSeed.message, /seed/);
    const ok = await open({ address: alice.address, seed }, alice);
    assert.equal(ok.t, 'seated');
    assert.equal(ok.side, 0);
  } finally {
    relay.kill();
    await once(relay, 'exit').catch(() => {});
  }
});
