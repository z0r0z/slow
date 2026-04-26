// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {Script, console} from "forge-std/Script.sol";
import {SLOW} from "../src/SLOW.sol";

/// @notice Deploys SLOW with the dapp HTML baked in via two SSTORE2 chunks.
/// @dev Splits frontend/index.html in half and passes each half to the constructor.
///      Constructor writes both halves via SSTORE2 and stores the pointers as immutable.
///
/// Usage:
///   forge script script/DeploySLOW.s.sol --rpc-url base --broadcast
contract DeploySLOW is Script {
    function run() external returns (SLOW slow, uint256 chunk1Len, uint256 chunk2Len) {
        bytes memory full = vm.readFileBinary("frontend/index.html");
        require(full.length > 0, "index.html is empty");
        require(full.length <= 24_575 * 2, "exceeds 2 SSTORE2 chunks");

        uint256 mid = full.length / 2 + (full.length & 1); // first half gets odd byte
        bytes memory part1 = _slice(full, 0, mid);
        bytes memory part2 = _slice(full, mid, full.length - mid);

        console.log("Total HTML bytes:", full.length);
        console.log("Chunk 1 bytes:   ", part1.length);
        console.log("Chunk 2 bytes:   ", part2.length);

        vm.startBroadcast();
        slow = new SLOW(part1, part2);
        vm.stopBroadcast();

        chunk1Len = part1.length;
        chunk2Len = part2.length;
        console.log("SLOW deployed at:", address(slow));
        console.log("htmlChunk1 at:   ", slow.htmlChunk1());
        console.log("htmlChunk2 at:   ", slow.htmlChunk2());
    }

    function _slice(bytes memory data, uint256 start, uint256 len)
        internal
        pure
        returns (bytes memory result)
    {
        result = new bytes(len);
        assembly ("memory-safe") {
            let src := add(add(data, 0x20), start)
            let dst := add(result, 0x20)
            mcopy(dst, src, len)
        }
    }
}
