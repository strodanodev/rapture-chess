// LitNodeWager: stakes bound to LitNode player keys, paid out on a host node's signed delta.
// The delta is built the way node/settle.js builds it and signed with a real ed25519 key over
// "delta\0" + canonical(body) (protocol/keys.js signingBytes); canonical() is cross-checked against
// the litnode checkout's protocol/canonical.js when it is present.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { ethers, network } = require("hardhat");

const LITNODE_DIR = process.env.LITNODE_DIR ?? join(__dirname, "..", "..", "..", "LITNODE", "litnode");
const RULESET = "rapture-chess.v1";
const DELAY = 4000n;
const ONE = ethers.parseEther("1");

/** litnode protocol/canonical.js, verbatim in spirit: sorted keys, undefined and functions dropped. */
const canonical = (value) => JSON.stringify(value, (_k, v) => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined && typeof v[k] !== "function") out[k] = v[k];
    return out;
  }
  return v;
});

function nodeKey() {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  return { pub, sign: (bytes) => crypto.sign(null, bytes, kp.privateKey).toString("hex") };
}
const hex64 = () => crypto.randomBytes(32).toString("hex");
const b32 = (h) => `0x${h}`;

/** A delta body as node/settle.js `finish` signs it (every field the node writes, in its shape). */
function deltaBody({ matchId, host, a, b, scores, overrides = {} }) {
  return {
    protocol: 4, matchId, rulesetId: RULESET, buildHash: hex64(), kind: "replayable", mode: "ranked", placed: true, descriptorHash: hex64(),
    participants: [a, b], teams: null, seed: hex64(), ticks: 57, complete: true, head: hex64(),
    signatures: { [a]: hex64() + hex64(), [b]: hex64() + hex64() }, attestation: "players", attestor: null, relay: null,
    hydrationManifest: { manifestHash: hex64(), mode: "ranked", balanceVersion: "bal-chess-v1", sterile: true, pinHash: null,
      entries: [{ tokenId: `external:${a}`, source: "external", stats: { strength: 0, agility: 0, resilience: 0, intelligence: 0 }, statsNonce: null, soulManifestHash: null },
        { tokenId: `external:${b}`, source: "external", stats: {}, statsNonce: null, soulManifestHash: null }] },
    hydrationHash: hex64(), hydrationSource: "external", finalStateRoot: hex64(), engineHash: null,
    scores, proof: "verified", stats: { [a]: { matches: 1, wins: 1 }, [b]: { matches: 1, wins: 0, scores: 7 } }, statsSchema: { matches: "sum", wins: "sum" }, commitments: null,
    hostId: host.pub, epoch: 497000, settledAt: "2026-10-23T03:14:15.926Z", resultHash: hex64(),
    ...overrides,
  };
}
const signDelta = (body, host) => {
  const json = canonical(body);
  return { json, sig: `0x${host.sign(Buffer.concat([Buffer.from("delta\0", "utf8"), Buffer.from(json, "utf8")]))}` };
};

async function deploy({ profile = true } = {}) {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const nodeStake = await (await ethers.getContractFactory("MockNodeStake")).deploy();
  const matchBook = await (await ethers.getContractFactory("MockMatchBook")).deploy();
  const profileC = await (await ethers.getContractFactory("MockPlayerProfile")).deploy();
  const wager = await (await ethers.getContractFactory("LitNodeWager")).deploy(owner.address, await nodeStake.getAddress(), await matchBook.getAddress(), profile ? await profileC.getAddress() : ethers.ZeroAddress, DELAY);
  await wager.waitForDeployment();
  const host = nodeKey();
  await nodeStake.set(b32(host.pub), true);
  const ka = hex64(), kb = hex64();
  return { owner, alice, bob, carol, nodeStake, matchBook, profileC, wager, host, ka, kb };
}

async function staked(opts) {
  const t = await deploy(opts);
  await t.wager.connect(t.alice).stake(b32(t.ka), { value: ONE });
  await t.wager.connect(t.bob).stake(b32(t.kb), { value: ONE });
  return t;
}
const sortedScores = (a, b, sa, sb) => (a < b ? { [a]: sa, [b]: sb } : { [b]: sb, [a]: sa });

describe("LitNodeWager", () => {
  it("canonical() matches litnode's protocol/canonical.js", async () => {
    const file = join(LITNODE_DIR, "protocol", "canonical.js");
    if (!existsSync(file)) { console.log(`  (litnode checkout not found at ${LITNODE_DIR}: skipping the cross-check)`); return; }
    const theirs = await import(pathToFileURL(file).href);
    const fixture = { z: 1, a: { d: [3, { y: null, x: undefined, w: () => 1 }], c: "é\"\\\n" }, m: [1, "two", { b: 0.5, a: true }], u: undefined };
    assert.equal(canonical(fixture), theirs.canonical(fixture));
    const body = deltaBody({ matchId: hex64(), host: nodeKey(), a: hex64(), b: hex64(), scores: { x: 1 } });
    assert.equal(canonical(body), theirs.canonical(body));
  });

  it("binds a stake to a player key, once", async () => {
    const t = await deploy();
    await assert.rejects(t.wager.connect(t.alice).stake(ethers.ZeroHash, { value: ONE }), /ZeroKey/);
    await assert.rejects(t.wager.connect(t.alice).stake(b32(t.ka), { value: 0 }), /ZeroValue/);
    await t.wager.connect(t.alice).stake(b32(t.ka), { value: ONE });
    await t.wager.connect(t.alice).stake(b32(t.ka), { value: ONE });
    const [amount] = await t.wager.stakeOf(t.alice.address);
    assert.equal(amount, 2n * ONE);
    assert.equal(await t.wager.keyOf(t.alice.address), b32(t.ka));
    assert.equal(await t.wager.walletOf(b32(t.ka)), t.alice.address);
    await assert.rejects(t.wager.connect(t.bob).stake(b32(t.ka), { value: ONE }), /KeyTaken/);
    await assert.rejects(t.wager.connect(t.alice).stake(b32(t.kb), { value: ONE }), /KeyBound/);
  });

  it("refuses a key the PlayerProfile binds to another wallet", async () => {
    const t = await deploy();
    await t.profileC.set(b32(t.ka), t.carol.address, true);
    await assert.rejects(t.wager.connect(t.alice).stake(b32(t.ka), { value: ONE }), /ProfileMismatch/);
    await t.wager.connect(t.carol).stake(b32(t.ka), { value: ONE });
    await t.profileC.set(b32(t.kb), t.carol.address, false); // inactive binding: no opinion
    await t.wager.connect(t.alice).stake(b32(t.kb), { value: ONE });
  });

  it("pays the winner the pot on a host-signed delta", async () => {
    const t = await staked();
    const matchId = hex64();
    const body = deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) });
    const { json, sig } = signDelta(body, t.host);
    const before = await ethers.provider.getBalance(t.alice.address);
    const tx = await t.wager.connect(t.carol).claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    const rc = await tx.wait();
    console.log(`  claim gas: ${rc.gasUsed} (delta ${json.length} bytes)`);
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - before, 2n * ONE);
    assert.equal((await t.wager.stakeOf(t.alice.address))[0], 0n);
    assert.equal((await t.wager.stakeOf(t.bob.address))[0], 0n);
    assert.equal(await t.wager.claimed(b32(matchId)), true);
    await assert.rejects(t.wager.connect(t.carol).claim(b32(matchId), ethers.toUtf8Bytes(json), sig), /AlreadyClaimed/);
  });

  it("a draw leaves both stakes in place and marks the match claimed", async () => {
    const t = await staked();
    const matchId = hex64();
    const { json, sig } = signDelta(deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 0.5, 0.5) }), t.host);
    await t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    assert.equal((await t.wager.stakeOf(t.alice.address))[0], ONE);
    assert.equal((await t.wager.stakeOf(t.bob.address))[0], ONE);
    assert.equal(await t.wager.claimed(b32(matchId)), true);
  });

  it("unequal stakes: the pot is twice the smaller, the larger keeps the rest", async () => {
    const t = await deploy();
    await t.wager.connect(t.alice).stake(b32(t.ka), { value: 3n * ONE });
    await t.wager.connect(t.bob).stake(b32(t.kb), { value: ONE });
    const matchId = hex64();
    const { json, sig } = signDelta(deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 0, 1) }), t.host);
    const before = await ethers.provider.getBalance(t.bob.address);
    await t.wager.connect(t.carol).claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    assert.equal((await ethers.provider.getBalance(t.bob.address)) - before, 2n * ONE);
    assert.equal((await t.wager.stakeOf(t.alice.address))[0], 2n * ONE);
    assert.equal((await t.wager.stakeOf(t.bob.address))[0], 0n);
  });

  it("takes the fee on a win only, never above 5%", async () => {
    const t = await staked();
    await assert.rejects(t.wager.setFee(501), /FeeTooHigh/);
    await assert.rejects(t.wager.connect(t.alice).setFee(100), /OwnableUnauthorizedAccount/);
    await t.wager.setFee(250);
    const matchId = hex64();
    const { json, sig } = signDelta(deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) }), t.host);
    const before = await ethers.provider.getBalance(t.alice.address);
    await t.wager.connect(t.carol).claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - before, 2n * ONE - (2n * ONE * 250n) / 10000n);
    assert.equal(await t.wager.fees(), (2n * ONE * 250n) / 10000n);
    await t.wager.withdrawFees(t.carol.address);
    assert.equal(await t.wager.fees(), 0n);
  });

  it("rejects a bad signature, a tampered delta and an unbonded host", async () => {
    const t = await staked();
    const matchId = hex64();
    const body = deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) });
    const { json, sig } = signDelta(body, t.host);
    const other = nodeKey();
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), `0x${other.sign(Buffer.from("x"))}`), /BadSignature/);
    const flipped = signDelta({ ...body, scores: sortedScores(t.ka, t.kb, 0, 1) }, t.host);
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(flipped.json), sig), /BadSignature/);
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig.slice(0, -2)), /BadSignature/);
    // a delta signed by a key that is not a bonded node
    const rogue = nodeKey();
    const forged = signDelta({ ...body, hostId: rogue.pub }, rogue);
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(forged.json), forged.sig), /HostNotBonded/);
    await t.nodeStake.set(b32(t.host.pub), false);
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig), /HostNotBonded/);
  });

  it("requires rapture-chess.v1, a replayable kind, a finished match and both players' signatures", async () => {
    const t = await staked();
    const matchId = hex64();
    const base = { matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) };
    const expect = async (overrides, re) => {
      const { json, sig } = signDelta(deltaBody({ ...base, overrides }), t.host);
      await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig), re);
    };
    await expect({ rulesetId: "tug.v1" }, /WrongRuleset/);
    await expect({ attestation: "host" }, /NotPlayers/);
    await expect({ attestation: "relay" }, /NotPlayers/);
    await expect({ kind: "attested" }, /NotReplayable/);
    await expect({ complete: false }, /NotComplete/);
    await expect({ matchId: hex64() }, /MatchMismatch/);
    const stranger = hex64();
    await expect({ participants: [t.ka, stranger], scores: sortedScores(t.ka, stranger, 1, 0) }, /NotStaked/);
    await expect({ scores: undefined }, /Malformed/);
    await expect({ hostId: "not-hex" }, /Malformed/);
  });

  it("follows MatchBook once the chain knows the match: Final with the same resultHash", async () => {
    const t = await staked();
    const matchId = hex64();
    const body = deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) });
    const { json, sig } = signDelta(body, t.host);
    await t.matchBook.set(b32(matchId), 2, b32(body.resultHash)); // Settled, not yet Final
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig), /NotFinal/);
    await t.matchBook.set(b32(matchId), 3, b32(hex64()));          // Final, another result
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig), /ResultMismatch/);
    await t.matchBook.set(b32(matchId), 4, b32(body.resultHash));  // Void
    await assert.rejects(t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig), /NotFinal/);
    await t.matchBook.set(b32(matchId), 3, b32(body.resultHash));  // Final, same result
    await t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    assert.equal(await t.wager.claimed(b32(matchId)), true);
  });

  it("holds a payout the winner refuses, to be withdrawn later", async () => {
    const t = await deploy();
    const refuser = await (await ethers.getContractFactory("PayoutRefuser")).deploy();
    const stakeData = t.wager.interface.encodeFunctionData("stake", [b32(t.ka)]);
    await refuser.connect(t.alice).call(await t.wager.getAddress(), stakeData, { value: ONE });
    await t.wager.connect(t.bob).stake(b32(t.kb), { value: ONE });
    const matchId = hex64();
    const { json, sig } = signDelta(deltaBody({ matchId, host: t.host, a: t.ka, b: t.kb, scores: sortedScores(t.ka, t.kb, 1, 0) }), t.host);
    await t.wager.claim(b32(matchId), ethers.toUtf8Bytes(json), sig);
    assert.equal(await t.wager.pending(await refuser.getAddress()), 2n * ONE);
  });

  it("unstakes only after the delay, and staking again cancels the request", async () => {
    const t = await staked();
    await assert.rejects(t.wager.connect(t.alice).unstake(), /NoRequest/);
    await assert.rejects(t.wager.connect(t.carol).requestUnstake(), /NothingStaked/);
    await t.wager.connect(t.alice).requestUnstake();
    await assert.rejects(t.wager.connect(t.alice).unstake(), /TooEarly/);
    await t.wager.connect(t.alice).stake(b32(t.ka), { value: 1n });
    assert.equal((await t.wager.stakeOf(t.alice.address))[1], 0n);
    await t.wager.connect(t.alice).requestUnstake();
    await network.provider.send("evm_increaseTime", [Number(DELAY) + 1]);
    await network.provider.send("evm_mine");
    const before = await ethers.provider.getBalance(t.alice.address);
    const rc = await (await t.wager.connect(t.alice).unstake()).wait();
    const spent = rc.gasUsed * rc.gasPrice;
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - before + spent, ONE + 1n);
    assert.equal((await t.wager.stakeOf(t.alice.address))[0], 0n);
    // with the stake gone, the wallet may bind a new key
    await t.wager.connect(t.alice).stake(b32(hex64()), { value: ONE });
    assert.equal(await t.wager.walletOf(b32(t.ka)), ethers.ZeroAddress);
  });
});
