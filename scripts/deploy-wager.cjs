// Deploys ChessWager and records the address.
//   RESOLVER=0x<relay signer> PRIVATE_KEY=0x<deployer> npx hardhat run scripts/deploy-wager.cjs --network liteforge
// Optional: OWNER (defaults to the deployer), SETTLE_TIMEOUT seconds (default 86400).
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("no deployer: set PRIVATE_KEY");
  const resolver = process.env.RESOLVER;
  if (!resolver || !ethers.isAddress(resolver)) throw new Error("set RESOLVER to the relay's signer address");
  const owner = process.env.OWNER && ethers.isAddress(process.env.OWNER) ? process.env.OWNER : deployer.address;
  const timeout = BigInt(process.env.SETTLE_TIMEOUT ?? 86400);
  console.log(`deploying ChessWager on ${network.name} from ${deployer.address}: owner ${owner}, resolver ${resolver}, settleTimeout ${timeout}s`);
  const wager = await (await ethers.getContractFactory("ChessWager")).deploy(owner, resolver, timeout);
  const tx = wager.deploymentTransaction();
  await wager.waitForDeployment();
  const address = await wager.getAddress();
  console.log(`ChessWager at ${address} (tx ${tx?.hash})`);
  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${network.name}.json`);
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  writeFileSync(file, `${JSON.stringify({ ...prev, network: network.name, chainId, chessWager: { address, owner, resolver, settleTimeout: Number(timeout), tx: tx?.hash ?? null, deployedAt: new Date().toISOString() } }, null, 2)}\n`);
  console.log(`wrote ${file}; set VITE_WAGER_ADDRESS=${address} for the client and WAGER_ADDRESS for the relay`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
