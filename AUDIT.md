# SLOW.sol — Audit Briefing

## Overview

SLOW is an immutable, no-admin, permissionless ERC-1155 wrapper for time-locked
token sends. ETH or any ERC-20 can be deposited with a per-transfer delay;
recipients receive a wrapper at deposit time but can only spend it after the
timelock expires. The design integrates an optional self-imposed guardian
co-sign for outflows and a relayer-tip system for keeper-driven settlement.

**Codebase:** `src/SLOW.sol` (~980 lines, two contracts)
- `SLOW` — main wrapper, ERC-1155, guardian state machine, deposit / transfer /
  withdraw / reverse / clawback paths.
- `SLOWGate` — constrained CREATE2-deployed forwarder. Holds optional
  per-transfer ETH tips and exposes a `claim` / `claimMany` keeper interface.

**Compiler:** `^0.8.34`, optimizer enabled.
**Build / test:** Foundry. 150 tests, all passing.

## Key entities

- **`uint256 id = (uint96 delay << 160) | uint160(token)`** — ERC-1155 id
  encodes both the underlying asset and the timelock duration. Each combination
  is its own wrapper.
- **`pendingTransfers[transferId]`** — active timelock entries.
  `transferId = keccak256(from, to, id, amount, nonces[from], lastGuardianChange[from], opType)`.
- **`unlockedBalances[user][id]`** — spendable portion of a user's wrapper
  balance. `balanceOf(user, id) == unlockedBalances[user][id] + sum(inbound pending)`.
- **`_outboundTransfers[user]` / `_inboundTransfers[user]`** —
  `EnumerableSetLib.Uint256Set` mirrors of pending entries for indexing.
- **`guardians[user]`** — optional co-signer. While set, every outflow
  (`safeTransferFrom`, `withdrawFrom`) requires `approveTransfer`. Rotation has
  a 1-day veto window.
- **`gate`** — auto-claim forwarder, immutable per SLOW deployment. Cannot
  redirect funds: its only outbound paths call `slow.claim` or
  `slow.claimTipped`, both of which pin payout to `pt.to`.

## State machine

For a delayed deposit (`delay > 0`) from Alice to Bob:

```
DEPOSIT (Alice → Bob)
  Alice → SLOW: pulls ETH/ERC20 reserves
  SLOW: mints wrapper to Bob (locked, unlockedBalances[Bob][id] = 0)
  SLOW: pendingTransfers[transferId] = (now, Alice, Bob, id, amount)
  SLOW: outbound[Alice] += transferId; inbound[Bob] += transferId

  → Within timelock:
       Alice can `reverse(transferId)` — returns wrapper to Alice, credits her
       unlockedBalances. Calls onERC1155Received on Alice (must be implemented
       for contract senders).

  → After timelock expires:
       Bob calls `unlock(transferId)`:
         - moves locked amount into unlockedBalances[Bob][id]
         - removes from inbound/outbound enumeration
         - leaves wrapper with Bob; he must `withdrawFrom` to exit underlying
       OR
       Bob calls `claim(transferId)`:
         - burns wrapper from Bob, sends underlying to Bob directly
         - reverts if Bob has set a guardian (use unlock + withdrawFrom instead)
       OR
       Gate calls `claimTipped(transferId)` (only if a tip was posted via
       depositToWithTip):
         - same payout, no recipient operator-approval needed
         - keeper earns the ETH tip

  → After timelock + 30 days grace, if still pending:
       Alice can `clawback(transferId)` — same shape as reverse, recovers
       wrapper to Alice. Same IERC1155Receiver requirement on Alice.
```

Op-type byte (`_OP_TRANSFER` / `_OP_WITHDRAW`) is mixed into the
guardian-approval preimage so an approval for one operation type cannot be
consumed as the other.

## Threat model

### What guardian protects

- Outflows from `unlockedBalances`: every `safeTransferFrom` and `withdrawFrom`
  while `guardians[user] != 0` requires guardian co-sign on the specific
  `(from, to, id, amount, nonce, epoch, op-type)`.
- A stolen key cannot drain wrapped funds without the guardian also approving.
- The guardian itself is rotated through a 1-day veto window: a stolen key
  proposing `setGuardian(attacker)` can be vetoed by the legitimate guardian
  during the window.

### What guardian does NOT protect

- The user's raw ETH/ERC-20 holdings outside SLOW. (Base-layer concern, out
  of scope.)
- The user's pre-SLOW token approvals — a stolen key with the user's USDC
  allowance to SLOW can call `depositTo` to mint wrapper to the attacker, who
  can then immediately exit. Guardian only co-signs SLOW outflows, not deposits.

### Documented limitations

- **Hostile guardian can permanently freeze withdrawals.** A guardian who
  refuses approvals AND vetoes every `setGuardian(0)` rotation locks the user
  out. Co-sign is a trust relationship; this is by design.
- **Fee-on-transfer / rebasing tokens** desynchronize wrapper supply from
  underlying reserves. Documented in NatSpec on `depositTo`. Users select
  compatible tokens; permissionless wrapping is intentional.
- **Contract senders** (DAOs, smart wallets) must implement `IERC1155Receiver`
  to be eligible for `reverse` / `clawback`, since both paths return the
  wrapper via `_safeTransfer`. Documented.

## Intentional deviations from ERC-1155

- `safeBatchTransferFrom` is disabled (`BatchTransferDisabled`). Per-id
  guardian/timelock state machine doesn't compose cleanly with batching.
- Zero-amount transfers are rejected (`InvalidAmount`). Anti-spam on the
  inbound/outbound enumerable sets.
- `supportsInterface(0xd9b67a26)` still returns true (inherited from Solady).
  Treat the wrapper as ERC-1155-derived rather than fully spec-compliant.

## Areas of focus for review

1. **Pending/unlocked invariant.** For every `(user, id)`:
   `balanceOf(user, id) == unlockedBalances[user][id] + sum(pending.amount where pending.to == user && pending.id == id)`.
   Verified by `testFuzz_BalanceEqualsUnlockedPlusPending`.
2. **Wrapper supply ↔ reserves.** Per token, total wrapped supply equals the
   contract's underlying balance (modulo non-vanilla tokens). Verified by
   `testFuzz_WrappedSupplyMatchesUnderlying`.
3. **Op-byte separation.** Guardian transfer approvals must not satisfy
   withdrawal approvals and vice versa. Verified by
   `testTransferApprovalDoesNotAuthorizeWithdraw` and inverse.
4. **Inbound/outbound set integrity.** Every active pending appears in both
   sets; every set entry corresponds to a live pending. Verified by
   `testFuzz_SetMembershipMirrorsPending`.
5. **Reentrancy.** All state-mutating entry points are `nonReentrant`
   (transient). Reentry into SLOW from a recipient's `onERC1155Received`
   callback is blocked. The gate's `_claimAndPay` deletes `tips[transferId]`
   *before* calling `slow.claimTipped`, so a reentrant `gate.refundTip` from
   `pt.to`'s ETH callback hits the `NoTip` branch — that ordering is
   load-bearing and shouldn't be reordered.
6. **Gate non-redirection.** `SLOWGate` has no path to `safeTransferFrom` or
   `withdrawFrom`. Both `claim` and `claimTipped` pin payout to `pt.to`.
   Verified by `testGateCannotRedirectFunds`.
7. **Guardian rotation correctness.** First-time set is immediate; rotating an
   active guardian stages with 1-day delay; `commitGuardian` invalidates
   dangling approvals via `lastGuardianChange` bump. Verified by
   `testGuardianRotationInvalidatesStaleApproval`.
8. **Auth delegation.** `withdrawFrom` and `safeTransferFrom` both perform
   SLOW-specific state mutations *before* the auth check inside Solady's
   `_burn` / `super.safeTransferFrom`. The unauth revert rolls everything back
   atomically. NatSpec on each function calls this out explicitly.
9. **Multicall safety.** Solady's `Multicallable.multicall` reverts on nonzero
   `msg.value` (`lib/solady/src/utils/Multicallable.sol:34`), defusing the
   classic "reuse `msg.value` to mint multiple ETH deposits" attack class.
   Pinned by `testMulticallDepositValueReuseBlocked`.

## Prior review history

Three rounds of external review converged on no fund-loss findings. Summary:

| Item | Verdict | Resolution |
|---|---|---|
| Multicall msg.value reuse drains pool | Invalid — Solady's `Multicallable` rejects nonzero `msg.value` | Regression test `testMulticallDepositValueReuseBlocked` |
| `withdrawFrom` to `address(this)` / `gate` | Valid — ERC20 has no receiver hook | Fixed: `to != address(this) && to != gate` |
| `safeTransferFrom` to gate strands wrapper | Invalid — Solady ERC1155 receiver check already reverts | No change |
| `_burn` auth via Solady is fragile | Defensive concern, current behavior correct | NatSpec note on delegation |
| Fee-on-transfer / rebasing | Documented limitation | Accept |
| ERC-1155 batch / zero-amount non-compliance | Intentional design | NatSpec deviation note |
| Hostile guardian can freeze | Documented design tradeoff | Accept |
| `unlock` under hostile guardian strands | Misframed — proposed fix would break design | No change |
| Contract sender `IERC1155Receiver` requirement | Documented | Accept |
| Shared nonce across operations | UX consideration, atomic predict-and-submit is the mitigation | Accept |
| Post-grace clawback race | Policy choice | Accept |
| `_HTML_REGISTRY` hardcoded | Verified for Base | Document for porting |
| Constructor `payable` | Self-grief at most | No change |
| `EnumerableSetLib.at` ordering instability | True | NatSpec note for indexers |
| Paired `(needed, transferId)` view | Wallet ergonomics, off-chain | Skip |
| `GuardianChangeNotReady` selector reused for opposite conditions | Valid clarity issue | Added `GuardianChangeAlreadyCommittable` |

### Cleanups landed during review

- `GuardianChangeAlreadyCommittable` distinct error for the
  cancel-window-closed case (previously shared a selector with
  `commitGuardian`'s "too early" revert).
- `withdrawFrom` rejects `to == address(this)` and `to == gate` for symmetry
  with deposit/transfer.
- NatSpec additions: contract-level note on Solady `Multicallable` guard and
  ERC-1155 deviations; enumeration ordering caveat; auth-delegation note on
  `withdrawFrom` and `safeTransferFrom`.

## Test coverage

150 tests, all passing. Suite highlights:

- **Lifecycle**: deposit → unlock → withdraw, deposit → claim, deposit →
  reverse, deposit → clawback (ETH and ERC-20 paths).
- **Invariant fuzz**: `balance == unlocked + pending`, wrapped supply ==
  reserves, set mirroring, nonce monotonicity.
- **Receiver behavior**: reentrancy from `onERC1155Received` blocked on every
  path; revert in receiver unwinds deposit / transfer / clawback cleanly.
- **Guardian state machine**: rotation delay, veto by guardian and user,
  post-delay commit-only, dangling approvals invalidated by `commitGuardian`,
  stolen-key rotation defended.
- **Op-byte separation**: transfer approval doesn't authorize withdrawal and
  vice versa; `isWithdrawalApprovalNeeded` flips independently.
- **Gate**: non-redirection (`testGateCannotRedirectFunds`), atomic
  `claimMany`, tipped vs untipped sibling isolation, tip refund via every
  settlement path, guardian-recipient deadlock recovery.
- **URI**: malicious metadata escaped, partial UTF-8 trimmed, long names
  clipped, address row suppressed for ETH.
- **Multicall**: `testMulticallDepositValueReuseBlocked` pins the Solady
  guard.

## Out of scope

- Non-vanilla token behavior (fee-on-transfer, rebasing, malicious ERC-20
  callbacks). Permissionless wrapping is intentional; documented limitation.
- Front-end / dapp UI behavior.
- Off-chain indexer / API routes (separate codebase).
- Multi-chain portability — `_HTML_REGISTRY` is hardcoded for the target
  deployment; verify presence on any other chain before porting.

## Deployment

- Solidity `^0.8.34`, optimizer enabled. Pin exact compiler at deploy.
- Constructor takes two `bytes` halves of the on-chain HTML payload (stored
  via SSTORE2 with deterministic salts `1` and `2`).
- Constructor calls
  `IHtmlRegistry(0xFa11bacCdc38022dbf8795cC94333304C9f22722).setHtmlAsTarget(address(this), html)` —
  registry must exist on the target chain or the deployment reverts.
- The gate is deployed in the SLOW constructor via
  `new SLOWGate{salt: bytes32(0)}()`, so its address is deterministic relative
  to SLOW's address.
- No admin, no upgrade path, no pause. Any post-deploy issue is permanent.
