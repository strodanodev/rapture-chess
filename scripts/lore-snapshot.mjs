/**
 * Add each champion's lore and provenance to public/data/collection.json, read from the chain.
 *
 *   node scripts/lore-snapshot.mjs            (IPFS_GATEWAY=https://gateway.pinata.cloud/ipfs by default)
 *
 * For every card: tokenURI on the Rapture ARC 1 contract (on-chain base64 JSON) gives the bio, Path, Alignment, Frame,
 * Kit and the content hashes (design, art, avatar, soul). The soul is a markdown file on IPFS whose keccak256 the token
 * pins; it is fetched, checked against that hash, and its Voice / Values / In a fight lines become the card's lore.
 * A soul that does not match its hash is left out (the card keeps its on-chain bio).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';

const root = resolve(import.meta.dirname, '..');
const file = resolve(root, 'public/data/collection.json');
const GATEWAY = (process.env.IPFS_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '');
const snap = JSON.parse(readFileSync(file, 'utf8'));
// verified souls and token metadata are content-addressed, so they are cached (re-runs only re-parse)
const cache = resolve(root, 'node_modules/.cache/rapture-lore');
mkdirSync(cache, { recursive: true });
const { rpc, address } = snap.collection;

// The public Liteforge RPC rate-limits ("Bandwidth limit exceeded"): alternate with the fallback and back off.
const RPCS = [rpc, 'https://liteforge.rpc.caldera.xyz/infra-partner-http'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(what, fn, tries = 8) {
  for (let i = 0; ; i++) {
    try { return await fn(i); } catch (e) { if (i + 1 >= tries) throw e; console.warn(`${what}: ${e.message}, retrying`); await sleep(1500 * (i + 1)); }
  }
}

async function tokenMeta(tokenId) {
  const cached = resolve(cache, `meta-${tokenId}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const meta = await fetchMeta(tokenId);
  writeFileSync(cached, JSON.stringify(meta));
  return meta;
}

async function fetchMeta(tokenId) {
  const data = `0xc87b56dd${BigInt(tokenId).toString(16).padStart(64, '0')}`;
  const r = await retry(`tokenURI(${tokenId})`, async (i) => {
    const x = await fetch(RPCS[i % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data }, 'latest'] }) }).then((res) => res.json());
    if (!x.result) throw new Error(JSON.stringify(x.error ?? x));
    return x;
  });
  const hex = r.result.slice(2);
  const len = parseInt(hex.slice(64, 128), 16);
  const uri = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
  if (!uri.startsWith('data:application/json;base64,')) throw new Error(`tokenURI(${tokenId}) is not inline JSON`);
  return JSON.parse(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8'));
}

const cidOf = (ipfsUri) => /^ipfs:\/\/([^/]+)\//.exec(ipfsUri ?? '')?.[1] ?? null;
const hexOf = (bytes) => `0x${Buffer.from(bytes).toString('hex')}`;

/**
 * The soul → { quote, story, voice, values, temperament, battle, weakness }. The souls are free-form generated markdown
 * in several styles: `**Voice:**`, `- Voice:`, plain `Voice:` or `## Voice` / `## Core Voice` / `## Fighting
 * Temperament` / `[Voice]` sections (also Values, Temperament, Tactics, Weakness, In a fight, Voice in play), bulleted or
 * numbered, or a narrative followed by `In a fight:`. Each opens with a title that repeats the stats; it is dropped, and
 * stat figures inside the text are removed (the cards show lore, not numbers). `quote` is the champion's own line in
 * italics; `story` is the narrative of a soul without Voice/Values sections. A run of one-word dash fragments (a
 * generation that looped) ends the text.
 */
const SECTION = /##\s+((?:[A-Za-z]+\s+){0,2}?(?:Voice in play|Voice|Values|Temperament|Tactics|Weakness|In a fight|Fighting|Battle))\b\s*:?|\*{1,2}(Voice in play|Voice|Values|Temperament|Tactics|Weakness|In a fight)\s*:?\s*\*{1,2}\s*:?|(?:\s-\s*|\s)(Voice in play|Voice|Values|Temperament|Tactics|Weakness|In a fight)\s*:|\[((?:[A-Za-z]+\s+){0,2}?(?:Voice in play|Voice|Values|Temperament|Tactics|Weakness|In a fight|Fighting|Battle)[A-Za-z ]*)\]/g;
const KEY = [['voice in play', 'play'], ['voice', 'voice'], ['value', 'values'], ['fight', 'battle'], ['tactic', 'battle'], ['battle', 'battle'], ['temperament', 'temperament'], ['weak', 'weakness']];
const keyOf = (title) => KEY.find(([k]) => title.toLowerCase().includes(k))?.[1] ?? null;
const STAT_WORD = { str: 'strength', agi: 'agility', res: 'resilience', int: 'intelligence' };

function clean(v, { italics = 'keep' } = {}) {
  if (!v) return null;
  // generation residue (the prompt that wrote the soul) is not lore
  if (/chars?|do not add|SOUL\.MD|markdown|AI play/i.test(v)) return null;
  const unbold = v.replace(/\*\*([^*]+)\*\*/g, '$1');
  const out = (italics === 'drop' ? unbold.replace(/\*([^*]+)\*/g, '') : unbold.replace(/\*([^*]+)\*/g, '$1'))
    .replace(/\*/g, '').replace(/#+\s*/g, '')
    .replace(/(^|\s{2,}|\s)[—–]\s+(?=[A-Z'])/g, '$1')          // bullets
    .replace(/(^|\s)\d+\.\s+(?=[A-Z'])/g, '$1')                // numbered items
    .replace(/(^|\s)-\s+(?=[A-Z'])/g, '$1')
    .replace(/\b(STR|AGI|RES|INT)\b\s*\d{3,}/g, (_m, k) => STAT_WORD[k.toLowerCase()])
    .replace(/\b(strength|agility|resilience|intelligence)\s+\(?\d{3,}\)?/gi, '$1')
    .replace(/\s*\(\d{3,}\)/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[—–:,.)\-\s]+/, '').replace(/\s*[-;:,—–]$/, '');
  return out.length >= 12 ? out : null;
}

function parseSoul(md) {
  let text = ` ${md.replace(/\r?\n/g, '  ').trim()} `;
  const loop = /(?:\s[—–]\s*[\w']+){8,}/.exec(text);
  if (loop) text = text.slice(0, loop.index);
  const marks = [...text.matchAll(SECTION)];
  const sec = {};
  marks.forEach((m, i) => {
    const key = keyOf(m[1] ?? m[2] ?? m[3] ?? m[4]);
    const body = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length);
    if (key && !sec[key]) sec[key] = body;
  });
  // the title and its stats: up to the last stats figure, or else the title's first sentence
  let lead = text.slice(0, marks[0]?.index ?? text.length).trim();
  const stats = [...lead.matchAll(/(?:\b(?:INT(?:ELLIGENCE)?|I)\b\s*\d{3,}|\d+\/\d+\/\d+\/\d+)[^.]*?\.?/gi)].pop();
  if (stats) lead = lead.slice(stats.index + stats[0].length);
  else if (lead.startsWith('#')) lead = lead.replace(/^#.*?[.!?](?:\s|$)/, '');
  // what is left of the title (a clause or a closing parenthesis) runs to the end of its sentence
  lead = lead.trim();
  if (lead.startsWith(':')) lead = lead.slice(1).trim();   // "Strength … Intelligence 32152: a slow, patient wall of water…"
  else if (/^[a-z)(;,—–-]/.test(lead)) lead = lead.replace(/^.*?[.!?]\)?(?:\s+|$)/, '');
  const quoteOf = (v) => /\*([^*]{8,})\*/.exec(v ?? '')?.[1]?.trim() ?? null;
  return {
    quote: quoteOf(sec.play) ?? quoteOf(sec.voice),
    story: sec.voice || sec.values ? null : clean(lead),
    voice: clean(sec.voice, { italics: 'drop' }),
    values: clean(sec.values),
    temperament: clean(sec.temperament),
    battle: clean(sec.battle),
    weakness: clean(sec.weakness),
  };
}

let verified = 0;
for (const card of snap.cards) {
  const meta = await tokenMeta(card.tokenId);
  const trait = (t) => meta.attributes?.find((a) => a.trait_type === t)?.value ?? null;
  const lore = {
    bio: meta.bio ?? meta.description ?? null,
    path: trait('Path'), alignment: trait('Alignment'), frame: trait('Frame'), kit: trait('Kit'),
    quote: null, story: null, voice: null, values: null, temperament: null, battle: null, weakness: null,
    soulHash: meta.soul?.keccak256 ?? null,
    designHash: meta.rapture?.design?.hash ?? null,
    artHash: meta.rapture?.design?.art ?? null,
    avatarHash: meta.avatar?.sha256 ?? null,
    soulVerified: false,
  };
  const cid = cidOf(meta.image);
  if (cid && meta.soul?.file && lore.soulHash) {
    try {
      const soulFile = resolve(cache, `${lore.soulHash.toLowerCase()}.md`);
      const { res, bytes } = existsSync(soulFile) ? { res: { ok: true, status: 200 }, bytes: new Uint8Array(readFileSync(soulFile)) } : await retry(`${card.slug} soul`, async () => {
        const res = await fetch(`${GATEWAY}/${cid}/${meta.soul.file}`);
        if (res.status === 429 || res.status >= 500) throw new Error(`gateway ${res.status}`);
        return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
      });
      if (res.ok && hexOf(keccak_256(bytes)) === lore.soulHash.toLowerCase()) {
        writeFileSync(soulFile, bytes);
        Object.assign(lore, parseSoul(new TextDecoder().decode(bytes)), { soulVerified: true });
        verified++;
      } else console.warn(`${card.slug}: soul ${res.status} does not match its on-chain hash, left out`);
    } catch (e) { console.warn(`${card.slug}: soul unavailable (${e.message})`); }
  }
  card.lore = lore;
  process.stdout.write(`${card.slug.padEnd(18)} ${lore.path ?? '-'} · ${lore.alignment ?? '-'} · soul ${lore.soulVerified ? 'verified' : 'missing'}\n`);
}
snap.collection.loreAt = new Date().toISOString();
writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
console.log(`${snap.cards.length} cards, ${verified} souls verified against their on-chain keccak256 → ${file}`);
