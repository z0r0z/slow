// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.34;

import {Base64} from "@solady/src/utils/Base64.sol";
import {SSTORE2} from "@solady/src/utils/SSTORE2.sol";
import {ERC1155} from "@solady/src/tokens/ERC1155.sol";
import {LibString} from "@solady/src/utils/LibString.sol";
import {Multicallable} from "@solady/src/utils/Multicallable.sol";
import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {EnumerableSetLib} from "@solady/src/utils/EnumerableSetLib.sol";
import {MetadataReaderLib} from "@solady/src/utils/MetadataReaderLib.sol";
import {ReentrancyGuardTransient} from "@solady/src/utils/ReentrancyGuardTransient.sol";

/// @notice Timelocked token sends with optional guardian co-sign and tipped settlement.
/// @dev ERC1155 ids encode `(token, delay)`. Senders can `reverse` during the timelock
/// or `clawback` after a 30-day post-expiry grace. Recipients settle via `unlock` +
/// `withdrawFrom`, or `claim` for direct underlying payout. `depositToWithTip` posts
/// a relayer tip on the gate so any keeper can settle without recipient approval.
/// Guardian is a self-imposed co-sign mode on `safeTransferFrom` / `withdrawFrom`.
/// `multicall` is inherited from Solady's `Multicallable`, which reverts on nonzero
/// `msg.value` — payable deposits cannot be batched to drain the pool via msg.value reuse.
/// ERC-1155 deviations: `safeBatchTransferFrom` is disabled and zero-amount transfers
/// are rejected (anti-spam on the enumerable inbound/outbound sets). `supportsInterface`
/// still reports ERC-1155 — treat this as ERC-1155-derived rather than fully compliant.
contract SLOW is ERC1155, Multicallable, ReentrancyGuardTransient {
    using EnumerableSetLib for EnumerableSetLib.Uint256Set;
    using MetadataReaderLib for address;
    using SafeTransferLib for address;
    using LibString for address;
    using LibString for uint256;

    event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
    event TransferApproved(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event TransferApprovalRevoked(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event GuardianChangeProposed(
        address indexed user, address indexed newGuardian, uint256 effectiveAt
    );
    event TransferPending(uint256 indexed transferId, uint256 indexed delay);
    event GuardianSet(address indexed user, address indexed guardian);
    event TransferClawedBack(uint256 indexed transferId);
    event TransferReversed(uint256 indexed transferId);
    event GuardianChangeCanceled(address indexed user);
    event TransferClaimed(uint256 indexed transferId);

    error GuardianApprovalRequired();
    error NoGuardianChangePending();
    error ClaimBlockedByGuardian();
    error GuardianChangeNotReady();
    error GuardianChangeAlreadyCommittable();
    error BatchTransferDisabled();
    error TransferDoesNotExist();
    error TimelockNotExpired();
    error ClawbackNotReady();
    error InvalidRecipient();
    error InvalidGuardian();
    error TimelockExpired();
    error InvalidDeposit();
    error InvalidAmount();
    error Unauthorized();

    struct PendingTransfer {
        uint96 timestamp;
        address from;
        address to;
        uint256 id;
        uint256 amount;
    }

    /// @dev Pending guardian rotation; packs into a single slot. `effectiveAt != 0` means in flight.
    struct PendingGuardian {
        address guardian;
        uint96 effectiveAt;
    }

    uint256 internal constant _GUARDIAN_CHANGE_DELAY = 1 days; // Veto window for guardian rotation.
    uint256 internal constant _CLAWBACK_GRACE = 30 days; // Wait after expiry before sender can clawback.

    // Op-type byte mixed into guardian-approval preimages. Distinguishes wrapper
    // transfers from raw withdrawals so a guardian approval for one cannot be
    // consumed as the other at the same `(from, to, id, amount)`.
    uint8 internal constant _OP_TRANSFER = 0;
    uint8 internal constant _OP_WITHDRAW = 1;

    address internal constant _HTML_REGISTRY = 0xFa11bacCdc38022dbf8795cC94333304C9f22722;

    mapping(address user => EnumerableSetLib.Uint256Set) internal _outboundTransfers;

    mapping(address user => EnumerableSetLib.Uint256Set) internal _inboundTransfers;

    mapping(address user => mapping(uint256 id => uint256)) public unlockedBalances;

    mapping(uint256 transferId => PendingTransfer) public pendingTransfers;

    mapping(address user => uint256 timestamp) public lastGuardianChange;

    mapping(address user => PendingGuardian) public pendingGuardian;

    mapping(uint256 transferId => bool) public guardianApproved;

    mapping(address user => address) public guardians;

    mapping(address user => uint256) public nonces;

    /// @notice CREATE2-deployed auto-claim forwarder. Approve via
    /// `setApprovalForAll(slow.gate(), true)` to opt into keeper-driven settlement.
    address public immutable gate;

    address internal immutable htmlChunk1;
    address internal immutable htmlChunk2;

    constructor(bytes memory part1, bytes memory part2) payable {
        htmlChunk1 = SSTORE2.writeDeterministic(part1, bytes32(uint256(1)));
        htmlChunk2 = SSTORE2.writeDeterministic(part2, bytes32(uint256(2)));
        gate = address(new SLOWGate{salt: bytes32(0)}());
        IHtmlRegistry(_HTML_REGISTRY)
            .setHtmlAsTarget(address(this), string(bytes.concat(part1, part2)));
    }

    /// @notice Returns the full SLOW dapp HTML reassembled from onchain SSTORE2 chunks.
    function html() public view returns (string memory) {
        return string(bytes.concat(SSTORE2.read(htmlChunk1), SSTORE2.read(htmlChunk2)));
    }

    // METADATA

    function name() public pure returns (string memory) {
        return "SLOW";
    }

    function symbol() public pure returns (string memory) {
        return "SLOW";
    }

    function uri(uint256 id) public view override(ERC1155) returns (string memory) {
        return _createURI(id);
    }

    // VIEWERS

    /// @notice Hash matching the next `safeTransferFrom` by `from` at the current
    /// `nonces[from]` / `lastGuardianChange[from]`. Use this for guardian co-sign of
    /// wrapper transfers; use `predictWithdrawalId` for raw exits. Delayed `depositTo`
    /// also produces a pending transfer id under this preimage, but deposits are not
    /// guardian-gated — the hash is exposed only as a handle for indexers.
    function predictTransferId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    from, to, id, amount, nonces[from], lastGuardianChange[from], _OP_TRANSFER
                )
            )
        );
    }

    /// @notice Hash matching the next `withdrawFrom` by `from` at the current
    /// `nonces[from]` / `lastGuardianChange[from]`. The op-type byte separates
    /// withdraw approvals from transfer approvals at the same `(from, to, id, amount)`.
    function predictWithdrawalId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    from, to, id, amount, nonces[from], lastGuardianChange[from], _OP_WITHDRAW
                )
            )
        );
    }

    function decodeId(uint256 id) public pure returns (address token, uint256 delay) {
        (token, delay) = (address(uint160(id)), id >> 160);
    }

    function encodeId(address token, uint96 delay) public pure returns (uint256 id) {
        id = uint256(uint160(token)) | (uint256(delay) << 160);
    }

    function canReverseTransfer(uint256 transferId)
        public
        view
        returns (bool canReverse, bytes4 reason)
    {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];

            if (pt.timestamp == 0) return (false, TransferDoesNotExist.selector);

            if (block.timestamp >= pt.timestamp + (pt.id >> 160)) {
                return (false, TimelockExpired.selector);
            }

            return (true, "");
        }
    }

    function isGuardianApprovalNeeded(address user, address to, uint256 id, uint256 amount)
        public
        view
        returns (bool needed)
    {
        return guardians[user] == address(0)
            ? false
            : !guardianApproved[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            user,
                            to,
                            id,
                            amount,
                            nonces[user],
                            lastGuardianChange[user],
                            _OP_TRANSFER
                        )
                    )
                )
            ];
    }

    /// @notice Like `isGuardianApprovalNeeded` but for `withdrawFrom` instead of
    /// `safeTransferFrom`. Distinct preimage; a transfer approval will not satisfy this.
    function isWithdrawalApprovalNeeded(address user, address to, uint256 id, uint256 amount)
        public
        view
        returns (bool needed)
    {
        return guardians[user] == address(0)
            ? false
            : !guardianApproved[
                uint256(
                    keccak256(
                        abi.encodePacked(
                            user,
                            to,
                            id,
                            amount,
                            nonces[user],
                            lastGuardianChange[user],
                            _OP_WITHDRAW
                        )
                    )
                )
            ];
    }

    // PENDING TRANSFER ENUMERATION
    // EnumerableSetLib swaps with the last element on remove, so positional reads
    // (`outboundTransferAt` / `inboundTransferAt`) are not stable across settlement.
    // Indexers should snapshot via `getOutboundTransfers` / `getInboundTransfers`.

    function getOutboundTransfers(address user) public view returns (uint256[] memory) {
        return _outboundTransfers[user].values();
    }

    function getInboundTransfers(address user) public view returns (uint256[] memory) {
        return _inboundTransfers[user].values();
    }

    function outboundTransferCount(address user) public view returns (uint256) {
        return _outboundTransfers[user].length();
    }

    function inboundTransferCount(address user) public view returns (uint256) {
        return _inboundTransfers[user].length();
    }

    function outboundTransferAt(address user, uint256 index) public view returns (uint256) {
        return _outboundTransfers[user].at(index);
    }

    function inboundTransferAt(address user, uint256 index) public view returns (uint256) {
        return _inboundTransfers[user].at(index);
    }

    // GUARDIAN AUTH

    /// @notice Co-sign mode for `safeTransferFrom` / `withdrawFrom`: while
    /// `guardians[user] != 0`, every outflow needs `approveTransfer` from that address.
    /// @dev First-time set (or post-removal) is immediate. Rotating an active guardian
    /// stages `pendingGuardian` with a `_GUARDIAN_CHANGE_DELAY` veto window — user or
    /// current guardian can `cancelGuardianChange` before `effectiveAt`, anyone can
    /// `commitGuardian` after. This protects already-wrapped balances against key
    /// compromise: a stolen key cannot remove a live guardian without the veto window.
    function setGuardian(address newGuardian) public {
        // Self-guardian provides no protection: a stolen key can also `approveTransfer`.
        require(newGuardian != msg.sender, InvalidGuardian());
        if (newGuardian == guardians[msg.sender]) {
            // Re-proposing the current guardian cancels any in-flight rotation.
            // Bounded by the cancel window so post-delay only `commitGuardian` is valid.
            uint256 effectiveAt = pendingGuardian[msg.sender].effectiveAt;
            if (effectiveAt != 0 && block.timestamp < effectiveAt) {
                delete pendingGuardian[msg.sender];
                emit GuardianChangeCanceled(msg.sender);
            }
            return;
        }
        if (guardians[msg.sender] == address(0)) {
            // First-time / post-removal: immediate. Defensive pending-clear (invariant: empty here).
            delete pendingGuardian[msg.sender];
            lastGuardianChange[msg.sender] = block.timestamp;
            emit GuardianSet(msg.sender, guardians[msg.sender] = newGuardian);
        } else {
            // Active guardian — stage rotation. Each new proposal restarts the veto window.
            unchecked {
                uint256 effectiveAt = block.timestamp + _GUARDIAN_CHANGE_DELAY;
                pendingGuardian[msg.sender] = PendingGuardian(newGuardian, uint96(effectiveAt));
                emit GuardianChangeProposed(msg.sender, newGuardian, effectiveAt);
            }
        }
    }

    /// @notice Apply a proposed guardian change after the delay. Permissionless poke.
    /// `lastGuardianChange` updates here, invalidating any dangling approvals bound
    /// to the previous preimage.
    function commitGuardian(address user) public {
        PendingGuardian memory p = pendingGuardian[user];
        require(p.effectiveAt != 0, NoGuardianChangePending());
        require(block.timestamp >= p.effectiveAt, GuardianChangeNotReady());
        delete pendingGuardian[user];
        lastGuardianChange[user] = block.timestamp;
        emit GuardianSet(user, guardians[user] = p.guardian);
    }

    /// @notice Veto a pending guardian change during the delay window. Callable by
    /// `user` or `guardians[user]`. After the delay only `commitGuardian` is valid.
    /// @dev Guardian-side cancel is the protection: it lets a legitimate guardian
    /// defeat a stolen key proposing `setGuardian(attacker)`. The trade-off is that
    /// a hostile guardian can veto every rotation proposal indefinitely. Appoint a
    /// guardian only if you trust them — that is what co-sign means.
    function cancelGuardianChange(address user) public {
        uint256 effectiveAt = pendingGuardian[user].effectiveAt;
        require(effectiveAt != 0, NoGuardianChangePending());
        require(block.timestamp < effectiveAt, GuardianChangeAlreadyCommittable());
        require(msg.sender == user || msg.sender == guardians[user], Unauthorized());
        delete pendingGuardian[user];
        emit GuardianChangeCanceled(user);
    }

    /// @notice Approve a precomputed transferId for `from`. Callable only by `guardians[from]`.
    /// @dev Use `predictTransferId` for transfer approvals and `predictWithdrawalId` for
    /// withdrawal approvals — the preimages differ, so approving one will not satisfy the
    /// other. `commitGuardian` bumps `lastGuardianChange` and invalidates every dangling
    /// approval. The on-chain op-split prevents cross-op consumption, not malicious
    /// approval of the wrong op — guardians must still verify intent off-chain.
    function approveTransfer(address from, uint256 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        guardianApproved[transferId] = true;
        emit TransferApproved(msg.sender, from, transferId);
    }

    /// @notice Retract a previously granted approval. Callable only by `guardians[from]`.
    /// @dev Undo a single mistaken approval without rotating the guardian (which would
    /// invalidate ALL approvals). Idempotent — revoking a clear slot is a no-op.
    function revokeApproval(address from, uint256 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        if (!guardianApproved[transferId]) return;
        delete guardianApproved[transferId];
        emit TransferApprovalRevoked(msg.sender, from, transferId);
    }

    // UNLOCK

    /// @notice After expiry, moves the pending transfer into `unlockedBalances[pt.to]`.
    /// The wrapper stays at `pt.to`; outbound transfers re-lock per the id's encoded delay.
    /// @dev Gated to `pt.to` or any operator approved via `setApprovalForAll`. Prevents
    /// third-party griefers from frontrunning settlement and stranding the sender's
    /// `clawback` path or the keeper's tip on `gate.claim`.
    function unlock(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(block.timestamp >= pt.timestamp + (id >> 160), TimelockNotExpired());
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            require(msg.sender == to || isApprovedForAll(to, msg.sender), Unauthorized());
            unlockedBalances[to][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit Unlocked(to, id, amount);
        }
    }

    /// @notice Auto-settle path. After expiry, burns the wrapper from `pt.to` and pays
    /// the raw underlying directly to `pt.to`. Skips the unlocked-balance step.
    /// @dev Callable by `pt.to` or any operator approved via `setApprovalForAll`.
    /// Reverts when `pt.to` has a guardian set — guardian-mode recipients settle via
    /// `unlock` + `withdrawFrom`, where the raw exit is guardian-gated.
    function claim(uint256 transferId) public nonReentrant {
        PendingTransfer memory pt = pendingTransfers[transferId];
        require(pt.timestamp != 0, TransferDoesNotExist());
        require(msg.sender == pt.to || isApprovedForAll(pt.to, msg.sender), Unauthorized());
        _doClaim(transferId, pt);
    }

    /// @notice Sender-sponsored claim path. Skips the operator-approval check;
    /// callable only by the gate, which only invokes this for transfers carrying
    /// a relayer tip posted via `depositToWithTip`. Guardian veto still applies.
    function claimTipped(uint256 transferId) public nonReentrant {
        require(msg.sender == gate, Unauthorized());
        PendingTransfer memory pt = pendingTransfers[transferId];
        require(pt.timestamp != 0, TransferDoesNotExist());
        _doClaim(transferId, pt);
    }

    function _doClaim(uint256 transferId, PendingTransfer memory pt) internal {
        unchecked {
            require(block.timestamp >= pt.timestamp + (pt.id >> 160), TimelockNotExpired());
            require(guardians[pt.to] == address(0), ClaimBlockedByGuardian());

            _burn(address(0), pt.to, pt.id, pt.amount);
            _outboundTransfers[pt.from].remove(transferId);
            _inboundTransfers[pt.to].remove(transferId);
            delete pendingTransfers[transferId];

            address token = address(uint160(pt.id));
            if (token == address(0)) pt.to.safeTransferETH(pt.amount);
            else token.safeTransfer(pt.to, pt.amount);

            emit TransferClaimed(transferId);
        }
    }

    // DEPOSIT

    /// @notice Wraps `amount` of `token` (or `msg.value` for ETH) for `to` with `delay`
    /// timelock. `delay == 0` mints unlocked; otherwise creates a pending transfer.
    /// @dev Mints the wrapper at face value of the deposited amount. Assumes vanilla
    /// ERC20 semantics: fee-on-transfer, rebasing, and other nonstandard tokens will
    /// leave wrapper supply diverged from the contract's underlying reserves and may
    /// leave late withdrawers unable to exit. For rebasing assets use wstETH-style
    /// non-rebasing wrappers.
    function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
        public
        payable
        nonReentrant
        returns (uint256 transferId)
    {
        require(to != address(0), InvalidRecipient());
        require(to != address(this), InvalidDeposit());

        if (msg.value != 0) {
            require(token == address(0) && amount == 0, InvalidDeposit());
            amount = msg.value;
        } else {
            require(token != address(0) && amount != 0, InvalidDeposit());
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        return _finishDeposit(token, to, amount, delay, 0, data);
    }

    /// @notice Deposit with a relayer tip. Tip pays whoever lands `gate.claim`;
    /// otherwise refundable to the depositor via `gate.refundTip`.
    /// @dev `msg.value == amount + tip` for ETH or `tip` for ERC20. `delay != 0`,
    /// `tip != 0`, and `tip <= type(uint96).max` (the gate stores tips packed in a uint96).
    /// If `to` sets a guardian post-deposit, tipped settlement is blocked; the tip is
    /// recoverable via `gate.refundTip` once `clawback` (after the 30-day grace) clears
    /// the pending entry.
    function depositToWithTip(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data
    ) public payable nonReentrant returns (uint256 transferId) {
        require(to != address(0), InvalidRecipient());
        require(to != address(this), InvalidDeposit());
        require(amount != 0, InvalidAmount());
        require(delay != 0, InvalidDeposit());
        require(tip != 0 && tip <= type(uint96).max, InvalidAmount());

        if (token == address(0)) {
            require(msg.value == amount + tip, InvalidDeposit());
        } else {
            require(msg.value == tip, InvalidDeposit());
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        return _finishDeposit(token, to, amount, delay, tip, data);
    }

    function _finishDeposit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data
    ) internal returns (uint256 transferId) {
        uint256 id = encodeId(token, delay);

        unchecked {
            _mint(to, id, amount, data);

            if (delay != 0) {
                transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            msg.sender,
                            to,
                            id,
                            amount,
                            nonces[msg.sender]++,
                            lastGuardianChange[msg.sender],
                            _OP_TRANSFER
                        )
                    )
                );

                pendingTransfers[transferId] =
                    PendingTransfer(uint96(block.timestamp), msg.sender, to, id, amount);

                _outboundTransfers[msg.sender].add(transferId);
                _inboundTransfers[to].add(transferId);

                emit TransferPending(transferId, delay);

                // `tip != 0` implies `delay != 0` (enforced by `depositToWithTip`).
                if (tip != 0) SLOWGate(gate).recordTip{value: tip}(transferId, msg.sender, to);
            } else {
                unlockedBalances[to][id] += amount;
            }
        }
    }

    // WITHDRAW

    /// @dev Caller authorization (msg.sender == from or operator-approved) is enforced by
    /// Solady's `_burn(by, from, ...)`, which reverts `NotOwnerNorApproved` on mismatch.
    /// Pre-burn state changes here roll back on that revert.
    function withdrawFrom(address from, address to, uint256 id, uint256 amount)
        public
        nonReentrant
    {
        require(to != address(0) && to != address(this) && to != gate, InvalidRecipient());
        require(amount != 0, InvalidAmount());
        unlockedBalances[from][id] -= amount;

        unchecked {
            if (guardians[from] != address(0)) {
                uint256 transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            from,
                            to,
                            id,
                            amount,
                            nonces[from]++,
                            lastGuardianChange[from],
                            _OP_WITHDRAW
                        )
                    )
                );
                require(guardianApproved[transferId], GuardianApprovalRequired());
                delete guardianApproved[transferId];
            }

            _burn(msg.sender, from, id, amount);

            address token = address(uint160(id));

            if (token == address(0)) {
                to.safeTransferETH(amount);
            } else {
                token.safeTransfer(to, amount);
            }
        }
    }

    // TRANSFER

    /// @dev Caller authorization is enforced by `super.safeTransferFrom` (Solady), which
    /// reverts `NotOwnerNorApproved` unless msg.sender == from or operator-approved.
    /// Pre-call state changes roll back on that revert.
    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) public override(ERC1155) nonReentrant {
        require(to != address(0) && to != address(this), InvalidRecipient());
        require(amount != 0, InvalidAmount());
        unlockedBalances[from][id] -= amount;

        unchecked {
            uint256 delay = id >> 160;
            address guardian = guardians[from];
            bool requiresDelayOrGuardian = guardian != address(0) || delay != 0;

            if (requiresDelayOrGuardian) {
                uint256 transferId = uint256(
                    keccak256(
                        abi.encodePacked(
                            from,
                            to,
                            id,
                            amount,
                            nonces[from]++,
                            lastGuardianChange[from],
                            _OP_TRANSFER
                        )
                    )
                );

                if (guardian != address(0)) {
                    require(guardianApproved[transferId], GuardianApprovalRequired());
                    delete guardianApproved[transferId];
                }

                if (delay != 0) {
                    pendingTransfers[transferId] =
                        PendingTransfer(uint96(block.timestamp), from, to, id, amount);

                    _outboundTransfers[from].add(transferId);
                    _inboundTransfers[to].add(transferId);

                    emit TransferPending(transferId, delay);
                } else {
                    unlockedBalances[to][id] += amount;
                }
            } else {
                unlockedBalances[to][id] += amount;
            }

            super.safeTransferFrom(from, to, id, amount, data);
        }
    }

    // REVERSE

    /// @notice Cancels a pending transfer before its timelock expires. Returns the wrapper
    /// to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from` or any
    /// operator approved via `setApprovalForAll`.
    /// @dev Move uses `_safeTransfer`, which calls `onERC1155Received` on `pt.from` per
    /// ERC1155 spec. Contract depositors must implement `IERC1155Receiver` to be
    /// reverse-eligible — they did not receive the 1155 at deposit (minted to `pt.to`).
    /// EOAs unaffected.
    function reverse(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(block.timestamp < pt.timestamp + (id >> 160), TimelockExpired());
            if (msg.sender != pt.from) {
                require(isApprovedForAll(pt.from, msg.sender), Unauthorized());
            }
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            unlockedBalances[from][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit TransferReversed(transferId);
            _safeTransfer(address(0), to, from, id, amount, "");
        }
    }

    // CLAWBACK

    /// @notice Sender recovery for unsettled transfers (e.g. dead/lost recipient). Returns
    /// the wrapper to `pt.from` and credits their `unlockedBalances`. Callable by `pt.from`
    /// or any operator approved via `setApprovalForAll`.
    /// @dev Available 30 days past timelock expiry. Wrapper-route like `reverse`, so any
    /// subsequent raw exit goes through `withdrawFrom` and inherits guardian gating.
    /// `_safeTransfer` invokes `onERC1155Received` on `pt.from`; contract senders must
    /// implement `IERC1155Receiver`. Only catches transfers still pending — once `unlock`
    /// or `claim` runs, settlement to `pt.to` is final.
    function clawback(uint256 transferId) public nonReentrant {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(
                block.timestamp >= pt.timestamp + (id >> 160) + _CLAWBACK_GRACE, ClawbackNotReady()
            );
            (address from, address to, uint256 amount) = (pt.from, pt.to, pt.amount);
            require(msg.sender == from || isApprovedForAll(from, msg.sender), Unauthorized());

            unlockedBalances[from][id] += amount;
            _outboundTransfers[from].remove(transferId);
            _inboundTransfers[to].remove(transferId);
            delete pendingTransfers[transferId];
            emit TransferClawedBack(transferId);
            _safeTransfer(address(0), to, from, id, amount, "");
        }
    }

    // URI HELPERS

    function _formatDelay(uint256 delay) internal pure returns (string memory) {
        unchecked {
            if (delay >= 86400) {
                uint256 d = delay / 86400;
                return string(abi.encodePacked(d.toString(), d == 1 ? " day" : " days"));
            }
            if (delay >= 3600) {
                uint256 h = delay / 3600;
                return string(abi.encodePacked(h.toString(), h == 1 ? " hour" : " hours"));
            }
            if (delay >= 60) {
                uint256 m = delay / 60;
                return string(abi.encodePacked(m.toString(), m == 1 ? " minute" : " minutes"));
            }
            return string(abi.encodePacked(delay.toString(), delay == 1 ? " second" : " seconds"));
        }
    }

    function _createURI(uint256 id) internal view returns (string memory) {
        (address token, uint256 delay) = decodeId(id);

        string memory tokenName;
        string memory tokenSymbol;
        string memory escSymbol;

        if (token != address(0)) {
            // `readName`/`readSymbol` cap at the byte length we pass and may cut mid-codepoint;
            // `_utf8Trim` keeps the JSON payload valid UTF-8 for strict marketplace parsers.
            tokenName = _utf8Trim(token.readName(64));
            tokenSymbol = _utf8Trim(token.readSymbol(16));
            escSymbol = LibString.escapeJSON(tokenSymbol);
        } else {
            // Literal symbol is JSON-safe; tokenName goes through escapeJSON below as a no-op.
            tokenName = "Ether";
            tokenSymbol = "ETH";
            escSymbol = "ETH";
        }

        string memory delayLabel = _formatDelay(delay);

        bytes memory head = abi.encodePacked(
            '{"name":"SLOW ',
            escSymbol,
            unicode" · ",
            delayLabel,
            '",',
            '"description":"Tokenized representation of a time-locked ',
            LibString.escapeJSON(tokenName),
            " (",
            escSymbol,
            ') transfer.",'
        );
        bytes memory image = abi.encodePacked(
            '"image":"', _createImage(token, delay, delayLabel, tokenName, tokenSymbol), '",'
        );
        bytes memory attrs = abi.encodePacked(
            '"attributes":[',
            '{"trait_type":"Asset","value":"',
            escSymbol,
            '"},{"trait_type":"Token","value":"',
            token.toHexStringChecksummed(),
            '"},{"trait_type":"Delay","value":"',
            delayLabel,
            '"},{"trait_type":"Delay (seconds)","value":',
            delay.toString(),
            ',"display_type":"number"}]}'
        );

        return string(
            abi.encodePacked(
                "data:application/json;base64,", Base64.encode(bytes.concat(head, image, attrs))
            )
        );
    }

    // Trim a trailing partial UTF-8 sequence so byte-bounded reads (`readName` /
    // `readSymbol`) and post-clip slices stay well-formed in the JSON / SVG payloads.
    function _utf8Trim(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        uint256 n = b.length;
        // Walk back over continuation bytes (10xxxxxx).
        while (n != 0 && (uint8(b[n - 1]) & 0xC0) == 0x80) {
            unchecked {
                --n;
            }
        }
        if (n != 0) {
            uint8 lead = uint8(b[n - 1]);
            if (lead >= 0xC0) {
                // Multi-byte sequence start; check if enough continuations followed.
                uint256 expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : 2;
                uint256 actual = b.length - (n - 1);
                if (actual >= expected) {
                    // Sequence is complete; restore the bytes we walked back.
                    n = (n - 1) + expected;
                } else {
                    // Incomplete; drop the lead.
                    unchecked {
                        --n;
                    }
                }
            }
        }
        if (n == b.length) return s;
        bytes memory out = new bytes(n);
        for (uint256 i; i != n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }

    // Clip to `maxBytes` for SVG display with `...` marker. Routes the slice through
    // `_utf8Trim` so a mid-codepoint cut doesn't reach the rendered SVG.
    function _clipForDisplay(string memory s, uint256 maxBytes)
        internal
        pure
        returns (string memory)
    {
        bytes memory b = bytes(s);
        if (b.length <= maxBytes) return s;
        bytes memory clipped = new bytes(maxBytes);
        for (uint256 i; i != maxBytes; ++i) {
            clipped[i] = b[i];
        }
        return string(abi.encodePacked(_utf8Trim(string(clipped)), "..."));
    }

    function _createImage(
        address token,
        uint256 delay,
        string memory delayLabel,
        string memory tokenName,
        string memory tokenSymbol
    ) internal pure returns (string memory) {
        string memory escSymbol = LibString.escapeHTML(tokenSymbol);
        string memory dispName = LibString.escapeHTML(_clipForDisplay(tokenName, 28));

        // Address row is suppressed for ETH (zero address would render as 0x000…000).
        string memory addressRow = token == address(0)
            ? ""
            : string(
                abi.encodePacked(
                    '<text x="150" y="105" font-size="10" textLength="260" lengthAdjust="spacingAndGlyphs">',
                    token.toHexStringChecksummed(),
                    "</text>"
                )
            );
        // Exact-seconds subtitle for delays over one minute, where the main
        // label loses second-level resolution.
        string memory secondsRow = delay > 60
            ? string(
                abi.encodePacked(
                    '<text x="150" y="230" font-size="8" fill="#888">',
                    delay.toString(),
                    " seconds</text>"
                )
            )
            : "";

        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">',
            "<title>SLOW ",
            escSymbol,
            unicode" · ",
            delayLabel,
            "</title>",
            '<rect width="300" height="300"/>',
            '<rect x="1" y="1" width="298" height="298" fill="none" stroke="#fff"/>',
            '<line x1="20" y1="50" x2="280" y2="50" stroke="#fff"/>',
            '<text x="20" y="35" font-family="Helvetica,Arial,sans-serif" font-size="24" fill="#fff">SLOW</text>',
            '<g font-family="monospace" text-anchor="middle" fill="#fff">',
            addressRow,
            '<text x="150" y="165" font-size="12" textLength="260" lengthAdjust="spacingAndGlyphs">',
            dispName,
            " (",
            escSymbol,
            ")</text>"
        );
        bytes memory tail = abi.encodePacked(
            '<text x="150" y="215" font-size="12">', delayLabel, "</text>", secondsRow, "</g></svg>"
        );

        return string(
            abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes.concat(svg, tail)))
        );
    }

    // BATCH (DISABLED)

    function safeBatchTransferFrom(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) public pure override(ERC1155) {
        revert BatchTransferDisabled();
    }
}

interface IHtmlRegistry {
    function setHtmlAsTarget(address target, string calldata html) external;
}

/// @notice `claim`-only operator for keeper-driven settlement. Approve via
/// `setApprovalForAll(slow.gate(), true)`. Cannot redirect funds: the gate has
/// no path to `safeTransferFrom` or `withdrawFrom`, and `claim` pins payout to `pt.to`.
/// Holds optional per-transfer relayer tips posted via `SLOW.depositToWithTip`.
contract SLOWGate {
    using SafeTransferLib for address;

    SLOW public immutable slow = SLOW(msg.sender);

    struct Tip {
        uint96 amount;
        address sender;
    }

    mapping(uint256 transferId => Tip) public tips;

    event TipPosted(
        uint256 indexed transferId, uint96 amount, address indexed sender, address indexed to
    );
    event TipRefunded(uint256 indexed transferId, uint96 amount, address indexed to);
    event TipPaid(uint256 indexed transferId, uint96 amount, address indexed to);

    error TipStillPending();
    error Unauthorized();
    error NoTip();

    constructor() payable {}

    function recordTip(uint256 transferId, address sender, address to) public payable {
        require(msg.sender == address(slow), Unauthorized());
        tips[transferId] = Tip(uint96(msg.value), sender);
        emit TipPosted(transferId, uint96(msg.value), sender, to);
    }

    /// @notice Settle one transfer through the gate. If a tip is attached, pays it
    /// to `msg.sender` and routes through `slow.claimTipped` (no recipient approval
    /// required); otherwise routes through `slow.claim`, which requires `pt.to` to
    /// have approved the gate via `setApprovalForAll`.
    function claim(uint256 transferId) public {
        _claimAndPay(transferId);
    }

    /// @notice Atomic batch settlement; the whole call reverts on the first failure.
    /// Keepers must filter ids off-chain (timelock-expired, no guardian on `pt.to`).
    function claimMany(uint256[] calldata transferIds) public {
        for (uint256 i; i != transferIds.length; ++i) {
            _claimAndPay(transferIds[i]);
        }
    }

    /// @notice Recover an unclaimed tip after the underlying transfer cleared via a
    /// non-gate path (`unlock`, `reverse`, `clawback`, or recipient-direct `claim`).
    /// Callable only by the original depositor; reverts while the transfer is still pending.
    function refundTip(uint256 transferId) public {
        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        require(ts == 0, TipStillPending());
        Tip memory t = tips[transferId];
        require(t.amount != 0, NoTip());
        require(msg.sender == t.sender, Unauthorized());
        delete tips[transferId];
        msg.sender.safeTransferETH(t.amount);
        emit TipRefunded(transferId, t.amount, msg.sender);
    }

    function _claimAndPay(uint256 transferId) internal {
        Tip memory t = tips[transferId];
        if (t.amount != 0) {
            delete tips[transferId];
            slow.claimTipped(transferId);
            msg.sender.safeTransferETH(t.amount);
            emit TipPaid(transferId, t.amount, msg.sender);
        } else {
            slow.claim(transferId);
        }
    }
}
