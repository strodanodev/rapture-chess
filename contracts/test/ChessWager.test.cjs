// ChessWager: create / join / settle (win, draw, fee) / cancel / timeout / bad signature / held payouts.
const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const DOMAIN_NAME = "RaptureChessWager";
const TYPES = { Settlement: [{ name: "matchId", type: "bytes32" }, { name: "winner", type: "uint8" }, { name: "logHash", type: "bytes32" }] };
const STAKE = ethers.parseEther("1");
const TIMEOUT = 3600n;

async function deploy() {
  const [owner, resolver, alice, bob, mallory] = await ethers.getSigners();
  const Wager = await ethers.getContractFactory("ChessWager");
  const wager = await Wager.deploy(owner.address, resolver.address, TIMEOUT);
  await wager.waitForDeployment();
  const domain = { name: DOMAIN_NAME, version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await wager.getAddress() };
  const seed = ethers.hexlify(ethers.randomBytes(32));
  const matchId = ethers.keccak256(seed);
  const seedCommit = ethers.keccak256(ethers.concat([ethers.toUtf8Bytes("rapture-chess/seed/v1"), seed]));
  const logHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "int32[]"], [seed, [14433, 0, 0, 14433]]));
  const sign = (winner, id = matchId, hash = logHash, signer = resolver) => signer.signTypedData(domain, TYPES, { matchId: id, winner, logHash: hash });
  return { owner, resolver, alice, bob, mallory, wager, domain, seed, matchId, seedCommit, logHash, sign };
}

async function openAndJoin(t) {
  await t.wager.connect(t.alice).createMatch(t.matchId, t.seedCommit, { value: STAKE });
  await t.wager.connect(t.bob).joinMatch(t.matchId, { value: STAKE });
}

describe("ChessWager", () => {
  it("creates and joins a match with matching stakes", async () => {
    const t = await deploy();
    await assert.rejects(t.wager.connect(t.alice).createMatch(t.matchId, t.seedCommit, { value: 0 }), /ZeroStake/);
    await t.wager.connect(t.alice).createMatch(t.matchId, t.seedCommit, { value: STAKE });
    await assert.rejects(t.wager.connect(t.alice).createMatch(t.matchId, t.seedCommit, { value: STAKE }), /MatchExists/);
    await assert.rejects(t.wager.connect(t.alice).joinMatch(t.matchId, { value: STAKE }), /SelfPlay/);
    await assert.rejects(t.wager.connect(t.bob).joinMatch(t.matchId, { value: STAKE / 2n }), /WrongStake/);
    await t.wager.connect(t.bob).joinMatch(t.matchId, { value: STAKE });
    const m = await t.wager.matches(t.matchId);
    assert.equal(m.creator, t.alice.address);
    assert.equal(m.joiner, t.bob.address);
    assert.equal(m.stake, STAKE);
    assert.equal(m.status, 2n);
    assert.equal(m.seedCommit, t.seedCommit);
    await assert.rejects(t.wager.connect(t.mallory).joinMatch(t.matchId, { value: STAKE }), /WrongStatus/);
  });

  it("settles a win to the winner, by anyone with the resolver's signature", async () => {
    const t = await deploy();
    await openAndJoin(t);
    const before = await ethers.provider.getBalance(t.bob.address);
    const sig = await t.sign(1);
    await t.wager.connect(t.mallory).settle(t.matchId, 1, t.logHash, sig);   // a third party may submit it
    const after = await ethers.provider.getBalance(t.bob.address);
    assert.equal(after - before, STAKE * 2n);
    const m = await t.wager.matches(t.matchId);
    assert.equal(m.status, 3n);
    assert.equal(m.winner, 1n);
    assert.equal(m.logHash, t.logHash);
    await assert.rejects(t.wager.settle(t.matchId, 1, t.logHash, sig), /WrongStatus/);
  });

  it("refunds both on a draw, with no fee", async () => {
    const t = await deploy();
    await t.wager.connect(t.owner).setFee(250, t.owner.address);
    await openAndJoin(t);
    const a0 = await ethers.provider.getBalance(t.alice.address), b0 = await ethers.provider.getBalance(t.bob.address);
    await t.wager.connect(t.mallory).settle(t.matchId, 2, t.logHash, await t.sign(2));
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - a0, STAKE);
    assert.equal((await ethers.provider.getBalance(t.bob.address)) - b0, STAKE);
    assert.equal(await t.wager.accruedFees(), 0n);
  });

  it("takes the fee on a decisive result and lets the owner withdraw it", async () => {
    const t = await deploy();
    await assert.rejects(t.wager.connect(t.owner).setFee(501, t.owner.address), /FeeTooHigh/);
    await assert.rejects(t.wager.connect(t.alice).setFee(100, t.alice.address), /OwnableUnauthorizedAccount/);
    await t.wager.connect(t.owner).setFee(250, t.mallory.address);
    await openAndJoin(t);
    const a0 = await ethers.provider.getBalance(t.alice.address);
    await t.wager.connect(t.bob).settle(t.matchId, 0, t.logHash, await t.sign(0));
    const fee = (STAKE * 2n * 250n) / 10_000n;
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - a0, STAKE * 2n - fee);
    assert.equal(await t.wager.accruedFees(), fee);
    const m0 = await ethers.provider.getBalance(t.mallory.address);
    await t.wager.connect(t.owner).withdrawFees();
    assert.equal((await ethers.provider.getBalance(t.mallory.address)) - m0, fee);
  });

  it("rejects a settlement that is not the resolver's, or for another match", async () => {
    const t = await deploy();
    await openAndJoin(t);
    await assert.rejects(t.wager.settle(t.matchId, 0, t.logHash, await t.sign(0, t.matchId, t.logHash, t.mallory)), /BadSignature/);
    await assert.rejects(t.wager.settle(t.matchId, 0, t.logHash, await t.sign(1)), /BadSignature/);          // winner tampered
    await assert.rejects(t.wager.settle(t.matchId, 0, ethers.ZeroHash, await t.sign(0)), /BadSignature/);     // log tampered
    await assert.rejects(t.wager.settle(t.matchId, 3, t.logHash, await t.sign(3)), /BadWinner/);
    await assert.rejects(t.wager.settle(t.matchId, 0, t.logHash, "0x1234"), /BadSignature/);
    // a new resolver invalidates old signatures and validates its own
    await t.wager.connect(t.owner).setResolver(t.mallory.address);
    await assert.rejects(t.wager.settle(t.matchId, 0, t.logHash, await t.sign(0)), /BadSignature/);
    await t.wager.settle(t.matchId, 0, t.logHash, await t.sign(0, t.matchId, t.logHash, t.mallory));
  });

  it("lets the creator cancel an open match, and nobody else", async () => {
    const t = await deploy();
    await t.wager.connect(t.alice).createMatch(t.matchId, t.seedCommit, { value: STAKE });
    await assert.rejects(t.wager.connect(t.bob).cancel(t.matchId), /NotAParty/);
    const a0 = await ethers.provider.getBalance(t.alice.address);
    const tx = await t.wager.connect(t.alice).cancel(t.matchId);
    const rc = await tx.wait();
    const gas = rc.gasUsed * rc.gasPrice;
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - a0 + gas, STAKE);
    assert.equal((await t.wager.matches(t.matchId)).status, 4n);
    await assert.rejects(t.wager.connect(t.bob).joinMatch(t.matchId, { value: STAKE }), /WrongStatus/);
    await assert.rejects(t.wager.connect(t.alice).cancel(t.matchId), /WrongStatus/);
  });

  it("splits the pot after the settle timeout when no settlement arrives", async () => {
    const t = await deploy();
    await openAndJoin(t);
    await assert.rejects(t.wager.connect(t.alice).timeoutClaim(t.matchId), /TooEarly/);
    await assert.rejects(t.wager.connect(t.mallory).timeoutClaim(t.matchId), /NotAParty/);
    await network.provider.send("evm_increaseTime", [Number(TIMEOUT) + 1]);
    await network.provider.send("evm_mine");
    const a0 = await ethers.provider.getBalance(t.alice.address), b0 = await ethers.provider.getBalance(t.bob.address);
    const rc = await (await t.wager.connect(t.bob).timeoutClaim(t.matchId)).wait();
    assert.equal((await ethers.provider.getBalance(t.alice.address)) - a0, STAKE);
    assert.equal((await ethers.provider.getBalance(t.bob.address)) - b0 + rc.gasUsed * rc.gasPrice, STAKE);
    assert.equal((await t.wager.matches(t.matchId)).status, 5n);
    await assert.rejects(t.wager.settle(t.matchId, 0, t.logHash, await t.sign(0)), /WrongStatus/);
  });

  it("holds a payout the recipient refuses, for withdraw()", async () => {
    const t = await deploy();
    const Refuser = await ethers.getContractFactory("PayoutRefuser");
    const refuser = await Refuser.deploy(await t.wager.getAddress());
    await refuser.waitForDeployment();
    await refuser.connect(t.alice).create(t.matchId, t.seedCommit, { value: STAKE });
    await t.wager.connect(t.bob).joinMatch(t.matchId, { value: STAKE });
    await t.wager.connect(t.mallory).settle(t.matchId, 0, t.logHash, await t.sign(0));   // succeeds although the winner reverts
    assert.equal(await t.wager.pending(await refuser.getAddress()), STAKE * 2n);
    await refuser.setAccept(true);
    await refuser.withdraw();
    assert.equal(await t.wager.pending(await refuser.getAddress()), 0n);
    assert.equal(await ethers.provider.getBalance(await refuser.getAddress()), STAKE * 2n);
    await assert.rejects(refuser.withdraw(), /NothingToWithdraw/);
  });

  it("exposes the settlement digest the resolver signs", async () => {
    const t = await deploy();
    const digest = await t.wager.settlementDigest(t.matchId, 1, t.logHash);
    const expected = ethers.TypedDataEncoder.hash(t.domain, TYPES, { matchId: t.matchId, winner: 1, logHash: t.logHash });
    assert.equal(digest, expected);
  });
});
