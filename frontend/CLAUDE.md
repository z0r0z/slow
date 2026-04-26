# CLAUDE.md - Frontend Developer Guide

## Structure

The entire dapp is a single self-contained `index.html` — inline CSS, inline JS, no build step, no external libraries. Designed to be servable from IPFS or stored on-chain (e.g. via SSTORE2).

## Run locally

```
python3 -m http.server 5173
```

Or any static file server. Open `http://localhost:5173/`.

## Architecture

- **Wallet**: EIP-1193 `window.ethereum` only — no web3-onboard, no WalletConnect.
- **Chain**: Base (chainId 8453). Auto-prompts to switch / add the network.
- **Contract calls**: Hand-rolled ABI codec. Function selectors are precomputed and inlined.
- **ENS**: Native resolution via the mainnet ENS Registry → resolver → addr/name pattern. Embedded keccak-256 (BigInt-based) computes namehash. Reverse lookups verify forward resolution per ENSIP-3 best practice. No third-party ENS proxy contract.
- **Reads**: Pending transfers come straight from the SLOW contract via `getOutboundTransfers` / `getInboundTransfers` — no off-chain indexer.
- **Writes**: `eth_sendTransaction`. Settle flows (unlock+withdraw, reverse+withdraw) bundled via `multicall(bytes[])`.

## Code conventions

- 2-space indentation, single quotes for strings, semicolons at line ends.
- IIFE wrapper at the bottom for scoping.
- Function selectors and contract addresses live in the `Config` block at the top of the script.

## Updating the ABI

If the SLOW contract gains a new function:
1. Run `cast sig "newFunction(types)"` to get the selector.
2. Add it to the `SEL` object.
3. Add the arg types to the appropriate `callData(...)` call site.
