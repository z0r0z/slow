import { createConfig } from "ponder";
import { http } from "viem";

import { SLOWAbi } from "./abis/SLOWAbi";

export default createConfig({
  networks: {
    base: { chainId: 8453, transport: http(process.env.PONDER_RPC_URL_8453) },
  },
  contracts: {
    SLOW: {
      abi: SLOWAbi,
      address: "0x000000000000888741b254d37e1b27128afeaabc",
      network: "base",
      startBlock: 27245775,
    },
  },
});
