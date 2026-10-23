/**
 * Build the LitNode title artifact for Rapture Chess.
 *
 *   node scripts/build-title.mjs            (LITNODE_DIR=../LITNODE/litnode by default)
 *
 * 1. esbuild inlines the rules and chess.js into one import-free ES module: titles/<rulesetId>.mjs
 *    (the same esbuild settings as LitNode's sdk/bundle.mjs, plus mainFields so chess.js resolves).
 * 2. LitNode's own tools/bundle-title.mjs takes that file, runs the conformance suite every node runs, and
 *    writes rulesets/<rulesetId>.js + .json with the buildHash the registry and the nodes pin. The id comes from
 *    src/litnode/chessTitle.ts (rapture-chess.v2); the v1 artifact stays pinned in rulesets/ and is never rebuilt.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const litnode = resolve(root, process.env.LITNODE_DIR ?? '../LITNODE/litnode');
const bundler = resolve(litnode, 'tools/bundle-title.mjs');
if (!existsSync(bundler)) { console.error(`LitNode checkout not found at ${litnode} (git clone https://github.com/strodanodev/litnode there, npm install, or set LITNODE_DIR)`); process.exit(2); }

const r = await build({
  entryPoints: [resolve(root, 'src/litnode/title.entry.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
  mainFields: ['module', 'main'], write: false, minify: false, treeShaking: true, legalComments: 'none', logLevel: 'silent',
});
const source = r.outputFiles[0].text.replace(/\/\/# sourceMappingURL=.*$/m, '');
mkdirSync(resolve(root, 'titles'), { recursive: true });
const id = /CHESS_RULESET_ID = '([^']+)'/.exec(readFileSync(resolve(root, 'src/litnode/chessTitle.ts'), 'utf8'))[1];
const title = resolve(root, `titles/${id}.mjs`);
writeFileSync(title, source);
console.log(`titles/${id}.mjs  ${source.length} bytes`);

const out = spawnSync(process.execPath, [bundler, title, '--out', resolve(root, 'rulesets')], { cwd: litnode, stdio: 'inherit' });
process.exit(out.status ?? 1);
