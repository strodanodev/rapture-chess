// Deploys LitNodeWager (v2) against the LitNode contracts on Liteforge and records the address.
//   PRIVATE_KEY=0x<deployer> npx hardhat run scripts/deploy-wager.cjs --network liteforge
// Reads NodeStake, MatchBook, PlayerProfile and TitleRegistry from <LITNODE_DIR>/contracts/deployed.testnet.json
// (LITNODE_DIR defaults to ../LITNODE/litnode). Optional: OWNER (defaults to the deployer), RULESET (default
// rapture-chess.v2: the title must be registered before a claimWithWinner can pass), UNSTAKE_DELAY seconds (default
// 4000, longer than MatchBook.totalWindow() = 1800 + 2×300 + 3×300 = 3300). Writes deployments/<network>.json under
// `litNodeWagerV2` (the v1 escrow's record stays under `litNodeWager`).
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer: set PRIVATE_KEY");
  const litnode = process.env.LITNODE_DIR ?? join(__dirname, "..", "..", "LITNODE", "litnode");
  const file = join(litnode, "contracts", "deployed.testnet.json");
  if (!existsSync(file)) throw new Error(`${file} not found: set LITNODE_DIR to a litnode checkout`);
  const d = JSON.parse(readFileSync(file, "utf8"));
  const addr = (name) => { const a = d[name]?.address; if (!ethers.isAddress(a)) throw new Error(`${name} missing in ${file}`); return a; };
  const nodeStake = addr("NodeStake"), matchBook = addr("MatchBook"), profile = addr("PlayerProfile"), titleRegistry = addr("TitleRegistry");
  const ruleset = process.env.RULESET ?? "rapture-chess.v2";
  const owner = process.env.OWNER && ethers.isAddress(process.env.OWNER) ? process.env.OWNER : deployer.address;
  const delay = BigInt(process.env.UNSTAKE_DELAY ?? 4000);
  console.log(`deploying LitNodeWager v2 on ${network.name} from ${deployer.address}: ruleset ${ruleset}, owner ${owner}, NodeStake ${nodeStake}, MatchBook ${matchBook}, PlayerProfile ${profile}, TitleRegistry ${titleRegistry}, unstakeDelay ${delay}s`);
  const wager = await (await ethers.getContractFactory("LitNodeWager")).deploy(owner, nodeStake, matchBook, profile, titleRegistry, ruleset, delay);
  const tx = wager.deploymentTransaction();
  await wager.waitForDeployment();
  const address = await wager.getAddress();
  console.log(`LitNodeWager at ${address} (tx ${tx?.hash})`);
  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${network.name}.json`);
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  writeFileSync(out, `${JSON.stringify({ ...prev, network: network.name, chainId, litNodeWagerV2: { address, ruleset, owner, nodeStake, matchBook, profile, titleRegistry, unstakeDelay: Number(delay), litnodeGeneration: d.generation ?? null, tx: tx?.hash ?? null, deployedAt: new Date().toISOString() } }, null, 2)}\n`);
  console.log(`wrote ${out}; for the client set VITE_WAGER_ADDRESS=${address} and VITE_CHESS_RULESET=${ruleset}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
