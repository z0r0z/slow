# 🔐 Security Review — SLOW

---

## Scope

|                                  |                                                        |
| -------------------------------- | ------------------------------------------------------ |
| **Mode**                         | filename (`SLOW.sol`)                                  |
| **Files reviewed**               | `src/SLOW.sol`                                         |
| **Confidence threshold (1-100)** | 80                                                     |

---

## Findings

_No findings cleared all four gates at confidence ≥ 80._

The contract has a tight, well-documented threat model. Each candidate raised by the eight agents was rejected at one of the four gates: most were either explicitly documented behaviors (fee-on-transfer / rebasing token deviation, hostile-guardian veto loop, contract-sender-must-implement-`IERC1155Receiver` for `reverse`/`clawback`, tipped-settlement blocked once recipient sets a guardian, first-time `setGuardian` immediate), structurally impossible (gate non-redirection, multicall `msg.value` reuse blocked by Solady's `Multicallable`, transferId collision blocked by per-sender `nonces++` and op-byte separation), or self-harm (max-delay deposits, sending ETH to non-1155-aware recipients, lost-key refund inability).

One below-threshold note follows.

---

[60] **1. Inbound-set dust-spam griefing**

`SLOW.depositTo` · Confidence: 60

**Description**
`depositTo` only gates on `amount != 0`, so any unprivileged caller can spam 1-wei (or 1-unit) timelocked deposits to a victim's address, growing `_inboundTransfers[victim]` unboundedly. Attacker funds are recoverable via `clawback` after `delay + 30 days`, so this isn't a fund-loss path; the contract never iterates the set in any state-mutating function, so no on-chain DoS; pagination getters (`inboundTransferCount` + `inboundTransferAt`) exist for sane consumers. The only impact is `getInboundTransfers` (full-array getter) OOG'ing for off-chain indexers / dapp UIs that don't paginate, plus per-`unlock` cleanup gas for the recipient. Documentation-level concern; flagged for indexer/UI implementers, not a contract bug.

---

Findings List

| # | Confidence | Title |
|---|---|---|
| 1 | [60] | Inbound-set dust-spam griefing |

---

## Leads

_Vulnerability trails with concrete code smells where the full exploit path could not be completed in one analysis pass. These are not false positives — they are high-signal leads for manual review. Not scored._

Most items below are **documented design tradeoffs** verified against NatSpec. Listed for completeness so future maintainers re-evaluating the threat model have a single index.

- **Recipient guardian-set blocks tipped settlement (mempool frontrun OR `_mint` receiver hook)** — `SLOW.depositToWithTip` / `SLOW._finishDeposit` — Code smells: `_mint(to, ...)` (line 505) fires `onERC1155Received` on `to` *before* `pendingTransfers` is recorded and *before* `recordTip` runs on the gate; `setGuardian` is not `nonReentrant`, so a contract recipient can call `setGuardian(X)` from inside its receiver hook, retroactively blocking `claimTipped` (`_doClaim` reverts `ClaimBlockedByGuardian`). Same effect achievable post-deposit via plain `setGuardian` tx. **Documented in NatSpec (lines 466–468):** "If `to` sets a guardian post-deposit, tipped settlement is blocked; the tip is recoverable via `gate.refundTip` once `clawback` (after the 30-day grace) clears the pending entry." Tip is recoverable; recipient gains nothing — pure griefing of depositor's tip and keeper market for the `delay + 30 days` window.
- **`SLOWGate.claimMany` atomic-batch DoS** — `SLOWGate.claimMany` — Code smells: bare `for` loop over `_claimAndPay`; any single revert (gas-burn `receive` in a hostile `pt.to`, post-deposit `setGuardian`, fee-on-transfer underflow on the underlying side) aborts the entire batch. SLOW's `nonReentrant` prevents nested-claim theft. **Documented as offchain-filtering responsibility** (NatSpec line 949: "Keepers must filter ids off-chain (timelock-expired, no guardian on `pt.to`)"); listed because the on-chain exposure is non-obvious to keeper integrators.
- **Hostile-guardian rotation veto loop** — `SLOW.setGuardian` / `cancelGuardianChange` — Code smells: `cancelGuardianChange` requires `block.timestamp < effectiveAt`, `commitGuardian` requires `block.timestamp >= effectiveAt`, so the guardian always wins the race during their window; user can re-propose, guardian re-cancels, no on-chain escape exists. **Documented in NatSpec (lines 337–339):** "a hostile guardian can veto every rotation proposal indefinitely. Appoint a guardian only if you trust them." Listed because the asymmetry has zero on-chain mitigation — only social/legal recourse.
- **Stale `guardianApproved[transferId]` residue from cross-namespace pre-approvals** — `SLOW._finishDeposit` / `approveTransfer` — Code smells: deposit transferIds use the same `_OP_TRANSFER` preimage as `safeTransferFrom`. If a guardian pre-approves `predictTransferId(depositor, to, id, amount)` and the depositor instead calls `depositTo` with the same params at the same nonce, the approval is left orphaned (`guardianApproved[transferId] = true`) — `_finishDeposit` doesn't consume it, depositor's nonce moves on. **Storage bloat only, not exploitable** because nonces are monotonically increasing and approvals are bound to the consumed nonce — fragile against future logic changes that re-use the namespace, but no current attack path.
- **`refundTip` depositor-only refund (no fallback for lost key)** — `SLOWGate.refundTip` — Code smells: only `msg.sender == t.sender` can refund; if the original depositor's key is lost (or the depositor was a contract that self-destructed) before settlement clears the pending entry, the tip is permanently stuck. **Self-harm by depositor**, no protocol-level fix possible without compromising the access model. Asymmetric with the recipient-side ERC1155 recovery available via `clawback` (depositor recovers underlying but not tip).
- **Contract-sender bricking on `reverse` / `clawback`** — `SLOW.reverse` / `SLOW.clawback` — Code smells: `_safeTransfer(0, pt.to, pt.from, id, amount, "")` invokes `onERC1155Received` on `pt.from`. A depositor that is a contract not implementing `IERC1155Receiver` (typical case — the receiver hook fired on `to`, not `from`, at deposit time) cannot `reverse` before expiry or `clawback` after grace. **Documented in NatSpec (lines 648–650, 677).** SDK / dapp integrators using off-the-shelf depositor contracts should surface this loudly.
- **First-time / post-removal `setGuardian` is immediate (no veto window)** — `SLOW.setGuardian` — Code smells: line 309-313 sets `guardians[user] = newGuardian` and bumps `lastGuardianChange` immediately when `guardians[user] == address(0)`. After a user committed a guardian removal, a stolen key has a window in which it can immediately re-set a malicious guardian without any veto. **Documented in NatSpec (line 290):** "First-time set (or post-removal) is immediate." The 1-day delay only protects *active* guardians. Listed because the asymmetry isn't always obvious to integrators reasoning about "guardian protection is always 1 day."

---

> ⚠️ This review was performed by an AI assistant. AI analysis can never verify the complete absence of vulnerabilities and no guarantee of security is given. Team security reviews, bug bounty programs, and on-chain monitoring are strongly recommended. For a consultation regarding your projects' security, visit [https://www.pashov.com](https://www.pashov.com)
