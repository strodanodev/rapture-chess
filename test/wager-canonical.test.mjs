// The browser's canonical() must produce the bytes LitNode signs: cross-check against the litnode checkout.
//   node --test test/wager-canonical.test.mjs       (LITNODE_DIR overrides ../LITNODE/litnode)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical } from '../src/web3/canonical.ts';

const here = dirname(fileURLToPath(import.meta.url));
const LITNODE_DIR = process.env.LITNODE_DIR ?? join(here, '..', '..', 'LITNODE', 'litnode');

const fixture = {
  z: 1, a: { d: [3, { y: null, x: undefined, w: () => 1, 'k k': 'v' }], c: 'é"\\\n\t' }, m: [1, 'two', { b: 0.5, a: true }, [], {}], u: undefined, f() {},
  scores: { ['f'.repeat(64)]: 1, ['0'.repeat(64)]: 0 }, participants: ['f'.repeat(64), '0'.repeat(64)], n: -0, big: 1e21, small: 1e-7,
};

test('sorted keys, dropped undefined and functions', () => {
  assert.equal(canonical(fixture), '{"a":{"c":"é\\"\\\\\\n\\t","d":[3,{"k k":"v","y":null}]},"big":1e+21,"m":[1,"two",{"a":true,"b":0.5},[],{}],"n":0,"participants":["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","0000000000000000000000000000000000000000000000000000000000000000"],"scores":{"0000000000000000000000000000000000000000000000000000000000000000":0,"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff":1},"small":1e-7,"z":1}');
});

test('matches litnode/protocol/canonical.js', async (t) => {
  const file = join(LITNODE_DIR, 'protocol', 'canonical.js');
  if (!existsSync(file)) { t.skip(`no litnode checkout at ${LITNODE_DIR}`); return; }
  const theirs = await import(pathToFileURL(file).href);
  assert.equal(canonical(fixture), theirs.canonical(fixture));
  const delta = { protocol: 4, matchId: 'ab'.repeat(32), scores: { b: 0.5, a: 0.5 }, hydrationManifest: { entries: [{ stats: { strength: 1 }, tokenId: 'x' }], manifestHash: null }, signatures: {}, stats: null };
  assert.equal(canonical(delta), theirs.canonical(delta));
});
