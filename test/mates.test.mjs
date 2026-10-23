// Every position on the main menu's board is a real checkmate: replay each game's moves (or load its FEN) with chess.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const src = readFileSync(new URL('../src/scene/mates.ts', import.meta.url), 'utf8');
const entries = [...src.matchAll(/name: '((?:[^'\\]|\\.)*)'[\s\S]*?(moves|fen):\s*'([^']+)'/g)].map((m) => ({ name: m[1].replace(/\\'/g, "'"), kind: m[2], value: m[3] }));

test('the menu mates are all checkmate', () => {
  assert.ok(entries.length >= 8);
  for (const e of entries) {
    const c = new Chess(e.kind === 'fen' ? e.value : undefined);
    if (e.kind === 'moves') for (const san of e.value.split(' ')) assert.ok(c.move(san), `${e.name}: illegal ${san}`);
    assert.ok(c.isCheckmate(), `${e.name} does not end in mate`);
  }
});
