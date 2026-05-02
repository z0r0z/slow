# SLOWGate
[Git Source](https://github.com/z0r0z/slow/blob/a444cae9b3143d453da8c91a945ec2ad0e762432/src/SLOW.sol)

`claim`-only operator for keeper-driven settlement. Approve via
`setApprovalForAll(slow.gate(), true)`. Cannot redirect funds: the gate has
no path to `safeTransferFrom` or `withdrawFrom`, and `claim` pins payout to `pt.to`.
Holds optional per-transfer relayer tips posted via `SLOW.depositToWithTip`.


## State Variables
### slow

```solidity
SLOW public immutable slow = SLOW(msg.sender)
```


### tips

```solidity
mapping(uint256 transferId => Tip) public tips
```


## Functions
### constructor


```solidity
constructor() payable;
```

### recordTip


```solidity
function recordTip(uint256 transferId, address sender, address to) public payable;
```

### claim

Settle one transfer through the gate. If a tip is attached, pays it
to `msg.sender` and routes through `slow.claimTipped` (no recipient approval
required); otherwise routes through `slow.claim`, which requires `pt.to` to
have approved the gate via `setApprovalForAll`.


```solidity
function claim(uint256 transferId) public;
```

### claimMany

Atomic batch settlement; the whole call reverts on the first failure.
Keepers must filter ids off-chain (timelock-expired, no guardian on `pt.to`).


```solidity
function claimMany(uint256[] calldata transferIds) public;
```

### refundTip

Recover an unclaimed tip after the underlying transfer cleared via a
non-gate path (`unlock`, `reverse`, `clawback`, or recipient-direct `claim`).
Callable only by the original depositor; reverts while the transfer is still pending.


```solidity
function refundTip(uint256 transferId) public;
```

### _claimAndPay


```solidity
function _claimAndPay(uint256 transferId) internal;
```

## Events
### TipPosted

```solidity
event TipPosted(
    uint256 indexed transferId, uint96 amount, address indexed sender, address indexed to
);
```

### TipRefunded

```solidity
event TipRefunded(uint256 indexed transferId, uint96 amount, address indexed to);
```

### TipPaid

```solidity
event TipPaid(uint256 indexed transferId, uint96 amount, address indexed to);
```

## Errors
### TipStillPending

```solidity
error TipStillPending();
```

### InvalidAmount

```solidity
error InvalidAmount();
```

### Unauthorized

```solidity
error Unauthorized();
```

### NoTip

```solidity
error NoTip();
```

## Structs
### Tip

```solidity
struct Tip {
    uint96 amount;
    address sender;
}
```

