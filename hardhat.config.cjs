require("@nomicfoundation/hardhat-ethers");

/**
 * ChessWager on LitVM Liteforge (chain 4441): an Arbitrum Nitro chain with EVM Shanghai, so no Cancun opcodes and
 * OpenZeppelin pinned to 5.0.2 (same settings as ../blender/packshop). The deployer key comes from the environment
 * (PRIVATE_KEY) and is never written anywhere.
 */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { evmVersion: "shanghai", optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: "contracts", tests: "contracts/test", artifacts: "contracts/artifacts", cache: "contracts/cache" },
  networks: {
    hardhat: { chainId: 31339 },
    liteforge: {
      url: process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/http",
      chainId: 4441,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
