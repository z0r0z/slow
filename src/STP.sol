// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {Base64} from "@solady/src/utils/Base64.sol";
import {ERC1155} from "@solady/src/tokens/ERC1155.sol";
import {LibString} from "@soledge/src/utils/LibString.sol";
import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "@soledge/src/utils/ReentrancyGuard.sol";
import {MetadataReaderLib} from "@solady/src/utils/MetadataReaderLib.sol";

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

    // METADATA

    function name() public pure returns (string memory) {
        return "Safe Transfer Protocol";
    }

    function symbol() public pure returns (string memory) {
        return "STP";
    }

    function uri(uint256 id) public view override(ERC1155) returns (string memory) {
        return _createURI(id);
    }

    // GUARDIAN AUTH

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

    // TIMELOCK VIEW

    function isTimelocked(address user, uint256 id) public view returns (bool) {
        uint256 unlockTime = unlockTimes[user][id];
        return unlockTime != 0 && block.timestamp < unlockTime;
    }

    // DEPOSIT

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

    // WITHDRAW

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

    // TRANSFER

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

    // REVERSE

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

    // URI HELPERS

    function _createURI(uint256 id) internal view returns (string memory) {
        address token = address(uint160(id));
        uint256 delay = id >> 160;

        string memory tokenName = "???";
        string memory tokenSymbol = "???";

        if (token != address(0)) {
            tokenName = MetadataReaderLib.readName(token);
            tokenSymbol = MetadataReaderLib.readSymbol(token);
        } else {
            tokenName = "Ether";
            tokenSymbol = "ETH";
        }

        return string(
            abi.encodePacked(
                "data:application/json;base64,",
                Base64.encode(
                    bytes(
                        abi.encodePacked(
                            '{"name":"Safe Transfer Protocol",',
                            '"description":"Tokenized representation of a time-locked ',
                            tokenName,
                            " (",
                            tokenSymbol,
                            ') transfer.",',
                            '"image":"',
                            _createImage(token, delay, tokenName, tokenSymbol),
                            '"}'
                        )
                    )
                )
            )
        );
    }

    function _createImage(
        address token,
        uint256 delay,
        string memory tokenName,
        string memory tokenSymbol
    ) internal pure returns (string memory) {
        // Split the address into two parts for better display:
        string memory addressStr = LibString.toHexStringChecksummed(token);
        string memory addressPart1 = "";
        string memory addressPart2 = "";

        // Split the address at the 22nd character (0x + 20 characters):
        if (bytes(addressStr).length > 22) {
            addressPart1 = _substring(addressStr, 0, 22);
            addressPart2 = _substring(addressStr, 22, bytes(addressStr).length - 22);
        } else {
            addressPart1 = addressStr;
        }

        // Trim token name and symbol with ellipsis if too long:
        string memory displayName = _trimWithEllipsis(tokenName, 17); // 17 + 3 for ellipsis = 20 max.
        string memory displaySymbol = _trimWithEllipsis(tokenSymbol, 7); // 7 + 3 for ellipsis = 10 max.

        return string(
            abi.encodePacked(
                "data:image/svg+xml;base64,",
                Base64.encode(
                    bytes(
                        abi.encodePacked(
                            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">',
                            '<rect width="100%" height="100%" fill="black"/>',
                            // Header with underline:
                            '<line x1="20" y1="50" x2="280" y2="50" stroke="white" stroke-width="1"/>',
                            '<text x="20" y="35" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="white">Safe Transfer Protocol</text>',
                            // Token address:
                            '<text x="150" y="85" font-family="Helvetica, Arial, sans-serif" font-size="14" text-anchor="middle" fill="white">Address:</text>',
                            '<text x="150" y="105" font-family="monospace" font-size="10" text-anchor="middle" fill="white">',
                            addressPart1,
                            "</text>",
                            // Second part of address if needed:
                            bytes(addressPart2).length != 0
                                ? string(
                                    abi.encodePacked(
                                        '<text x="150" y="120" font-family="monospace" font-size="10" text-anchor="middle" fill="white">',
                                        addressPart2,
                                        "</text>"
                                    )
                                )
                                : "",
                            // Token name and symbol:
                            '<text x="150" y="145" font-family="Helvetica, Arial, sans-serif" font-size="14" text-anchor="middle" fill="white">Token:</text>',
                            '<text x="150" y="165" font-family="monospace" font-size="12" text-anchor="middle" fill="white">',
                            displayName,
                            " (",
                            displaySymbol,
                            ")</text>",
                            // Delay in seconds:
                            '<text x="150" y="195" font-family="Helvetica, Arial, sans-serif" font-size="14" text-anchor="middle" fill="white">Time Lock:</text>',
                            '<text x="150" y="215" font-family="monospace" font-size="12" text-anchor="middle" fill="white">',
                            LibString.toString(delay),
                            " seconds</text>",
                            // Command symbol in bottom right:
                            '<text x="270" y="280" font-family="monospace" font-size="16" text-anchor="end" fill="white">',
                            unicode"⌘",
                            "</text>",
                            "</svg>"
                        )
                    )
                )
            )
        );
    }

    function _trimWithEllipsis(string memory str, uint256 maxLength)
        internal
        pure
        returns (string memory)
    {
        bytes memory strBytes = bytes(str);
        if (strBytes.length <= maxLength) {
            return str;
        }

        // Allocate space for trimmed string + ellipsis.
        bytes memory result = new bytes(maxLength + 3);

        // Copy first maxLength characters:
        for (uint256 i = 0; i < maxLength; i++) {
            result[i] = strBytes[i];
        }

        // Add ellipsis:
        result[maxLength] = ".";
        result[maxLength + 1] = ".";
        result[maxLength + 2] = ".";

        return string(result);
    }

    function _substring(string memory str, uint256 startIndex, uint256 length)
        internal
        pure
        returns (string memory)
    {
        unchecked {
            bytes memory strBytes = bytes(str);
            bytes memory result = new bytes(length);
            for (uint256 i; i != length; ++i) {
                result[i] = strBytes[i + startIndex];
            }
            return string(result);
        }
    }
}
