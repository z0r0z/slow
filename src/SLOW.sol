// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {Base64} from "@solady/src/utils/Base64.sol";
import {ERC1155} from "@solady/src/tokens/ERC1155.sol";
import {LibString} from "@soledge/src/utils/LibString.sol";
import {Multicallable} from "@solady/src/utils/Multicallable.sol";
import {SafeTransferLib} from "@solady/src/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "@soledge/src/utils/ReentrancyGuard.sol";
import {MetadataReaderLib} from "@solady/src/utils/MetadataReaderLib.sol";

/// @notice Timelocked token sends
/// @author z0r0z.eth for nani.eth
/// @dev Tokenized representation
/// of the canonical timelock and
/// guardian for safer execution.
/// @dev Main features:
///      - Deposits and transfers create timelocked balance
///      - Locked balances must be unlocked upon the expiry
///      - Only unlocked balances can be spent in transfer
///      - Guardian approval can also be added to transfer
contract SLOW is ERC1155, Multicallable, ReentrancyGuard {
    using MetadataReaderLib for address;
    using SafeTransferLib for address;
    using LibString for uint256;
    using LibString for string;

    event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
    event TransferApproved(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event TransferPending(uint256 indexed transferId, uint256 indexed delay);
    event GuardianSet(address indexed user, address indexed guardian);

    error GuardianCooldownNotElapsed();
    error GuardianApprovalRequired();
    error TransferDoesNotExist();
    error TimelockNotExpired();
    error TimelockExpired();
    error Unauthorized();

    struct PendingTransfer {
        uint96 timestamp;
        address from;
        address to;
        uint256 id;
        uint256 amount;
    }

    uint256 internal constant _GUARDIAN_COOLDOWN = 1 days; // Default to avoid flash attacks.

    mapping(address user => mapping(uint256 id => uint256)) public unlockedBalances;

    mapping(uint256 transferId => PendingTransfer) public pendingTransfers;

    mapping(address user => uint256 timestamp) public lastGuardianChange;

    mapping(uint256 transferId => bool) public guardianApproved;

    mapping(address user => address) public guardians;

    mapping(address user => uint256) public nonces;

    constructor() payable {}

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

    function predictTransferId(address from, address to, uint256 id, uint256 amount)
        public
        view
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(from, to, id, amount, nonces[from])));
    }

    function decodeId(uint256 id) public pure returns (address token, uint256 delay) {
        (token, delay) = (address(uint160(id)), id >> 160);
    }

    function encodeId(address token, uint256 delay) public pure returns (uint256 id) {
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

            if (block.timestamp > pt.timestamp + (pt.id >> 160)) {
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
            : !guardianApproved[uint256(keccak256(abi.encodePacked(user, to, id, amount, nonces[user])))];
    }

    function canChangeGuardian(address user)
        public
        view
        returns (bool canChange, uint256 cooldownEndsAt)
    {
        unchecked {
            if (lastGuardianChange[user] == 0) return (true, 0);
            cooldownEndsAt = lastGuardianChange[user] + _GUARDIAN_COOLDOWN;
            canChange = block.timestamp >= cooldownEndsAt;
        }
    }

    // GUARDIAN AUTH

    function setGuardian(address guardian) public {
        unchecked {
            // Check if cooldown period has elapsed:
            if (lastGuardianChange[msg.sender] != 0) {
                require(
                    block.timestamp >= lastGuardianChange[msg.sender] + _GUARDIAN_COOLDOWN,
                    GuardianCooldownNotElapsed()
                );
            }

            lastGuardianChange[msg.sender] = block.timestamp;
            emit GuardianSet(msg.sender, guardians[msg.sender] = guardian);
        }
    }

    function approveTransfer(address from, uint256 transferId) public {
        require(msg.sender == guardians[from], Unauthorized());
        guardianApproved[transferId] = true;
        emit TransferApproved(msg.sender, from, transferId);
    }

    // BALANCE MANAGEMENT

    function unlock(uint256 transferId) public {
        unchecked {
            PendingTransfer storage pt = pendingTransfers[transferId];
            require(pt.timestamp != 0, TransferDoesNotExist());
            uint256 id = pt.id;
            require(block.timestamp > pt.timestamp + (id >> 160), TimelockNotExpired());
            (uint256 amount, address to) = (pt.amount, pt.to); // Memoize optimization.
            unlockedBalances[to][id] += amount;
            delete pendingTransfers[transferId];
            emit Unlocked(to, id, amount);
        }
    }

    // DEPOSIT

    function depositTo(address token, address to, uint256 amount, uint96 delay, bytes calldata data)
        public
        payable
        nonReentrant
        returns (uint256 transferId)
    {
        if (msg.value != 0) {
            amount = msg.value;
            delete token;
        } else {
            token.safeTransferFrom(msg.sender, address(this), amount);
        }

        // Token in lower 160 bits, delay in upper 96 bits.
        uint256 id = uint256(uint160(token)) | (uint256(delay) << 160);

        unchecked {
            _mint(to, id, amount, data);

            if (delay != 0) {
                transferId = uint256(
                    keccak256(abi.encodePacked(msg.sender, to, id, amount, nonces[msg.sender]++))
                );

                pendingTransfers[transferId] =
                    PendingTransfer(uint96(block.timestamp), msg.sender, to, id, amount);

                emit TransferPending(transferId, delay);
            } else {
                unlockedBalances[to][id] += amount;
            }
        }
    }

    // WITHDRAW

    function withdrawFrom(address from, address to, uint256 id, uint256 amount)
        public
        nonReentrant
    {
        unlockedBalances[from][id] -= amount;

        unchecked {
            if (guardians[from] != address(0)) {
                require(
                    guardianApproved[uint256(
                        keccak256(abi.encodePacked(from, to, id, amount, nonces[from]++))
                    )],
                    GuardianApprovalRequired()
                );
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

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 amount,
        bytes calldata data
    ) public override(ERC1155) nonReentrant {
        unlockedBalances[from][id] -= amount;

        unchecked {
            uint256 delay = id >> 160;
            address guardian = guardians[from];
            bool requiresDelayOrGuardian = guardian != address(0) || delay != 0;

            if (requiresDelayOrGuardian) {
                uint256 transferId =
                    uint256(keccak256(abi.encodePacked(from, to, id, amount, nonces[from]++)));

                if (guardian != address(0)) {
                    require(guardianApproved[transferId], GuardianApprovalRequired());
                }

                if (delay != 0) {
                    pendingTransfers[transferId] =
                        PendingTransfer(uint96(block.timestamp), from, to, id, amount);
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

    function reverse(uint256 transferId) public {
        PendingTransfer storage pt = pendingTransfers[transferId];

        unchecked {
            require(block.timestamp <= pt.timestamp + (pt.id >> 160), TimelockExpired());
        }

        if (msg.sender != pt.from) require(isApprovedForAll(pt.from, msg.sender), Unauthorized());

        _safeTransfer(address(0), pt.to, pt.from, pt.id, pt.amount, "");

        delete pendingTransfers[transferId];
    }

    // URI HELPERS

    function _createURI(uint256 id) internal view returns (string memory) {
        (address token, uint256 delay) = (address(uint160(id)), id >> 160);

        string memory tokenName;
        string memory tokenSymbol;

        if (token != address(0)) {
            tokenName = token.readName();
            tokenSymbol = token.readSymbol();
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
                            '{"name":"SLOW",',
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
        unchecked {
            // Split the address into two parts for better display:
            string memory addressStr = LibString.toHexStringChecksummed(token);
            string memory addressPart1;
            string memory addressPart2;

            // Split the address at the 22nd character (0x + 20 characters):
            if (bytes(addressStr).length > 22) {
                addressPart1 = addressStr.slice(0, 22);
                addressPart2 = addressStr.slice(22, bytes(addressStr).length - 22);
            } else {
                addressPart1 = addressStr;
            }

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
                                '<text x="20" y="35" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="white">SLOW</text>',
                                // Token address:
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
                                '<text x="150" y="165" font-family="monospace" font-size="12" text-anchor="middle" fill="white">',
                                tokenName,
                                " (",
                                tokenSymbol,
                                ")</text>",
                                // Main human-readable time display (e.g., "2 days" or "3 hours"):
                                '<text x="150" y="215" font-family="monospace" font-size="12" text-anchor="middle" fill="white">',
                                delay >= 86400
                                    ? string(
                                        abi.encodePacked(
                                            (delay / 86400).toString(),
                                            (delay / 86400 == 1) ? " day" : " days"
                                        )
                                    )
                                    : delay >= 3600
                                        ? string(
                                            abi.encodePacked(
                                                (delay / 3600).toString(),
                                                (delay / 3600 == 1) ? " hour" : " hours"
                                            )
                                        )
                                        : delay >= 60
                                            ? string(
                                                abi.encodePacked(
                                                    (delay / 60).toString(),
                                                    (delay / 60 == 1) ? " minute" : " minutes"
                                                )
                                            )
                                            : string(
                                                abi.encodePacked(
                                                    delay.toString(), (delay == 1) ? " second" : " seconds"
                                                )
                                            ),
                                "</text>",
                                // Only add the subtitle with exact seconds if the delay isn't already in seconds:
                                delay > 60
                                    ? string(
                                        abi.encodePacked(
                                            '<text x="150" y="230" font-family="monospace" font-size="8" text-anchor="middle" fill="#888888">',
                                            delay.toString(),
                                            " seconds",
                                            "</text>"
                                        )
                                    )
                                    : "",
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
    }

    // UNAUTHORIZED

    function safeBatchTransferFrom(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) public pure override(ERC1155) {
        revert Unauthorized();
    }
}
