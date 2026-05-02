# SLOW
[Git Source](https://github.com/z0r0z/slow/blob/a444cae9b3143d453da8c91a945ec2ad0e762432/src/SLOW.sol)

**Inherits:**
ERC1155, Multicallable, ReentrancyGuardTransient

Timelocked token sends with optional guardian co-sign and tipped settlement.

ERC1155 ids encode `(token, delay)`. Senders can `reverse` during the timelock
or `clawback` after a 30-day post-expiry grace. Recipients settle via `unlock` +
`withdrawFrom`, or `claim` for direct underlying payout. `depositToWithTip` posts
a relayer tip on the gate so any keeper can settle without recipient approval.
Guardian is a self-imposed co-sign mode on `safeTransferFrom` / `withdrawFrom`.
`multicall` is inherited from Solady's `Multicallable`, which reverts on nonzero
`msg.value` — payable deposits cannot be batched to drain the pool via msg.value reuse.
ERC-1155 deviations: `safeBatchTransferFrom` is disabled and zero-amount transfers
are rejected (avoids spamming the inbound/outbound sets via 0-amount delayed sends). `supportsInterface`
still reports ERC-1155 — treat this as ERC-1155-derived rather than fully compliant.


## State Variables
### _GUARDIAN_CHANGE_DELAY

```solidity
uint256 internal constant _GUARDIAN_CHANGE_DELAY = 1 days
```


### _CLAWBACK_GRACE

```solidity
uint256 internal constant _CLAWBACK_GRACE = 30 days
```


### _OP_TRANSFER

```solidity
uint8 internal constant _OP_TRANSFER = 0
```


### _OP_WITHDRAW

```solidity
uint8 internal constant _OP_WITHDRAW = 1
```


### guardianApproved

```solidity
mapping(address user => mapping(uint256 transferId => bool)) public guardianApproved
```


### _outboundTransfers

```solidity
mapping(address user => EnumerableSetLib.Uint256Set) internal _outboundTransfers
```


### _inboundTransfers

```solidity
mapping(address user => EnumerableSetLib.Uint256Set) internal _inboundTransfers
```


### unlockedBalances

```solidity
mapping(address user => mapping(uint256 id => uint256)) public unlockedBalances
```


### pendingTransfers

```solidity
mapping(uint256 transferId => PendingTransfer) public pendingTransfers
```


### lastGuardianChange

```solidity
mapping(address user => uint256 timestamp) public lastGuardianChange
```


### pendingGuardian

```solidity
mapping(address user => PendingGuardian) public pendingGuardian
```


### guardians

```solidity
mapping(address user => address) public guardians
```


### nonces

```solidity
mapping(address user => uint256) public nonces
```


### gate
CREATE2-deployed auto-claim forwarder. Approve via
`setApprovalForAll(slow.gate(), true)` to opt into keeper-driven settlement.


```solidity
address public immutable gate
```


### htmlChunk1

```solidity
address internal immutable htmlChunk1
```


### htmlChunk2

```solidity
address internal immutable htmlChunk2
```


## Functions
### constructor


```solidity
constructor(address _htmlChunk1, address _htmlChunk2) payable;
```

### html

Returns the full SLOW dapp HTML reassembled from onchain SSTORE2 chunks.


```solidity
function html() public view returns (string memory);
```

### name


```solidity
function name() public pure returns (string memory);
```

### symbol


```solidity
function symbol() public pure returns (string memory);
```

### uri


```solidity
function uri(uint256 id) public view override(ERC1155) returns (string memory);
```

### predictTransferId

Hash matching the next guardian-gated or delayed `safeTransferFrom` by
`from` at the current `nonces[from]` / `lastGuardianChange[from]`. Plain
transfers (no delay, no guardian) consume no id. Use this for guardian co-sign
of wrapper transfers; use `predictWithdrawalId` for raw exits. Delayed
`depositTo` also produces a pending transfer id under this preimage, but
deposits are not guardian-gated — the hash is exposed only as a handle for indexers.


```solidity
function predictTransferId(address from, address to, uint256 id, uint256 amount)
    public
    view
    returns (uint256);
```

### predictWithdrawalId

Hash matching the next `withdrawFrom` by `from` at the current
`nonces[from]` / `lastGuardianChange[from]`. The op-type byte separates
withdraw approvals from transfer approvals at the same `(from, to, id, amount)`.


```solidity
function predictWithdrawalId(address from, address to, uint256 id, uint256 amount)
    public
    view
    returns (uint256);
```

### decodeId


```solidity
function decodeId(uint256 id) public pure returns (address token, uint256 delay);
```

### encodeId


```solidity
function encodeId(address token, uint96 delay) public pure returns (uint256 id);
```

### canReverseTransfer


```solidity
function canReverseTransfer(uint256 transferId)
    public
    view
    returns (bool canReverse, bytes4 reason);
```

### isGuardianApprovalNeeded


```solidity
function isGuardianApprovalNeeded(address user, address to, uint256 id, uint256 amount)
    public
    view
    returns (bool needed);
```

### isWithdrawalApprovalNeeded

Like `isGuardianApprovalNeeded` but for `withdrawFrom` instead of
`safeTransferFrom`. Distinct preimage; a transfer approval will not satisfy this.


```solidity
function isWithdrawalApprovalNeeded(address user, address to, uint256 id, uint256 amount)
    public
    view
    returns (bool needed);
```

### getOutboundTransfers


```solidity
function getOutboundTransfers(address user) public view returns (uint256[] memory);
```

### getInboundTransfers


```solidity
function getInboundTransfers(address user) public view returns (uint256[] memory);
```

### outboundTransferCount


```solidity
function outboundTransferCount(address user) public view returns (uint256);
```

### inboundTransferCount


```solidity
function inboundTransferCount(address user) public view returns (uint256);
```

### outboundTransferAt


```solidity
function outboundTransferAt(address user, uint256 index) public view returns (uint256);
```

### inboundTransferAt


```solidity
function inboundTransferAt(address user, uint256 index) public view returns (uint256);
```

### setGuardian

Co-sign mode for `safeTransferFrom` / `withdrawFrom`: while
`guardians[user] != 0`, every outflow needs `approveTransfer` from that address.

First-time set (or post-removal) is immediate. Rotating an active guardian
stages `pendingGuardian` with a `_GUARDIAN_CHANGE_DELAY` veto window — user or
current guardian can `cancelGuardianChange` before `effectiveAt`, anyone can
`commitGuardian` after. This protects already-wrapped balances against key
compromise: a stolen key cannot remove a live guardian without the veto window.
Post-window abort: once `block.timestamp >= effectiveAt`, the rotation is
considered decided and `commitGuardian` becomes permissionless — neither
`cancelGuardianChange` nor `setGuardian(currentGuardian)` can clear the
pending entry. To abort late, propose a different guardian (this overwrites
the pending entry and restarts the window), then `cancelGuardianChange`
during the new window. This is intentional: the 1-day delay is the decision
window, not an indefinite veto.


```solidity
function setGuardian(address newGuardian) public nonReentrant;
```

### commitGuardian

Apply a proposed guardian change after the delay. Permissionless poke.
`lastGuardianChange` updates here, invalidating any dangling approvals bound
to the previous preimage.


```solidity
function commitGuardian(address user) public;
```

### cancelGuardianChange

Veto a pending guardian change during the delay window. Callable by
`user` or `guardians[user]`. After the delay only `commitGuardian` is valid.

Guardian-side cancel is the protection: it lets a legitimate guardian
defeat a stolen key proposing `setGuardian(attacker)`. The trade-off is that
a hostile guardian can veto every rotation proposal indefinitely. Appoint a
guardian only if you trust them — that is what co-sign means.


```solidity
function cancelGuardianChange(address user) public;
```

### approveTransfer

Approve a precomputed transferId for `from`. Callable only by `guardians[from]`.

Use `predictTransferId` for transfer approvals and `predictWithdrawalId` for
withdrawal approvals — the preimages differ, so approving one will not satisfy the
other. `commitGuardian` bumps `lastGuardianChange` and invalidates every dangling
approval. The on-chain op-split prevents cross-op consumption, not malicious
approval of the wrong op — guardians must still verify intent off-chain.


```solidity
function approveTransfer(address from, uint256 transferId) public;
```

### revokeApproval

Retract a previously granted approval. Callable only by `guardians[from]`.

Undo a single mistaken approval without rotating the guardian (which would
invalidate ALL approvals). Idempotent — revoking a clear slot is a no-op.


```solidity
function revokeApproval(address from, uint256 transferId) public;
```

### unlock

After expiry, moves the pending transfer into `unlockedBalances[pt.to]`.
The wrapper stays at `pt.to`; outbound transfers re-lock per the id's encoded delay.

Gated to `pt.to` or any operator approved via `setApprovalForAll`. Prevents
third-party griefers from frontrunning settlement and stranding the sender's
`clawback` path or the keeper's tip on `gate.claim`.


```solidity
function unlock(uint256 transferId) public nonReentrant;
```

### claim

Auto-settle path. After expiry, burns the wrapper from `pt.to` and pays
the raw underlying directly to `pt.to`. Skips the unlocked-balance step.

Callable by `pt.to` or any operator approved via `setApprovalForAll`.
Reverts when `pt.to` has a guardian set — guardian-mode recipients settle via
`unlock` + `withdrawFrom`, where the raw exit is guardian-gated.


```solidity
function claim(uint256 transferId) public nonReentrant;
```

### claimTipped

Sender-sponsored claim path. Skips the operator-approval check;
callable only by the gate, which only invokes this for transfers carrying
a relayer tip posted via `depositToWithTip`. Guardian veto still applies.


```solidity
function claimTipped(uint256 transferId) public nonReentrant;
```

### _doClaim

Settles `pt` and pays `pt.to`. Auth is upstream-gated by every caller
(`claim` checks `msg.sender == pt.to || isApprovedForAll`; `claimTipped`
checks `msg.sender == gate`). The internal `_burn(address(0), ...)` here
passes the zero-address sentinel and skips Solady's `NotOwnerNorApproved`
check — any future caller of this function MUST enforce its own auth.


```solidity
function _doClaim(uint256 transferId, PendingTransfer memory pt) internal;
```

### depositTo

Wraps `amount` of `token` (or `msg.value` for ETH) for `to` with `delay`
timelock. `delay == 0` mints unlocked; otherwise creates a pending transfer.

Mints the wrapper at face value of the deposited amount. Assumes vanilla
ERC20 semantics: fee-on-transfer, rebasing, and other nonstandard tokens will
leave wrapper supply diverged from the contract's underlying reserves and may
leave late withdrawers unable to exit. For rebasing assets use wstETH-style
non-rebasing wrappers.


```solidity
function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
    public
    payable
    nonReentrant
    returns (uint256 transferId);
```

### depositToWithTip

Deposit with a relayer tip. Tip pays whoever lands `gate.claim`;
otherwise refundable to the depositor via `gate.refundTip`.

`msg.value == amount + tip` for ETH or `tip` for ERC20. `delay != 0`,
`tip != 0`, and `tip <= type(uint96).max` (the gate stores tips packed in a uint96).
If `to` has a guardian when `claimTipped` runs, tipped settlement is blocked;
the tip becomes refundable via `gate.refundTip` once the pending entry clears
by any path (`unlock` by `to`, sender `reverse` during the timelock, or sender
`clawback` after the 30-day grace).


```solidity
function depositToWithTip(
    address token,
    address to,
    uint256 amount,
    uint96 delay,
    uint256 tip,
    bytes calldata data
) public payable nonReentrant returns (uint256 transferId);
```

### _finishDeposit


```solidity
function _finishDeposit(
    address token,
    address to,
    uint256 amount,
    uint96 delay,
    uint256 tip,
    bytes calldata data
) internal returns (uint256 transferId);
```

### withdrawFrom

Caller authorization (msg.sender == from or operator-approved) is enforced by
Solady's `_burn(by, from, ...)`, which reverts `NotOwnerNorApproved` on mismatch.
Pre-burn state changes here roll back on that revert.


```solidity
function withdrawFrom(address from, address to, uint256 id, uint256 amount)
    public
    nonReentrant;
```

### safeTransferFrom

Caller authorization is enforced by `super.safeTransferFrom` (Solady), which
reverts `NotOwnerNorApproved` unless msg.sender == from or operator-approved.
Pre-call state changes roll back on that revert.


```solidity
function safeTransferFrom(
    address from,
    address to,
    uint256 id,
    uint256 amount,
    bytes calldata data
) public override(ERC1155) nonReentrant;
```

### reverse

Cancels a pending transfer before its timelock expires. Returns the wrapper
to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from` or any
operator approved via `setApprovalForAll`.

Move uses `_safeTransfer`, which calls `onERC1155Received` on `pt.from` per
ERC1155 spec. Contract depositors must implement `IERC1155Receiver` to be
reverse-eligible — they did not receive the 1155 at deposit (minted to `pt.to`).
EOAs unaffected.


```solidity
function reverse(uint256 transferId) public nonReentrant;
```

### clawback

Sender recovery for unsettled transfers (e.g. dead/lost recipient). Returns
the wrapper to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from`
or any operator approved via `setApprovalForAll`.

Available 30 days past timelock expiry. Wrapper-route like `reverse`, so any
subsequent raw exit goes through `withdrawFrom` and inherits guardian gating.
`_safeTransfer` invokes `onERC1155Received` on `pt.from`; contract senders must
implement `IERC1155Receiver`. Only catches transfers still pending — once `unlock`
or `claim` runs, settlement to `pt.to` is final.


```solidity
function clawback(uint256 transferId) public nonReentrant;
```

### _formatDelay


```solidity
function _formatDelay(uint256 delay) internal pure returns (string memory);
```

### _createURI


```solidity
function _createURI(uint256 id) internal view returns (string memory);
```

### _utf8Trim


```solidity
function _utf8Trim(string memory s) internal pure returns (string memory);
```

### _clipForDisplay


```solidity
function _clipForDisplay(string memory s, uint256 maxBytes)
    internal
    pure
    returns (string memory);
```

### _createImage


```solidity
function _createImage(
    address token,
    uint256 delay,
    string memory delayLabel,
    string memory tokenName,
    string memory tokenSymbol
) internal pure returns (string memory);
```

### safeBatchTransferFrom


```solidity
function safeBatchTransferFrom(
    address,
    address,
    uint256[] calldata,
    uint256[] calldata,
    bytes calldata
) public pure override(ERC1155);
```

## Events
### Unlocked

```solidity
event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
```

### TransferApproved

```solidity
event TransferApproved(
    address indexed guardian, address indexed user, uint256 indexed transferId
);
```

### TransferApprovalRevoked

```solidity
event TransferApprovalRevoked(
    address indexed guardian, address indexed user, uint256 indexed transferId
);
```

### GuardianChangeProposed

```solidity
event GuardianChangeProposed(
    address indexed user, address indexed newGuardian, uint256 effectiveAt
);
```

### TransferPending

```solidity
event TransferPending(uint256 indexed transferId, uint256 indexed delay);
```

### GuardianSet

```solidity
event GuardianSet(address indexed user, address indexed guardian);
```

### TransferClawedBack

```solidity
event TransferClawedBack(uint256 indexed transferId);
```

### TransferReversed

```solidity
event TransferReversed(uint256 indexed transferId);
```

### GuardianChangeCanceled

```solidity
event GuardianChangeCanceled(address indexed user);
```

### TransferClaimed

```solidity
event TransferClaimed(uint256 indexed transferId);
```

## Errors
### GuardianChangeAlreadyCommittable

```solidity
error GuardianChangeAlreadyCommittable();
```

### GuardianApprovalRequired

```solidity
error GuardianApprovalRequired();
```

### NoGuardianChangePending

```solidity
error NoGuardianChangePending();
```

### ClaimBlockedByGuardian

```solidity
error ClaimBlockedByGuardian();
```

### GuardianChangeNotReady

```solidity
error GuardianChangeNotReady();
```

### BatchTransferDisabled

```solidity
error BatchTransferDisabled();
```

### TransferDoesNotExist

```solidity
error TransferDoesNotExist();
```

### TimelockNotExpired

```solidity
error TimelockNotExpired();
```

### ClawbackNotReady

```solidity
error ClawbackNotReady();
```

### InvalidRecipient

```solidity
error InvalidRecipient();
```

### InvalidGuardian

```solidity
error InvalidGuardian();
```

### TimelockExpired

```solidity
error TimelockExpired();
```

### InvalidDeposit

```solidity
error InvalidDeposit();
```

### InvalidAmount

```solidity
error InvalidAmount();
```

### Unauthorized

```solidity
error Unauthorized();
```

## Structs
### PendingTransfer

```solidity
struct PendingTransfer {
    uint96 timestamp;
    address from;
    address to;
    uint256 id;
    uint256 amount;
}
```

### PendingGuardian
Pending guardian rotation; packs into a single slot. `effectiveAt != 0` means in flight.


```solidity
struct PendingGuardian {
    address guardian;
    uint96 effectiveAt;
}
```

