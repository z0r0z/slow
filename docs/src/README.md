# [SLOW](https://github.com/z0r0z/slow)  [![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL-black.svg)](https://opensource.org/license/agpl-v3/) [![solidity](https://img.shields.io/badge/solidity-%5E0.8.34-black)](https://docs.soliditylang.org/en/v0.8.34/) [![Foundry](https://img.shields.io/badge/Built%20with-Foundry-000000.svg)](https://getfoundry.sh/)

## Deployment

[`0x000000000000888741B254d37e1b27128AfEAaBC`](https://contractscan.xyz/contract/0x000000000000888741B254d37e1b27128AfEAaBC)

## What is SLOW?

SLOW is a protocol that adds safety mechanisms to token transfers through two powerful features:

1. **Timelock**: Enforces a waiting period before recipients can access transferred tokens
2. **Guardian**: Optional trusted party that can approve or block transfers

Think of it as a security-enhanced way to transfer ETH and ERC20 tokens with built-in protection mechanisms.

## Why Use SLOW?

- **Prevent Theft**: Even if your keys are compromised, attackers must wait for the timelock to expire
- **Reverse Mistakes**: Cancel erroneous transfers before the timelock expires
- **Secure High-Value Transactions**: Add guardian approval for extra security
- **Schedule Transfers**: Set timelock periods from seconds to days or longer

## Key Features

- Wrap and send ETH or any ERC20 token
- Set custom timelock periods for each transfer
- Appoint a guardian to approve sensitive transfers
- Reverse pending transfers before timelock expiry
- One-step `claim` after expiry: burn the wrapped position and pay the underlying in a single tx
- 30-day `clawback` window for senders when a recipient never claims (lost keys, dead address)
- Visually track tokens with dynamic SVG renders
- Multicall support for batched operations
- Onchain dapp: the contract serves its own UI via `html()` — no IPFS, no gateway, no NPM

## How It Works

### Core Concepts

SLOW uses the ERC1155 token standard to represent wrapped tokens with timelock and guardian protections:

![image](https://github.com/user-attachments/assets/ddaa86f0-a4a0-4cfb-82a4-9cf670fcae47)

1. **Tokenization**: Each base token (ETH or ERC20) is wrapped into a SLOW token
2. **Token ID Encoding**: The token ID encodes both the token address and timelock period
3. **Balance States**: Token balances exist in two states - locked and unlocked
4. **Transfer Flow**: Transfers go through a predictable lifecycle with safety checks

### Typical User Flow

```mermaid
graph TD
    A[User deposits tokens] --> B[Tokens wrapped as SLOW tokens]
    B --> C{Set timelock?}
    C -->|Yes| D[Create pending transfer with timelock]
    C -->|No| E[Tokens immediately unlocked]
    D -->|Wait for timelock| F[Manually unlock tokens]
    D -->|Before expiry| G[Optional: Reverse transfer]
    F --> H[Tokens available for withdrawal]
    E --> H
    H --> I[Withdraw tokens to recipient]
```

### Transfer States Visualization

```mermaid
stateDiagram-v2
    [*] --> Deposit: User deposits tokens
    Deposit --> Locked: With timelock
    Deposit --> Unlocked: Without timelock
    Locked --> PendingTransfer: During timelock period
    PendingTransfer --> Reversed: Before timelock expires
    PendingTransfer --> ReadyToUnlock: After timelock expires
    ReadyToUnlock --> Unlocked: User calls unlock()
    Unlocked --> Withdrawn: User withdraws tokens
    Reversed --> [*]
    Withdrawn --> [*]
```

## Practical Examples

### Example 1: Basic Timelock Transfer

Alice wants to send 1 ETH to Bob with a 24-hour timelock:

1. Alice calls `depositTo` with parameters:
   - token: 0x0000000000000000000000000000000000000000 (ETH)
   - to: Bob's address
   - amount: 1 ETH
   - delay: 86400 (seconds in 24 hours)

2. The contract:
   - Creates a unique transferId
   - Records a pending transfer with the current timestamp
   - Mints a SLOW token to Bob representing the locked 1 ETH

3. After 24 hours, Bob calls `unlock(transferId)` to move the tokens to his unlocked balance

4. Bob can now call `withdrawFrom` to get the actual ETH

### Example 2: Guardian Protected Transfer

Charlie sets up a guardian for extra security:

1. Charlie calls `setGuardian(guardianAddress)` to designate a trusted guardian

2. When Charlie wants to transfer tokens, the transfer requires guardian approval

3. Charlie initiates a transfer to Dave with `safeTransferFrom`

4. The guardian calls `approveTransfer(Charlie's address, transferId)` to approve

5. If the transfer had a timelock, Dave still needs to wait and then unlock it

6. Without guardian approval, the transfer remains pending indefinitely

### Example 3: Reversing a Mistaken Transfer

Emma accidentally sends tokens to the wrong address:

1. Emma initiates a transfer with a 48-hour timelock

2. Emma realizes the mistake and calls `reverse(transferId)` before the timelock expires

3. The tokens are returned to Emma's address

## Key Functions

### Core Transfer Functions

- **`depositTo(token, to, amount, delay, data)`** - Deposit tokens and create a timelock
- **`withdrawFrom(from, to, id, amount)`** - Withdraw unlocked tokens
- **`safeTransferFrom(from, to, id, amount, data)`** - Transfer tokens with security checks
- **`unlock(transferId)`** - Permissionless: move an expired pending transfer into the recipient's unlocked balance
- **`claim(transferId)`** - Recipient (or operator): one-step burn-and-pay to underlying after expiry
- **`reverse(transferId)`** - Sender (or operator): cancel a pending transfer before timelock expiry
- **`clawback(transferId)`** - Sender (or operator): recover an unsettled transfer 30 days past expiry

### Guardian Management

- **`setGuardian(guardian)`** - Designate an address as your guardian (self-applied 2FA)
- **`approveTransfer(from, transferId)`** - Guardian approves a pending transfer

### View Helpers

- **`predictTransferId(from, to, id, amount)`** - Compute the next transferId for a (from, to, id, amount) tuple
- **`canReverseTransfer(transferId)`** - `(canReverse, reason)` preflight for the reverse window
- **`isGuardianApprovalNeeded(user, to, id, amount)`** - Whether the user's next outflow requires guardian approval
- **`canChangeGuardian(user)`** - `(canChange, cooldownEndsAt)` for the guardian rotation window
- **`getOutboundTransfers(user)` / `getInboundTransfers(user)`** - All pending transferIds for a user
- **`encodeId(token, delay)` / `decodeId(id)`** - Token-id <-> (address, delay) helpers
- **`html()`** - Returns the dapp HTML reassembled from on-chain SSTORE2 chunks

## Technical Details

### Token ID Structure

Each SLOW token ID encodes two pieces of information:
- Lower 160 bits: The underlying token address (0x0 for ETH)
- Upper 96 bits: The timelock delay in seconds

```
|---- 96 bits ----|---- 160 bits ----|
|     Timelock    |   Token Address  |
```

### Transfer ID Generation

Each transfer gets a unique ID generated from:
```solidity
keccak256(abi.encodePacked(from, to, id, amount, nonces[from]))
```

This ensures each transfer can be uniquely identified and tracked.

## Security Considerations

- **Guardian Cooldown**: 1 day cooldown between guardian changes prevents flash attacks
- **Reversible Transfers**: Only possible before timelock expiry
- **Clawback Grace**: Sender can `clawback` only after timelock expiry + 30 days, and only while the pending entry still exists — anyone (recipient, operator, or any keeper) can call permissionless `unlock` during the grace window to disable clawback
- **Reentrancy Protection**: External-facing functions protected against reentrancy attacks (transient-storage guard)
- **Balance Tracking**: Strict accounting of locked vs. unlocked balances
- **Unsupported Tokens**: Fee-on-transfer and rebasing tokens (e.g. stETH) are not supported — the wrapper assumes 1:1 accounting between deposited and withdrawable amount. Wrap rebasing tokens to their non-rebasing equivalent (e.g. wstETH) before depositing.

## Getting Started

Run: `curl -L https://foundry.paradigm.xyz | bash && source ~/.bashrc && foundryup`

Build the foundry project with `forge build`. Run tests with `forge test`. Measure gas with `forge snapshot`. Format with `forge fmt`.

The dapp has two parallel test layers, both vanilla `node` (no NPM):

- **`node test/slow_html.test.mjs`** — unit tests for the deterministic helpers (keccak256, namehash, ABI codec, parse/formatUnits, id codec, every `SEL` selector). Reads `SLOW.html`, evaluates the inline IIFE in a sandboxed scope, asserts against canonical vectors crosschecked with `cast keccak` and `cast sig`.
- **`node test/slow_html.e2e.test.mjs`** — full integration tests. Spawns `anvil`, deploys SLOW, drives the dapp's actual flow functions (`deposit`, `claim`, `reverseAndWithdraw`, `clawback`, `loadTransfers`) against the live contract, asserts on-chain state and dapp state match. Requires `anvil` on PATH and a current `forge build`.

`SLOW.html` is not modified by either runner — both extract the IIFE in memory and rewrite only sandbox-local references.

## Blueprint

```txt
SLOW.html       — onchain dapp (served by the deployed contract via html())
src/
└─ SLOW.sol     — protocol contract
test/
└─ SLOW.t.sol   — full test suite (mainnet fork)
lib/
├─ solady       — https://github.com/vectorized/solady
└─ forge-std    — https://github.com/foundry-rs/forge-std
foundry.toml
```

## Disclaimer

*These smart contracts and testing suite are being provided as is. No guarantee, representation or warranty is being made, express or implied, as to the safety or correctness of anything provided herein or through related user interfaces. This repository and related code have not been audited and as such there can be no assurance anything will work as intended, and users may experience delays, failures, errors, omissions, loss of transmitted information or loss of funds. The creators are not liable for any of the foregoing. Users should proceed with caution and use at their own risk.*

## License

See [LICENSE](./LICENSE) for more details.
