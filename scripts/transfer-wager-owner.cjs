// Hand the LitNodeWager escrow (fee and settings owner) to another wallet.
//
//   PRIVATE_KEY=0x<current owner> NEW_OWNER=0x<new owner> npx hardhat run scripts/transfer-wager-owner.cjs --network liteforge
//
// Reads the escrow address from deployments/liteforge.json. Ownership only governs setFee/setUnstakeDelay/withdrawFees;
// stakes and claims never depend on it.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const to = process.env.NEW_OWNER;
  if (!to || !ethers.isAddress(to)) throw new Error("set NEW_OWNER to the new owner's address");
  const deployed = JSON.parse(readFileSync(join(__dirname, "..", "deployments", "liteforge.json"), "utf8"));
  const address = deployed.litNodeWager?.address;
  if (!address) throw new Error("deployments/liteforge.json has no litNodeWager.address");
  const [signer] = await ethers.getSigners();
  const wager = await ethers.getContractAt("LitNodeWager", address, signer);
  const owner = await wager.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error(`escrow owner is ${owner}, not ${signer.address}`);
  console.log(`transferring LitNodeWager ${address} from ${owner} to ${to}`);
  const tx = await wager.transferOwnership(to);
  const rc = await tx.wait();
  console.log(`owner is now ${await wager.owner()} (tx ${rc.hash}, block ${rc.blockNumber})`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
