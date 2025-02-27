// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {ERC1155} from "@solady/src/tokens/ERC1155.sol";
import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "@soledge/src/utils/ReentrancyGuard.sol";

/// @title Safe Transfer Protocol
/// @notice Timelocked token sends
/// @author z0r0z.eth for nani.eth
/// @dev Tokenized representation
/// of the canonical timelock and
/// guardian for safer execution.
contract STP is ERC1155, ReentrancyGuard {
    using SafeTransferLib for address;

    event TransferApproved(
        address indexed guardian, address indexed user, bytes32 indexed transferId
    );
    event GuardianSet(address indexed user, address indexed guardian);
    event Transferred(bytes32 indexed transferId);

    error GuardianCooldownNotElapsed();
    error GuardianApprovalRequired();
    error TransferFinalized();
    error Unauthorized();
    error Timelocked();

    struct PendingTransfer {
        address from;
        address to;
        uint256 id;
        uint256 amount;
        uint256 timestamp;
    }

    uint256 internal constant GUARDIAN_COOLDOWN = 1 days; // Default to avoid flash attacks.

    mapping(address user => mapping(uint256 id => uint256 unlockTime)) public unlockTimes;

    mapping(bytes32 transferId => PendingTransfer) public pendingTransfers;

    mapping(address user => uint256 timestamp) public lastGuardianChange;

    mapping(bytes32 transferId => bool) public guardianApproved;

    mapping(address user => address) public guardians;

    mapping(address user => uint256) public nonces;

    constructor() payable {}

    function name() public pure returns (string memory) {
        return "Safe Transfer Protocol";
    }

    function symbol() public pure returns (string memory) {
        return "STP";
    }

    function uri(uint256) public pure override(ERC1155) returns (string memory) {
        return "";
    }

    function setGuardian(address guardian) public {
        unchecked {
            // Check if cooldown period has elapsed.
            if (
                lastGuardianChange[msg.sender] != 0
                    && block.timestamp < lastGuardianChange[msg.sender] + GUARDIAN_COOLDOWN
            ) {
                revert GuardianCooldownNotElapsed();
            }

            // Update guardian and last change timestamp.
            lastGuardianChange[msg.sender] = block.timestamp;
            emit GuardianSet(msg.sender, guardians[msg.sender] = guardian);
        }
    }

    function approveTransfer(address from, bytes32 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        guardianApproved[transferId] = true;
        emit TransferApproved(msg.sender, from, transferId);
    }

    function isTimelocked(address user, uint256 id) public view returns (bool) {
        uint256 unlockTime = unlockTimes[user][id];
        return unlockTime != 0 && block.timestamp < unlockTime;
    }

    function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
        public
        payable
        nonReentrant
    {
        if (msg.value != 0) {
            amount = msg.value;
            delete token;
        } else {
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        // Token in lower 160 bits, delay in upper 96 bits.
        uint256 id = uint256(uint160(token)) | (delay << 160);

        // Set unlock time for these tokens if delay > 0.
        if (delay != 0) {
            unchecked {
                unlockTimes[to][id] = block.timestamp + delay;
            }
        }

        unchecked {
            bytes32 transferId =
                keccak256(abi.encodePacked(msg.sender, to, id, amount, nonces[msg.sender]++));

            _updatePendingTransfer(transferId, msg.sender, to, id, amount, block.timestamp);

            _mint(to, id, amount, data);

            emit Transferred(transferId);
        }
    }

    function withdrawFrom(address from, address to, uint256 id, uint256 amount)
        public
        nonReentrant
    {
        if (isTimelocked(from, id)) revert Timelocked();

        unchecked {
            bytes32 transferId = keccak256(abi.encodePacked(from, to, id, amount, nonces[from]++));

            // Check if a guardian exists and if approval is required.
            if (guardians[from] != address(0) && !guardianApproved[transferId]) {
                revert GuardianApprovalRequired();
            }

            _burn(msg.sender, from, id, amount);

            address token = address(uint160(id));

            if (token == address(0)) {
                to.safeTransferETH(amount);
            } else {
                token.safeTransfer(to, amount);
            }

            emit Transferred(transferId);
        }
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) public override(ERC1155) nonReentrant {
        if (isTimelocked(from, id)) revert Timelocked();

        unchecked {
            bytes32 transferId = keccak256(abi.encodePacked(from, to, id, amount, nonces[from]++));

            // Check if a guardian exists and if approval is required.
            if (guardians[from] != address(0) && !guardianApproved[transferId]) {
                revert GuardianApprovalRequired();
            }

            _updatePendingTransfer(transferId, from, to, id, amount, block.timestamp);

            uint256 delay = id >> 160;

            // Set unlock time for recipient if delay > 0.
            if (delay != 0) unlockTimes[to][id] = block.timestamp + delay;

            super.safeTransferFrom(from, to, id, amount, data);

            emit Transferred(transferId);
        }
    }

    function reverse(bytes32 transferId) public {
        PendingTransfer storage pt = pendingTransfers[transferId];
        uint256 delay = pt.id >> 160;

        unchecked {
            if (block.timestamp > pt.timestamp + delay) revert TransferFinalized();
        }

        if (msg.sender != pt.from) require(isApprovedForAll(pt.from, msg.sender), Unauthorized());

        _safeTransfer(address(0), pt.to, pt.from, pt.id, pt.amount, "");

        delete pendingTransfers[transferId];
    }

    function _updatePendingTransfer(
        bytes32 transferId,
        address from,
        address to,
        uint256 id,
        uint256 amount,
        uint256 timestamp
    ) internal {
        PendingTransfer storage pt = pendingTransfers[transferId];
        pt.from = from;
        pt.to = to;
        pt.id = id;
        unchecked {
            pt.amount += amount;
        }
        pt.timestamp = timestamp;
    }
}
