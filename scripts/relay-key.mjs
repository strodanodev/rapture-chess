/**
 * The relay's own ed25519 key: what lets a match settle when the loser never signs the ledger. The relay signs
 * LitNode's RELAY_TAG body ({ matchId, head, ticks, expected }) with it, and a node whose RELAY_KEYS lists the public
 * key settles that ledger as `attestation: "relay"` (ranked included).
 *
 *   node scripts/relay-key.mjs            create .relay-key.json if missing (gitignored) and print the node.env line
 *   node scripts/relay-key.mjs --show     print the line for the existing key
 *
 * The relay reads the key from CHESS_RELAY_KEY (the 32-byte seed as hex) or from .relay-key.json in its cwd
 * (CHESS_RELAY_KEY_FILE to point elsewhere). Keep the file private: whoever holds it can attest results on the nodes
 * that trust it.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '..', process.env.CHESS_RELAY_KEY_FILE ?? '.relay-key.json');
if (!existsSync(file)) {
  if (process.argv.includes('--show')) { console.error(`${file} does not exist: run without --show to create it`); process.exit(1); }
  const kp = generateKeyPairSync('ed25519');
  const privateKey = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');
  const publicKey = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  writeFileSync(file, `${JSON.stringify({ publicKey, privateKey, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`created ${file}`);
}
const { publicKey } = JSON.parse(readFileSync(file, 'utf8'));
console.log(`add to the chess node's node.env (comma-separate with any keys already there):\nRELAY_KEYS=${publicKey}`);
