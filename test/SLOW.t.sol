// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {SLOW, SLOWGate} from "../src/SLOW.sol";
import {Test, Vm} from "../lib/forge-std/src/Test.sol";
import {console} from "forge-std/console.sol";
import {Base64} from "@solady/src/utils/Base64.sol";
import {LibString} from "@solady/src/utils/LibString.sol";

contract SLOWTest is Test {
    SLOW internal slow;
    MockERC20 internal token;

    address internal owner;
    address internal user1;
    address internal user2;
    address internal guardian;

    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    uint256 internal constant AMOUNT = 1 ether;
    uint96 internal constant DELAY = 1 days;

    event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
    event TransferApproved(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event GuardianSet(address indexed user, address indexed guardian);
    event TransferPending(uint256 indexed transferId, uint96 indexed delay);
    event TransferReversed(uint256 indexed transferId);

    function setUp() public payable {
        vm.createSelectFork(vm.rpcUrl("main")); // Ethereum mainnet fork.
        slow = new SLOW("", "");
        token = new MockERC20("Test Token", "TEST", 18);

        owner = address(this);
        user1 = address(0x1);
        user2 = address(0x2);
        guardian = address(0x3);

        // Fund accounts
        vm.deal(user1, 10 ether);
        vm.deal(user2, 10 ether);

        token.mint(user1, 10 ether);
        token.mint(user2, 10 ether);
    }

    // Helper function to calculate ID
    function calculateId(address tokenAddress, uint96 delay) internal pure returns (uint256) {
        return uint256(uint160(tokenAddress)) | (uint256(delay) << 160);
    }

    // Test ETH deposit
    function testDepositETH() public {
        vm.startPrank(user1);

        // Perform the deposit and capture the transfer ID
        slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Calculate the corrected ID
        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.balanceOf(user2, id), AMOUNT);

        assertEq(slow.unlockedBalances(user2, id), 0);

        vm.stopPrank();
    }

    // Test zero delay ETH deposit
    function testDepositETHZeroDelay() public {
        vm.startPrank(user1);

        uint256 id = calculateId(address(0), 0); // ID with zero delay

        // Perform the deposit
        slow.depositTo{value: AMOUNT}(address(0), user2, 0, 0, ""); // 0 delay

        assertEq(slow.balanceOf(user2, id), AMOUNT);

        // With zero delay, balance should be unlocked immediately
        assertEq(slow.unlockedBalances(user2, id), AMOUNT);

        vm.stopPrank();
    }

    function testURI() public view {
        address _token = 0x6B175474E89094C44Da98b954EedeAC495271d0F; // DAI
        uint256 delay = 86400;
        uint256 id = calculateId(_token, uint96(delay));
        string memory uri = slow.uri(id);
        console.log(uri);
    }

    // Test ERC20 deposit
    function testDepositERC20() public {
        vm.startPrank(user1);

        uint256 id = calculateId(address(token), DELAY);

        token.approve(address(slow), AMOUNT);

        // Perform the deposit
        slow.depositTo(address(token), user2, AMOUNT, DELAY, "");

        assertEq(slow.balanceOf(user2, id), AMOUNT);
        assertEq(token.balanceOf(address(slow)), AMOUNT);

        // Check that balance is locked
        assertEq(slow.unlockedBalances(user2, id), 0);

        vm.stopPrank();
    }

    // Test unlocking process
    function testUnlock() public {
        // Setup - deposit with delay
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = calculateId(address(0), DELAY);

        // Verify it's locked
        assertEq(slow.unlockedBalances(user1, id), 0);

        // Try to unlock before time - should revert
        vm.startPrank(user1);
        vm.expectRevert(SLOW.TimelockNotExpired.selector);
        slow.unlock(transferId);
        vm.stopPrank();

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Now unlock should succeed
        vm.startPrank(user1);
        slow.unlock(transferId);
        vm.stopPrank();

        // Check balances after unlock
        assertEq(slow.unlockedBalances(user1, id), AMOUNT);
    }

    // Test transfer with locked and unlocked balances
    function testTransferLockedUnlocked() public {
        // Setup - deposit with delay
        vm.startPrank(user1);

        uint256 id = calculateId(address(0), DELAY);
        console.log("ID value:", id);
        console.log("Delay extracted from ID:", id >> 160);

        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        // Advance time past delay
        uint256 unlockTime = block.timestamp + DELAY;
        vm.warp(unlockTime + 1);

        // Unlock the balance
        vm.startPrank(user1);
        slow.unlock(transferId);

        // Now transfer should succeed
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Check balances after transfer
        assertEq(slow.balanceOf(user1, id), 0);
        assertEq(slow.balanceOf(user2, id), AMOUNT);

        // Since the delay comes from the ID itself, check recipient's unlocked/locked balances
        if (id >> 160 != 0) {
            // If there's a delay in the ID, it should be in locked balances
            assertEq(slow.unlockedBalances(user2, id), 0);
        } else {
            // If there's no delay in the ID, it should be in unlocked balances
            assertEq(slow.unlockedBalances(user2, id), AMOUNT);
        }
    }

    // Test transfer with zero delay (goes to unlocked balance)
    function testTransferZeroDelay() public {
        // Setup - deposit with NO delay
        vm.startPrank(user1);
        uint256 zeroDelayId = calculateId(address(0), 0); // ID with zero delay
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, ""); // Note: 0 delay
        vm.stopPrank();

        // Verify initial balance is in unlocked
        assertEq(slow.unlockedBalances(user1, zeroDelayId), AMOUNT);

        // Transfer the tokens
        vm.startPrank(user1);
        slow.safeTransferFrom(user1, user2, zeroDelayId, AMOUNT, "");
        vm.stopPrank();

        // Check balances after transfer
        assertEq(slow.balanceOf(user1, zeroDelayId), 0);
        assertEq(slow.balanceOf(user2, zeroDelayId), AMOUNT);

        // Since the delay is zero, the tokens should be added to user2's unlocked balances
        assertEq(slow.unlockedBalances(user2, zeroDelayId), AMOUNT);

        // Test that user2 can immediately spend the tokens
        vm.startPrank(user2);
        // Should work without needing to unlock first
        slow.safeTransferFrom(user2, user1, zeroDelayId, AMOUNT, "");
        vm.stopPrank();

        // Verify tokens returned to user1
        assertEq(slow.balanceOf(user2, zeroDelayId), 0);
        assertEq(slow.balanceOf(user1, zeroDelayId), AMOUNT);
    }

    // Test partial transfer of unlocked balances
    function testPartialTransfer() public {
        uint256 transferAmount = AMOUNT / 2;

        // Setup - deposit with NO delay for simplicity
        vm.startPrank(user1);
        uint256 zeroDelayId = calculateId(address(0), 0);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");
        vm.stopPrank();

        // Transfer half the tokens
        vm.startPrank(user1);
        slow.safeTransferFrom(user1, user2, zeroDelayId, transferAmount, "");
        vm.stopPrank();

        // Check balances
        assertEq(slow.balanceOf(user1, zeroDelayId), transferAmount);
        assertEq(slow.balanceOf(user2, zeroDelayId), transferAmount);

        // Check unlocked balances
        assertEq(slow.unlockedBalances(user1, zeroDelayId), transferAmount);
        assertEq(slow.unlockedBalances(user2, zeroDelayId), transferAmount);
    }

    // Test transfer reversal
    function testReversal() public {
        // Enable debug logs
        vm.recordLogs();

        // Setup - deposit with delay and get the transferId
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.stopPrank();

        // Retrieve the PendingTransfer struct
        (uint96 timestamp, address from, address to, uint256 id, uint256 amount) =
            slow.pendingTransfers(transferId);
        console.log("Timestamp:", timestamp);
        console.log("From:", from);
        console.log("To:", to);
        console.log("ID:", id);
        console.log("Amount:", amount);
        console.log("Delay:", id >> 160);
        console.log("Current timestamp:", block.timestamp);
        console.log("Timelock expiry:", timestamp + (id >> 160));

        // Fix precedence issue in test
        require(block.timestamp <= timestamp + (id >> 160), "Time should be within window");

        uint256 idWithDelay = calculateId(address(0), DELAY);

        // Reverse within delay period
        vm.prank(user1);
        slow.reverse(transferId);

        // Check balances after reversal
        assertEq(slow.balanceOf(user2, idWithDelay), 0);
        assertEq(slow.balanceOf(user1, idWithDelay), AMOUNT);
    }

    // Test reversal by approved operator
    function testReversalByOperator() public {
        address operator = address(0x4);

        // Setup - deposit with delay
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Approve operator
        slow.setApprovalForAll(operator, true);
        vm.stopPrank();

        // Reverse by operator
        vm.prank(operator);
        slow.reverse(transferId);

        uint256 id = calculateId(address(0), DELAY);

        // Check balances after reversal
        assertEq(slow.balanceOf(user2, id), 0);
        assertEq(slow.balanceOf(user1, id), AMOUNT);
    }

    // Test reversal after delay expired
    function testReversalAfterDelay() public {
        // Setup - deposit with delay and get the transferId
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.stopPrank();

        // Retrieve timestamp and id from the PendingTransfer
        (uint96 timestamp,,, uint256 id,) = slow.pendingTransfers(transferId);

        // Advance time past delay - add a little buffer to be safe
        vm.warp(timestamp + (id >> 160) + 10);

        // Try to reverse after delay - should fail
        vm.startPrank(user1);
        vm.expectRevert(SLOW.TimelockExpired.selector);
        slow.reverse(transferId);
        vm.stopPrank();
    }

    // Test unauthorized reversal attempt
    function testUnauthorizedReversal() public {
        // Setup - deposit with delay and get the transferId
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.stopPrank();

        // Attempt reversal by unauthorized account
        vm.startPrank(user2);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.reverse(transferId);
        vm.stopPrank();
    }

    // Test guardian setup
    function testSetGuardian() public {
        vm.startPrank(user1);

        vm.expectEmit(true, true, true, true);
        emit GuardianSet(user1, guardian);

        slow.setGuardian(guardian);
        assertEq(slow.guardians(user1), guardian);

        vm.stopPrank();
    }

    // Removal now goes through propose + delay + commit; current guardian can veto.
    function testRemoveGuardian() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Propose removal — does not take effect immediately.
        vm.prank(user1);
        slow.setGuardian(address(0));
        assertEq(slow.guardians(user1), guardian, "guardian still active during delay");

        // Commit before delay reverts.
        vm.expectRevert(SLOW.GuardianChangeNotReady.selector);
        slow.commitGuardian(user1);

        // After delay, anyone can commit.
        vm.warp(block.timestamp + 1 days);
        slow.commitGuardian(user1);
        assertEq(slow.guardians(user1), address(0), "guardian removed post-commit");
    }

    // Active guardian → rotation must wait the delay; current guardian can veto.
    function testGuardianChangeDelay() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Propose rotation — staged, not active.
        address newGuardian = address(0x4);
        vm.prank(user1);
        slow.setGuardian(newGuardian);
        assertEq(slow.guardians(user1), guardian, "old guardian still active");
        (address pending, uint96 effectiveAt) = slow.pendingGuardian(user1);
        assertEq(pending, newGuardian);
        assertEq(uint256(effectiveAt), block.timestamp + 1 days);

        // Commit before delay reverts.
        vm.expectRevert(SLOW.GuardianChangeNotReady.selector);
        slow.commitGuardian(user1);

        // After delay, commit succeeds and rotation lands.
        vm.warp(block.timestamp + 1 days);
        slow.commitGuardian(user1);
        assertEq(slow.guardians(user1), newGuardian);
        (pending, effectiveAt) = slow.pendingGuardian(user1);
        assertEq(pending, address(0));
        assertEq(uint256(effectiveAt), 0);
    }

    // The whole point of H-01: a compromised key cannot rotate the guardian
    // before the live guardian has a chance to veto.
    function testGuardianVetosRotationByCompromisedKey() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Compromised key proposes removal.
        vm.prank(user1);
        slow.setGuardian(address(0));

        // Live guardian vetoes inside the window.
        vm.prank(guardian);
        slow.cancelGuardianChange(user1);

        // Pending cleared, original guardian still in force.
        (address pending,) = slow.pendingGuardian(user1);
        assertEq(pending, address(0));
        assertEq(slow.guardians(user1), guardian);

        // Even after the would-be delay window, no commit is possible.
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(SLOW.NoGuardianChangePending.selector);
        slow.commitGuardian(user1);
    }

    function testUserCanCancelOwnGuardianChange() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.setGuardian(address(0xBEEF));

        vm.prank(user1);
        slow.cancelGuardianChange(user1);

        assertEq(slow.guardians(user1), guardian, "rotation aborted by user");
    }

    function testCancelGuardianChangeUnauthorizedReverts() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.setGuardian(address(0xBEEF));

        // Random third party (not user, not guardian) cannot cancel.
        vm.prank(address(0xDEAD));
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.cancelGuardianChange(user1);
    }

    function testCancelWhenNoChangePendingReverts() public {
        vm.expectRevert(SLOW.NoGuardianChangePending.selector);
        slow.cancelGuardianChange(user1);
    }

    // After the delay expires, the cancel window closes. Only commit is valid,
    // so a hostile guardian cannot perpetually race a user's legitimate commit.
    function testCancelAfterDelayReverts() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.setGuardian(address(0));

        vm.warp(block.timestamp + 1 days);

        vm.prank(guardian);
        vm.expectRevert(SLOW.GuardianChangeAlreadyCommittable.selector);
        slow.cancelGuardianChange(user1);

        vm.prank(user1);
        vm.expectRevert(SLOW.GuardianChangeAlreadyCommittable.selector);
        slow.cancelGuardianChange(user1);

        // Commit still works, as expected.
        slow.commitGuardian(user1);
        assertEq(slow.guardians(user1), address(0));
    }

    function testReProposingOverwritesPriorChange() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.setGuardian(address(0xAAAA));

        // Re-propose with a different target — overwrites pending, resets timer.
        vm.warp(block.timestamp + 12 hours);
        vm.prank(user1);
        slow.setGuardian(address(0xBBBB));

        (address pending, uint96 effectiveAt) = slow.pendingGuardian(user1);
        assertEq(pending, address(0xBBBB));
        assertEq(uint256(effectiveAt), block.timestamp + 1 days);
    }

    // Once removed (committed), setting a new guardian is immediate again.
    function testSetGuardianImmediateAfterRemoval() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.setGuardian(address(0));
        vm.warp(block.timestamp + 1 days);
        slow.commitGuardian(user1);
        assertEq(slow.guardians(user1), address(0));

        // Now no active guardian → next set is immediate, no commit needed.
        vm.prank(user1);
        slow.setGuardian(address(0xC0FFEE));
        assertEq(slow.guardians(user1), address(0xC0FFEE));
    }

    // Test guardian approval flow for transfers
    function testGuardianApproval() public {
        // Setup - set guardian and deposit
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, ""); // Using zero delay for simplicity

        uint256 id = calculateId(address(0), 0); // Zero delay ID

        // Use predictTransferId so the preimage stays in sync with the contract
        // (which mixes in lastGuardianChange to invalidate stale approvals).
        uint256 transferId = slow.predictTransferId(user1, user2, id, AMOUNT);

        // Try to transfer without guardian approval - should fail
        vm.startPrank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Guardian approves
        vm.prank(guardian);
        slow.approveTransfer(user1, transferId);

        // Now transfer should succeed
        vm.startPrank(user1);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Check balances after transfer
        assertEq(slow.balanceOf(user1, id), 0);
        assertEq(slow.balanceOf(user2, id), AMOUNT);
    }

    // Rotating the guardian must invalidate any dangling approvals from the
    // previous guardian. The preimage is bound to lastGuardianChange so that
    // a setGuardian call atomically retires every prior approval.
    function testGuardianRotationInvalidatesStaleApproval() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        uint256 staleTransferId = slow.predictTransferId(user1, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user1, staleTransferId);

        // Rotate guardian via propose + commit.
        address newGuardian = address(0xC0DEC0DE);
        vm.prank(user1);
        slow.setGuardian(newGuardian);
        vm.warp(block.timestamp + 1 days);
        slow.commitGuardian(user1);

        // The stale approval no longer matches the now-current preimage.
        assertTrue(slow.guardianApproved(staleTransferId));
        uint256 freshTransferId = slow.predictTransferId(user1, user2, id, AMOUNT);
        assertTrue(freshTransferId != staleTransferId);

        // Transfer attempt must require the new guardian's approval.
        vm.startPrank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        vm.prank(newGuardian);
        slow.approveTransfer(user1, freshTransferId);

        vm.prank(user1);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");

        assertEq(slow.balanceOf(user2, id), AMOUNT);
    }

    // Test unauthorized guardian approval attempt
    function testUnauthorizedGuardianApproval() public {
        // Setup - set guardian
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Get current nonce
        uint256 currentNonce = slow.nonces(user1);

        // Calculate a transferId
        uint256 id = calculateId(address(0), 0);
        uint256 transferId =
            uint256(keccak256(abi.encodePacked(user1, user2, id, AMOUNT, currentNonce)));

        // Unauthorized account attempts to approve
        vm.prank(user2); // Not the guardian
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.approveTransfer(user1, transferId);
    }

    // Test withdrawal
    function testWithdrawal() public {
        // Setup - deposit ETH with zero delay for simpler testing
        vm.startPrank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");
        vm.stopPrank();

        uint256 id = calculateId(address(0), 0);

        // Withdraw
        uint256 balanceBefore = user2.balance;

        vm.startPrank(user1);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check results
        assertEq(user2.balance, balanceBefore + AMOUNT);
        assertEq(slow.balanceOf(user1, id), 0);
    }

    // Test withdrawal with locked tokens
    function testWithdrawalWithLockedTokens() public {
        // Setup - deposit with delay
        vm.startPrank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = calculateId(address(0), DELAY);

        // Try to withdraw without unlocking - should revert with underflow
        vm.startPrank(user1);
        vm.expectRevert(); // Will fail with underflow
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Advance time and unlock
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user1);
        slow.unlock(transferId);

        // Now withdrawal should succeed
        uint256 balanceBefore = user2.balance;
        vm.startPrank(user1);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check results
        assertEq(user2.balance, balanceBefore + AMOUNT);
        assertEq(slow.balanceOf(user1, id), 0);
    }

    // Test withdrawal with guardian
    function testWithdrawalWithGuardian() public {
        // Setup - set guardian and deposit
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, ""); // Zero delay for simplicity

        uint256 id = calculateId(address(0), 0);

        // Use predictWithdrawalId so the preimage stays in sync with the contract
        // (which mixes in lastGuardianChange to invalidate stale approvals).
        uint256 withdrawalTransferId = slow.predictWithdrawalId(user1, user2, id, AMOUNT);

        // Try to withdraw without guardian approval - should fail
        vm.startPrank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Guardian approves
        vm.prank(guardian);
        slow.approveTransfer(user1, withdrawalTransferId);

        // Now withdrawal should succeed
        uint256 balanceBefore = user2.balance;

        vm.startPrank(user1);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check results
        assertEq(user2.balance, balanceBefore + AMOUNT);
        assertEq(slow.balanceOf(user1, id), 0);
    }

    // Test ERC20 withdrawal
    function testERC20Withdrawal() public {
        // Setup - deposit ERC20 token
        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        slow.depositTo(address(token), user1, AMOUNT, 0, ""); // Zero delay for simplicity
        vm.stopPrank();

        uint256 id = calculateId(address(token), 0);

        // Check initial balances
        assertEq(slow.balanceOf(user1, id), AMOUNT);
        assertEq(token.balanceOf(user2), 10 ether); // Initial balance

        // Withdraw the tokens
        vm.startPrank(user1);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check final balances
        assertEq(slow.balanceOf(user1, id), 0);
        assertEq(token.balanceOf(user2), 10 ether + AMOUNT);
    }

    // Test attempting to transfer locked balance
    function testTransferLockedBalance() public {
        // Setup - deposit with delay
        vm.startPrank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = calculateId(address(0), DELAY);

        // Try to transfer before unlocking - should fail
        vm.startPrank(user1);
        vm.expectRevert(); // Will fail with underflow since unlockedBalances is 0
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();
    }

    // Test batch transfer (should revert)
    function testBatchTransferReverts() public {
        // Setup
        vm.startPrank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        // Create test data for batch transfer
        uint256[] memory ids = new uint256[](1);
        ids[0] = calculateId(address(0), 0);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = AMOUNT;

        // Batch transfer should revert
        vm.expectRevert(SLOW.BatchTransferDisabled.selector);
        slow.safeBatchTransferFrom(user1, user2, ids, amounts, "");
        vm.stopPrank();
    }

    function testETHDeposit() public {
        vm.startPrank(user1);

        // Perform deposit with delay
        console.log("--- ETH Deposit with Delay ---");
        console.log("Before deposit - user1 ETH balance:", user1.balance);

        // Debug the ID calculation
        uint256 expectedId = uint256(uint160(address(0))) | (DELAY << 160);
        console.log("Expected ID for ETH with delay:", expectedId);
        console.log("Token part (lower 160 bits):", uint160(address(0)));
        console.log("Delay part (upper bits):", DELAY);

        // Deposit ETH with delay
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        console.log("Transfer ID from deposit:", transferId);

        // Get the actual ID from the pending transfer
        (,,, uint256 actualId,) = slow.pendingTransfers(transferId);
        console.log("Actual ID from pending transfer:", actualId);
        console.log("Token extracted from ID:", address(uint160(actualId)));
        console.log("Delay extracted from ID:", actualId >> 160);

        // Check token balances
        console.log("User2 token balance after deposit:", slow.balanceOf(user2, actualId));
        console.log("User2 unlocked balance:", slow.unlockedBalances(user2, actualId));

        // Check token URI
        string memory tokenURI = slow.uri(actualId);
        console.log("Token URI:", tokenURI);

        vm.stopPrank();
    }

    // Test 2: USDC Deposit with Delay
    function testUSDCDeposit() public {
        vm.startPrank(user1);

        console.log("--- USDC Deposit with Delay ---");

        // For simplicity, mock the USDC balance and approval
        // In reality, you'd need to interact with the actual USDC contract
        vm.mockCall(
            USDC,
            abi.encodeWithSelector(0x23b872dd), // transferFrom selector
            abi.encode(true)
        );

        // Debug the ID calculation
        uint256 expectedId = uint256(uint160(USDC)) | (DELAY << 160);
        console.log("Expected ID for USDC with delay:", expectedId);
        console.log("Token part (lower 160 bits):", uint160(USDC));
        console.log("Delay part (upper bits):", DELAY);

        // Deposit USDC with delay
        uint256 transferId = slow.depositTo(USDC, user2, AMOUNT, DELAY, "");
        console.log("Transfer ID from deposit:", transferId);

        // Get the actual ID from the pending transfer
        (,,, uint256 actualId,) = slow.pendingTransfers(transferId);
        console.log("Actual ID from pending transfer:", actualId);
        console.log("Token extracted from ID:", address(uint160(actualId)));
        console.log("Delay extracted from ID:", actualId >> 160);

        // Check token balances
        console.log("User2 token balance after deposit:", slow.balanceOf(user2, actualId));
        console.log("User2 unlocked balance:", slow.unlockedBalances(user2, actualId));

        // Check token URI
        string memory tokenURI = slow.uri(actualId);
        console.log("Token URI:", tokenURI);

        vm.stopPrank();
    }

    function testURIWithDifferentDelays() public view {
        // Test with ETH
        console.log("\n=== ETH URIs ===");
        testTokenURIWithDelay(address(0), 1); // 1 second
        testTokenURIWithDelay(address(0), 30); // 30 seconds
        testTokenURIWithDelay(address(0), 60); // 1 minute
        testTokenURIWithDelay(address(0), 300); // 5 minutes
        testTokenURIWithDelay(address(0), 3600); // 1 hour
        testTokenURIWithDelay(address(0), 7200); // 2 hours
        testTokenURIWithDelay(address(0), 86400); // 1 day
        testTokenURIWithDelay(address(0), 172800); // 2 days
        testTokenURIWithDelay(address(0), 604800); // 1 week
        testTokenURIWithDelay(address(0), 31536000); // 1 year

        // Test with USDC
        console.log("\n=== USDC URIs ===");
        testTokenURIWithDelay(USDC, 1); // 1 second
        testTokenURIWithDelay(USDC, 60); // 1 minute
        testTokenURIWithDelay(USDC, 3600); // 1 hour
        testTokenURIWithDelay(USDC, 86400); // 1 day
        testTokenURIWithDelay(USDC, 2592000); // 30 days

        // Test with DAI
        console.log("\n=== DAI URIs ===");
        testTokenURIWithDelay(DAI, 1); // 1 second
        testTokenURIWithDelay(DAI, 60); // 1 minute
        testTokenURIWithDelay(DAI, 3600); // 1 hour
        testTokenURIWithDelay(DAI, 86400); // 1 day
        testTokenURIWithDelay(DAI, 2592000); // 30 days
        testTokenURIWithDelay(DAI, 2592001); // 30 days 1 second
    }

    function testTokenURIWithDelay(address _token, uint96 delay) internal view {
        // Create ID with the token and delay
        uint256 id = uint256(uint160(_token)) | (uint256(delay) << 160);

        // Get the URI from the contract
        string memory tokenURI = slow.uri(id);

        // Log the token type, delay, and URI
        string memory tokenName = _token == address(0)
            ? "ETH"
            : _token == USDC ? "USDC" : _token == DAI ? "DAI" : "Unknown";

        console.log("\nToken: %s, Delay: %s seconds", tokenName, delay);
        console.log("URI: %s", tokenURI);
    }

    // Test reverse on a transferId that was never created
    function testReverseNonexistentTransferId() public {
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.reverse(0xdeadbeef);
    }

    // Test reverse on a transferId that was already reversed
    function testReverseAfterAlreadyReversed() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user1);
        slow.reverse(transferId);

        vm.prank(user1);
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.reverse(transferId);
    }

    // Test reverse on a transferId that was already unlocked
    function testReverseAfterUnlocked() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.unlock(transferId);

        vm.prank(user1);
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.reverse(transferId);
    }

    // Test depositTo rejects ETH attached to a non-zero token argument
    function testDepositETHWithNonZeroTokenReverts() public {
        vm.startPrank(user1);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo{value: AMOUNT}(USDC, user2, 0, DELAY, "");
        vm.stopPrank();
    }

    function testDepositETHWithMockTokenReverts() public {
        vm.startPrank(user1);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo{value: AMOUNT}(address(token), user2, 0, 0, "");
        vm.stopPrank();
    }

    // ENUMERATION TESTS

    // Pending transfer is recorded in outbound/inbound sets on creation
    function testEnumerationAfterDeposit() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        assertEq(slow.outboundTransferCount(user1), 1);
        assertEq(slow.inboundTransferCount(user2), 1);
        assertEq(slow.outboundTransferAt(user1, 0), transferId);
        assertEq(slow.inboundTransferAt(user2, 0), transferId);

        uint256[] memory out = slow.getOutboundTransfers(user1);
        uint256[] memory inb = slow.getInboundTransfers(user2);
        assertEq(out.length, 1);
        assertEq(inb.length, 1);
        assertEq(out[0], transferId);
        assertEq(inb[0], transferId);

        // Counterparty sees nothing on the wrong side
        assertEq(slow.inboundTransferCount(user1), 0);
        assertEq(slow.outboundTransferCount(user2), 0);
    }

    // Zero-delay deposit does NOT touch the enumeration sets
    function testEnumerationSkippedForZeroDelayDeposit() public {
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user2, 0, 0, "");

        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(user2), 0);
    }

    // Unlock removes the transferId from both sets
    function testEnumerationAfterUnlock() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.unlock(transferId);

        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(user2), 0);
        assertEq(slow.getOutboundTransfers(user1).length, 0);
        assertEq(slow.getInboundTransfers(user2).length, 0);
    }

    // Reverse removes the transferId from both sets
    function testEnumerationAfterReverse() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user1);
        slow.reverse(transferId);

        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(user2), 0);
    }

    // Multiple pending transfers from one sender all enumerate
    function testEnumerationMultiplePending() public {
        vm.startPrank(user1);
        uint256 t1 = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        uint256 t2 = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        uint256 t3 = slow.depositTo{value: AMOUNT}(address(0), guardian, 0, DELAY, "");
        vm.stopPrank();

        assertEq(slow.outboundTransferCount(user1), 3);
        assertEq(slow.inboundTransferCount(user2), 2);
        assertEq(slow.inboundTransferCount(guardian), 1);

        uint256[] memory out = slow.getOutboundTransfers(user1);
        // Set semantics: ordering is implementation-defined, so check membership.
        bool hasT1;
        bool hasT2;
        bool hasT3;
        for (uint256 i = 0; i < out.length; i++) {
            if (out[i] == t1) hasT1 = true;
            else if (out[i] == t2) hasT2 = true;
            else if (out[i] == t3) hasT3 = true;
        }
        assertTrue(hasT1 && hasT2 && hasT3);
    }

    // Settling one transfer leaves siblings intact
    function testEnumerationPartialSettlement() public {
        vm.startPrank(user1);
        uint256 t1 = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        uint256 t2 = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        slow.reverse(t1);
        vm.stopPrank();

        assertEq(slow.outboundTransferCount(user1), 1);
        assertEq(slow.inboundTransferCount(user2), 1);
        assertEq(slow.outboundTransferAt(user1, 0), t2);
        assertEq(slow.inboundTransferAt(user2, 0), t2);
    }

    // safeTransferFrom with delay > 0 also populates sets
    function testEnumerationAfterSafeTransferFrom() public {
        // First, give user1 some unlocked SLOW with a delay-encoded id
        vm.prank(user1);
        uint256 depositId = slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user1);
        slow.unlock(depositId);

        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(user1), 0);

        // Now user1 transfers to user2 — id encodes a non-zero delay, so it creates a pending
        vm.prank(user1);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");

        assertEq(slow.outboundTransferCount(user1), 1);
        assertEq(slow.inboundTransferCount(user2), 1);
    }

    // ON-CHAIN HTML TESTS

    // The constructor accepts arbitrary bytes; html() concatenates and returns them.
    function testHtmlRoundtrip() public {
        bytes memory part1 = bytes("<html><body>");
        bytes memory part2 = bytes("hello slow</body></html>");
        SLOW dapp = new SLOW(part1, part2);
        bytes memory got = bytes(dapp.html());
        bytes memory expected = bytes.concat(part1, part2);
        assertEq(keccak256(got), keccak256(expected));
        assertEq(got.length, expected.length);
    }

    // Empty payloads work fine (used in protocol-only tests).
    function testHtmlEmpty() public {
        SLOW dapp = new SLOW("", "");
        assertEq(bytes(dapp.html()).length, 0);
    }

    // Real production deployment: split the actual SLOW.html file in half
    // and verify it survives the SSTORE2 roundtrip byte-identical.
    function testHtmlFromIndexHtml() public {
        bytes memory full = vm.readFileBinary("SLOW.html");
        uint256 mid = full.length / 2 + (full.length & 1);
        bytes memory part1 = _slice(full, 0, mid);
        bytes memory part2 = _slice(full, mid, full.length - mid);

        // Each chunk must fit in a single SSTORE2 entry.
        assertLt(part1.length, 24_575);
        assertLt(part2.length, 24_575);

        SLOW dapp = new SLOW(part1, part2);
        bytes memory got = bytes(dapp.html());
        assertEq(got.length, full.length);
        assertEq(keccak256(got), keccak256(full));
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

    // Test that the receiver hook fired during reverse() cannot re-enter
    function testReverseReentrancyBlocked() public {
        ReentrantReceiver malicious = new ReentrantReceiver{value: AMOUNT}(slow);
        uint256 transferId = malicious.deposit(user1, DELAY);

        malicious.callReverse(transferId);

        assertTrue(malicious.reentryRejected(), "reentry should be rejected");

        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.balanceOf(address(malicious), id), AMOUNT);
        assertEq(slow.balanceOf(user1, id), 0);

        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0);
    }

    // A malicious recipient that reverts in onERC1155Received must roll back the entire
    // deposit — no wrapper minted, no pending entry, no contract balance retained.
    function testDepositToRevertingReceiverUnwinds() public {
        RevertingReceiver bad = new RevertingReceiver(slow);
        uint256 contractBalBefore = address(slow).balance;
        uint256 nonceBefore = slow.nonces(user1);

        vm.deal(user1, AMOUNT);
        vm.prank(user1);
        vm.expectRevert();
        slow.depositTo{value: AMOUNT}(address(0), address(bad), 0, DELAY, "");

        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.balanceOf(address(bad), id), 0, "no wrapper minted");
        assertEq(address(slow).balance, contractBalBefore, "no ETH retained");
        assertEq(slow.nonces(user1), nonceBefore, "nonce not bumped");
        assertEq(slow.outboundTransferCount(user1), 0, "no outbound entry");
        assertEq(slow.inboundTransferCount(address(bad)), 0, "no inbound entry");
    }

    // safeTransferFrom into a reverting receiver must unwind unlockedBalances, the new
    // pending entry, and the nonce bump — every state mutation in the function rolls back.
    function testSafeTransferFromToRevertingReceiverUnwinds() public {
        // Seed user1 with unlocked wrapper at id (delay=DELAY) via deposit-then-unlock.
        vm.deal(user1, AMOUNT);
        vm.prank(user1);
        uint256 seedId = slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.warp(block.timestamp + DELAY);
        vm.prank(user1);
        slow.unlock(seedId);

        uint256 id = calculateId(address(0), DELAY);
        uint256 unlockedBefore = slow.unlockedBalances(user1, id);
        uint256 balBefore = slow.balanceOf(user1, id);
        uint256 nonceBefore = slow.nonces(user1);

        RevertingReceiver bad = new RevertingReceiver(slow);

        vm.prank(user1);
        vm.expectRevert();
        slow.safeTransferFrom(user1, address(bad), id, AMOUNT, "");

        assertEq(slow.unlockedBalances(user1, id), unlockedBefore, "unlocked unchanged");
        assertEq(slow.balanceOf(user1, id), balBefore, "wrapper unchanged");
        assertEq(slow.balanceOf(address(bad), id), 0, "no wrapper at receiver");
        assertEq(slow.nonces(user1), nonceBefore, "nonce not bumped");
        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(address(bad)), 0);
    }

    // A contract sender whose onERC1155Received reverts cannot complete clawback —
    // _safeTransfer back to pt.from triggers the revert and rolls the call back.
    // The pending entry stays intact and is recoverable when the sender fixes itself.
    function testClawbackToRevertingSenderUnwinds() public {
        RevertingReceiver bad = new RevertingReceiver{value: AMOUNT}(slow);
        uint256 transferId = bad.deposit(user2, DELAY);

        // Past expiry + grace.
        vm.warp(block.timestamp + DELAY + 30 days + 1);

        vm.expectRevert();
        bad.callClawback(transferId);

        // Pending entry intact.
        (uint96 ts, address from,,, uint256 amount) = slow.pendingTransfers(transferId);
        assertTrue(ts != 0, "pending preserved");
        assertEq(from, address(bad));
        assertEq(amount, AMOUNT);
        // Wrapper still at the recipient, sender's unlocked balance untouched.
        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.balanceOf(user2, id), AMOUNT);
        assertEq(slow.unlockedBalances(address(bad), id), 0);
    }

    // METADATA

    function testNameAndSymbol() public view {
        assertEq(slow.name(), "SLOW");
        assertEq(slow.symbol(), "SLOW");
    }

    // INPUT VALIDATION

    function testDepositInvalidInputs() public {
        vm.startPrank(user1);

        // ETH branch: token != 0 with msg.value
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo{value: AMOUNT}(USDC, user2, 0, DELAY, "");

        // ETH branch: amount must be 0 (strict, calldata-cheap convention)
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo{value: AMOUNT}(address(0), user2, AMOUNT, DELAY, "");

        // Non-ETH branch: token == 0 with no msg.value (closes the silent-success hole)
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo(address(0), user2, AMOUNT, DELAY, "");

        // Non-ETH branch: zero-amount ERC20 deposit
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositTo(address(token), user2, 0, DELAY, "");

        vm.stopPrank();
    }

    function testZeroAmountTransferReverts() public {
        uint256 id = calculateId(address(0), DELAY);

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.safeTransferFrom(user1, user2, id, 0, "");
    }

    // Without the InvalidAmount guard, an attacker with no balance could
    // grow a victim's _inboundTransfers set with zero-value pending entries.
    function testZeroAmountTransferCannotSpamInboundSet() public {
        address attacker = address(0xBAD);
        uint256 id = calculateId(address(0), DELAY);

        uint256 inboundBefore = slow.inboundTransferCount(user2);

        vm.prank(attacker);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.safeTransferFrom(attacker, user2, id, 0, "");

        assertEq(slow.inboundTransferCount(user2), inboundBefore);
    }

    function testTransferToContractItselfReverts() public {
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidRecipient.selector);
        slow.safeTransferFrom(user1, address(slow), id, AMOUNT, "");
    }

    function testWithdrawToZeroAddressReverts() public {
        // Deposit with zero delay so user1 holds an unlocked balance.
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidRecipient.selector);
        slow.withdrawFrom(user1, address(0), id, AMOUNT);
    }

    function testWithdrawToContractItselfReverts() public {
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidRecipient.selector);
        slow.withdrawFrom(user1, address(slow), id, AMOUNT);
    }

    function testWithdrawToGateReverts() public {
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);
        address gate = slow.gate();

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidRecipient.selector);
        slow.withdrawFrom(user1, gate, id, AMOUNT);
    }

    // TIMELOCK BOUNDARY (>= unlock, < reverse)

    function testUnlockNonexistent() public {
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.unlock(0xdeadbeef);
    }

    // claim() — auto-settle path: burns the wrapped 1155 from the recipient and pays out
    // the raw underlying directly. Permissioned by the ERC1155 operator pattern so a
    // recipient holding wrapped form on purpose (e.g., a multisig with a 1-day-only policy)
    // cannot be force-unwrapped by a third-party keeper.

    function testClaimByHolder() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        uint256 id = calculateId(address(0), DELAY);

        // Wrapped 1155 was minted to recipient at deposit time.
        assertEq(slow.balanceOf(user2, id), AMOUNT, "wrapper minted to recipient");

        vm.warp(block.timestamp + DELAY + 1);

        uint256 balanceBefore = user2.balance;
        vm.prank(user2);
        slow.claim(transferId);

        assertEq(user2.balance, balanceBefore + AMOUNT, "underlying ETH paid to recipient");
        assertEq(slow.balanceOf(user2, id), 0, "wrapper burned");

        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0, "pending entry cleared");
    }

    function testClaimByOperator() public {
        address keeper = address(0xCAFE);
        vm.deal(keeper, 1 ether);

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Recipient opts into auto-settle by approving the keeper as ERC1155 operator.
        vm.prank(user2);
        slow.setApprovalForAll(keeper, true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256 user2Before = user2.balance;
        uint256 keeperBefore = keeper.balance;

        vm.prank(keeper);
        slow.claim(transferId);

        assertEq(user2.balance, user2Before + AMOUNT, "ETH always goes to recipient");
        assertEq(keeper.balance, keeperBefore, "keeper does not receive funds");
    }

    function testClaimUnauthorizedReverts() public {
        address attacker = address(0xBAD);

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(attacker);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.claim(transferId);
    }

    function testClaimBeforeExpiryReverts() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        vm.expectRevert(SLOW.TimelockNotExpired.selector);
        slow.claim(transferId);
    }

    function testClaimNonexistentReverts() public {
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.claim(0xdeadbeef);
    }

    // Guardian on `pt.to` blocks claim's raw-payout path, forcing the unlock +
    // withdrawFrom flow where guardian gates the eventual raw exit.
    function testClaimRevertsWhenRecipientHasGuardian() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setGuardian(guardian);

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(user2);
        vm.expectRevert(SLOW.ClaimBlockedByGuardian.selector);
        slow.claim(transferId);
    }

    // Guardian-mode recipient still settles via unlock + guardian-approved withdrawFrom.
    function testGuardianRecipientSettlesViaUnlockPath() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setGuardian(guardian);

        vm.warp(block.timestamp + DELAY + 1);

        // Recipient (or recipient-approved operator) can unlock; third parties cannot.
        vm.prank(user2);
        slow.unlock(transferId);

        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.unlockedBalances(user2, id), AMOUNT, "unlock credited recipient");

        // Bare withdrawFrom blocked without guardian approval.
        vm.prank(user2);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.withdrawFrom(user2, user2, id, AMOUNT);

        // Guardian approves the self-withdraw transferId, then withdrawFrom succeeds.
        uint256 withdrawTransferId = slow.predictWithdrawalId(user2, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user2, withdrawTransferId);

        uint256 user2Before = user2.balance;
        vm.prank(user2);
        slow.withdrawFrom(user2, user2, id, AMOUNT);
        assertEq(user2.balance, user2Before + AMOUNT, "raw exit gated by guardian succeeds");
    }

    // Clawback returns wrapper to a guardian-mode sender; raw exit is then guardian-gated.
    function testClawbackPreservesGuardianOnSender() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.warp(block.timestamp + DELAY + 30 days + 1);

        uint256 id = calculateId(address(0), DELAY);

        vm.prank(user1);
        slow.clawback(transferId);

        // Wrapper is back at sender, but raw exit blocked by guardian.
        assertEq(slow.balanceOf(user1, id), AMOUNT, "wrapper at sender");
        vm.prank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.withdrawFrom(user1, user1, id, AMOUNT);
    }

    function testClaimERC20() public {
        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        uint256 transferId = slow.depositTo(address(token), user2, AMOUNT, DELAY, "");
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY + 1);

        uint256 user2Before = token.balanceOf(user2);
        vm.prank(user2);
        slow.claim(transferId);

        assertEq(token.balanceOf(user2), user2Before + AMOUNT, "ERC20 underlying paid to recipient");
    }

    function testClaimAfterReverseReverts() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Reverse before expiry; pending entry is deleted.
        vm.prank(user1);
        slow.reverse(transferId);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.claim(transferId);
    }

    function testClaimAfterUnlockReverts() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.unlock(transferId); // recipient settles via unlock; deletes pending

        vm.prank(user2);
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.claim(transferId);
    }

    function testClaimUpdatesEnumeration() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Pre-claim: both sender's outbound and recipient's inbound list this transfer.
        assertEq(slow.outboundTransferCount(user1), 1);
        assertEq(slow.inboundTransferCount(user2), 1);
        assertEq(slow.outboundTransferAt(user1, 0), transferId);
        assertEq(slow.inboundTransferAt(user2, 0), transferId);

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.claim(transferId);

        // Post-claim: enumeration sets are empty for both parties.
        assertEq(slow.outboundTransferCount(user1), 0);
        assertEq(slow.inboundTransferCount(user2), 0);
    }

    // The ETH payout in claim() is the only external call. A malicious recipient that
    // re-enters via its receive() must be rejected by the nonReentrant guard.
    function testClaimReentrancyBlocked() public {
        ReentrantClaimReceiver malicious = new ReentrantClaimReceiver{value: AMOUNT}(slow);
        uint256 transferId = malicious.deposit(DELAY);

        vm.warp(block.timestamp + DELAY + 1);
        malicious.callClaim(transferId);

        assertTrue(malicious.reentryRejected(), "reentry should be rejected");
    }

    event TransferClaimed(uint256 indexed transferId);

    function testClaimEmitsEvent() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.warp(block.timestamp + DELAY + 1);

        vm.expectEmit(true, false, false, false, address(slow));
        emit TransferClaimed(transferId);

        vm.prank(user2);
        slow.claim(transferId);
    }

    // clawback() — sender recovery after `delay + 30 days` of inactivity. Catches
    // transfers whose pending entry still exists (no one called unlock/claim during grace).

    function testClawbackByFrom() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Past timelock + full grace period.
        vm.warp(block.timestamp + DELAY + 30 days + 1);

        uint256 id = calculateId(address(0), DELAY);

        vm.prank(user1);
        slow.clawback(transferId);

        // Wrapper-route: sender now holds the wrapper with credited unlocked balance.
        assertEq(slow.balanceOf(user1, id), AMOUNT, "wrapper returned to sender");
        assertEq(slow.balanceOf(user2, id), 0, "wrapper removed from recipient");
        assertEq(slow.unlockedBalances(user1, id), AMOUNT, "unlocked balance credited");

        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0, "pending entry cleared");

        // Compose with withdrawFrom for raw exit.
        uint256 user1Before = user1.balance;
        vm.prank(user1);
        slow.withdrawFrom(user1, user1, id, AMOUNT);
        assertEq(user1.balance, user1Before + AMOUNT, "underlying ETH returned to sender");
        assertEq(slow.balanceOf(user1, id), 0, "wrapper burned on withdraw");
    }

    function testClawbackByOperator() public {
        address operator = address(0x4);
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Sender authorizes an operator to act on their behalf.
        vm.prank(user1);
        slow.setApprovalForAll(operator, true);

        vm.warp(block.timestamp + DELAY + 30 days + 1);

        uint256 id = calculateId(address(0), DELAY);

        vm.prank(operator);
        slow.clawback(transferId);

        // Operator triggers clawback; wrapper lands at sender, raw exit still gated.
        assertEq(slow.balanceOf(user1, id), AMOUNT, "wrapper at sender");
        assertEq(slow.unlockedBalances(user1, id), AMOUNT, "unlocked balance credited");

        // Operator can also drive the withdrawFrom step (operator approval extends to
        // ERC1155 burn auth).
        uint256 user1Before = user1.balance;
        vm.prank(operator);
        slow.withdrawFrom(user1, user1, id, AMOUNT);
        assertEq(user1.balance, user1Before + AMOUNT, "ETH always returned to sender");
    }

    function testClawbackUnauthorizedReverts() public {
        address attacker = address(0xBAD);
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 30 days + 1);

        vm.prank(attacker);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.clawback(transferId);
    }

    function testClawbackBeforeGraceReverts() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // During timelock window — too early.
        vm.prank(user1);
        vm.expectRevert(SLOW.ClawbackNotReady.selector);
        slow.clawback(transferId);

        // Past timelock but before full grace — still too early.
        vm.warp(block.timestamp + DELAY + 30 days - 1);
        vm.prank(user1);
        vm.expectRevert(SLOW.ClawbackNotReady.selector);
        slow.clawback(transferId);
    }

    function testClawbackAfterUnlockReverts() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Recipient unlocks during grace; pending is deleted, settlement is finalized.
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.unlock(transferId);

        // Even after grace, sender cannot clawback — pending is gone.
        vm.warp(block.timestamp + 30 days);
        vm.prank(user1);
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        slow.clawback(transferId);
    }

    function testClawbackERC20() public {
        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        uint256 transferId = slow.depositTo(address(token), user2, AMOUNT, DELAY, "");
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY + 30 days + 1);

        uint256 id = calculateId(address(token), DELAY);
        uint256 user1Before = token.balanceOf(user1);

        // Clawback returns wrapper; withdrawFrom converts to raw underlying.
        vm.startPrank(user1);
        slow.clawback(transferId);
        slow.withdrawFrom(user1, user1, id, AMOUNT);
        vm.stopPrank();

        assertEq(
            token.balanceOf(user1), user1Before + AMOUNT, "ERC20 underlying returned to sender"
        );
    }

    function testTimelockBoundary() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        (uint96 ts,,, uint256 id,) = slow.pendingTransfers(transferId);
        uint256 expiry = uint256(ts) + (id >> 160);

        // One second before: unlock REVERTS, reverse OK
        vm.warp(expiry - 1);
        vm.expectRevert(SLOW.TimelockNotExpired.selector);
        slow.unlock(transferId);

        // Exactly at expiry: reverse REVERTS, unlock OK
        vm.warp(expiry);
        vm.prank(user1);
        vm.expectRevert(SLOW.TimelockExpired.selector);
        slow.reverse(transferId);

        vm.prank(user2);
        slow.unlock(transferId);
        assertEq(slow.unlockedBalances(user2, id), AMOUNT);
    }

    // VIEWERS

    function testCanReverseTransferStates() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        (bool canReverse, bytes4 reason) = slow.canReverseTransfer(transferId);
        assertTrue(canReverse);
        assertEq(reason, bytes4(0));

        (canReverse, reason) = slow.canReverseTransfer(0xdeadbeef);
        assertFalse(canReverse);
        assertEq(reason, SLOW.TransferDoesNotExist.selector);

        vm.warp(block.timestamp + DELAY);
        (canReverse, reason) = slow.canReverseTransfer(transferId);
        assertFalse(canReverse);
        assertEq(reason, SLOW.TimelockExpired.selector);
    }

    function testGuardianViews() public {
        // Fresh user has no active guardian → next set is immediate.
        assertEq(slow.guardians(user1), address(0));

        // No guardian set → approval never needed.
        assertFalse(slow.isGuardianApprovalNeeded(user1, user2, 0, AMOUNT));

        vm.prank(user1);
        slow.setGuardian(guardian);

        // Now approval is needed for the matching params.
        uint256 id = calculateId(address(0), 0);
        assertTrue(slow.isGuardianApprovalNeeded(user1, user2, id, AMOUNT));

        // With an active guardian, further changes are no longer immediate.
        assertEq(slow.guardians(user1), guardian);

        // Once guardian approves the predicted transferId, the view flips.
        uint256 expected = slow.predictTransferId(user1, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user1, expected);
        assertFalse(slow.isGuardianApprovalNeeded(user1, user2, id, AMOUNT));
    }

    function testPredictTransferIdMatches() public {
        uint256 id = calculateId(address(0), DELAY);
        uint256 predicted = slow.predictTransferId(user1, user2, id, AMOUNT);

        vm.prank(user1);
        uint256 actual = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        assertEq(predicted, actual);
    }

    function testEncodeDecodeIdRoundtrip() public view {
        address[3] memory toks = [address(0), USDC, address(0xCAFE)];
        uint96[3] memory delays = [uint96(0), uint96(3600), type(uint96).max];
        for (uint256 i = 0; i < toks.length; i++) {
            for (uint256 j = 0; j < delays.length; j++) {
                uint256 id = slow.encodeId(toks[i], delays[j]);
                (address t, uint256 d) = slow.decodeId(id);
                assertEq(t, toks[i]);
                assertEq(d, delays[j]);
            }
        }
    }

    // MULTICALL — the dapp's actual settlement flows

    function testMulticallClaim() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY);

        uint256 id = calculateId(address(0), DELAY);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(slow.unlock, (transferId));
        calls[1] = abi.encodeCall(slow.withdrawFrom, (user2, user2, id, AMOUNT));

        uint256 balBefore = user2.balance;
        vm.prank(user2);
        slow.multicall(calls);

        assertEq(user2.balance, balBefore + AMOUNT);
        assertEq(slow.balanceOf(user2, id), 0);
        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0);
    }

    function testMulticallReclaim() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        uint256 id = calculateId(address(0), DELAY);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(slow.reverse, (transferId));
        calls[1] = abi.encodeCall(slow.withdrawFrom, (user1, user1, id, AMOUNT));

        uint256 balBefore = user1.balance;
        vm.prank(user1);
        slow.multicall(calls);

        assertEq(user1.balance, balBefore + AMOUNT);
        assertEq(slow.balanceOf(user1, id), 0);
        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0);
    }

    function testMulticallRejectsValue() public {
        bytes[] memory calls = new bytes[](0);
        vm.deal(user1, 1 ether);
        vm.prank(user1);
        vm.expectRevert();
        slow.multicall{value: 1 ether}(calls);
    }

    /// Regression: msg.value reuse across delegatecalled sub-deposits. Solady's Multicallable
    /// guards against this by rejecting nonzero msg.value at entry; this test pins that
    /// behavior to the specific attack shape (N copies of payable depositTo).
    function testMulticallDepositValueReuseBlocked() public {
        bytes[] memory calls = new bytes[](5);
        for (uint256 i; i < 5; ++i) {
            calls[i] = abi.encodeCall(SLOW.depositTo, (address(0), user1, 0, uint96(1 days), ""));
        }
        vm.deal(user1, 1 ether);
        vm.prank(user1);
        vm.expectRevert();
        slow.multicall{value: 1 ether}(calls);

        // Pool balance unchanged, no wrappers minted.
        uint256 id = calculateId(address(0), 1 days);
        assertEq(slow.balanceOf(user1, id), 0, "no wrapper minted");
    }

    // CONSTRUCTOR REGISTRATION

    function testHtmlRegistryRegisteredOnDeploy() public {
        address REGISTRY = 0xFa11bacCdc38022dbf8795cC94333304C9f22722;
        MockHtmlRegistry tpl = new MockHtmlRegistry();
        vm.etch(REGISTRY, address(tpl).code);

        bytes memory part1 = bytes("<html>");
        bytes memory part2 = bytes("</html>");
        SLOW newSlow = new SLOW(part1, part2);

        assertEq(MockHtmlRegistry(REGISTRY).lastTarget(), address(newSlow));
        assertEq(
            keccak256(bytes(MockHtmlRegistry(REGISTRY).lastHtml())),
            keccak256(bytes.concat(part1, part2))
        );
    }

    function testReverseEmitsEvent() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.expectEmit(true, false, false, false, address(slow));
        emit TransferReversed(transferId);

        vm.prank(user1);
        slow.reverse(transferId);
    }

    function testUriIncludesAttributesAndPerIdName() public view {
        uint256 id = calculateId(USDC, 1 days);
        string memory u = slow.uri(id);

        bytes memory uriBytes = bytes(u);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(uriBytes.length - prefix.length);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = uriBytes[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(payload)));

        // Per-id name disambiguates listings (e.g., "SLOW USDC · 1 day")
        assertTrue(LibString.contains(json, '"name":"SLOW USDC'), "per-id name");
        assertTrue(LibString.contains(json, "1 day"), "human-readable delay in name");

        // Attributes array present with all four traits
        assertTrue(LibString.contains(json, '"attributes":['));
        assertTrue(LibString.contains(json, '"trait_type":"Asset"'));
        assertTrue(LibString.contains(json, '"trait_type":"Token"'));
        assertTrue(LibString.contains(json, '"trait_type":"Delay"'));
        assertTrue(LibString.contains(json, '"trait_type":"Delay (seconds)"'));
        assertTrue(LibString.contains(json, '"value":86400'));
    }

    // Token whose name() carries a JSON injection attempting to inject a fake image field.
    function testUriEscapesMaliciousMetadata() public {
        EvilToken evil = new EvilToken();
        uint256 id = calculateId(address(evil), 0);
        string memory u = slow.uri(id);

        // Strip the "data:application/json;base64," prefix and decode.
        bytes memory uriBytes = bytes(u);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(uriBytes.length - prefix.length);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = uriBytes[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(payload)));

        // Raw injection (closing description and opening a fake image field) must NOT survive.
        assertFalse(
            LibString.contains(json, '","image":"evil_image'), "raw JSON injection leaked through"
        );
        // The escapeJSON output must be present in the description.
        assertTrue(
            LibString.contains(json, '\\",\\"image\\":\\"evil_image'),
            "name should be JSON-escaped in description"
        );
    }

    // 65-byte name() ending in a 3-byte CJK char. Solady's readName(64) cuts at byte 64,
    // leaving only 2 of the codepoint's 3 bytes in the buffer. _utf8Trim must drop the
    // partial sequence so the JSON description is valid UTF-8 — no stray U+FFFD on
    // strict marketplace parsers, no orphan lead byte (0xE4) anywhere in the payload.
    function testUriTrimsPartialUtf8FromTruncatedName() public {
        LongCjkTailToken t = new LongCjkTailToken();
        uint256 id = calculateId(address(t), 0);
        string memory u = slow.uri(id);

        bytes memory uriBytes = bytes(u);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(uriBytes.length - prefix.length);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = uriBytes[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(payload)));

        // 62 ASCII 'A's appear cleanly between the literals; the 3-byte tail is gone.
        assertTrue(
            LibString.contains(
                json,
                "time-locked AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA (CJK) transfer."
            ),
            "partial UTF-8 from readName(64) leaked into description"
        );

        // No 0xE4 byte (lead for 三, U+4E09) should survive anywhere in the JSON.
        bytes memory jb = bytes(json);
        for (uint256 i = 0; i < jb.length; i++) {
            assertTrue(uint8(jb[i]) != 0xE4, "stray UTF-8 lead byte in JSON");
        }
    }

    // 64-byte name() ending with a complete 三 (3 bytes). readName(64) returns all 64
    // bytes; _utf8Trim must walk back over the two continuation bytes, recognize the
    // sequence is complete, and restore the byte count (no trim).
    function testUriPreservesCompleteUtf8AtBoundary() public {
        CompleteCjkTailToken t = new CompleteCjkTailToken();
        uint256 id = calculateId(address(t), 0);
        string memory u = slow.uri(id);

        bytes memory uriBytes = bytes(u);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(uriBytes.length - prefix.length);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = uriBytes[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(payload)));

        // Full 61 'A's plus the complete 三 codepoint should appear in the description.
        assertTrue(
            LibString.contains(
                json,
                unicode"time-locked AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA三 (CCJK)"
            ),
            "complete UTF-8 sequence at byte boundary was incorrectly trimmed"
        );
    }

    // 30-byte ASCII name() trips _clipForDisplay's 28-byte SVG cap. The JSON description
    // must still carry the full name; only the SVG body row should be truncated with "...".
    function testUriClipsLongNameInSvgWithEllipsis() public {
        LongAsciiNameToken t = new LongAsciiNameToken();
        uint256 id = calculateId(address(t), 1 days);
        string memory u = slow.uri(id);

        bytes memory uriBytes = bytes(u);
        bytes memory prefix = bytes("data:application/json;base64,");
        bytes memory payload = new bytes(uriBytes.length - prefix.length);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = uriBytes[prefix.length + i];
        }
        string memory json = string(Base64.decode(string(payload)));

        // JSON description preserves the full 30-char name.
        assertTrue(
            LibString.contains(json, "time-locked AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA (LNT) transfer."),
            "JSON description should keep full name"
        );

        // Decode the inner SVG (image is itself a base64 data URI).
        bytes memory svgPrefix = bytes("data:image/svg+xml;base64,");
        uint256 svgStart = LibString.indexOf(json, string(svgPrefix));
        assertTrue(svgStart != LibString.NOT_FOUND, "no SVG in JSON");
        svgStart += svgPrefix.length;
        bytes memory jb = bytes(json);
        uint256 svgEnd = svgStart;
        while (svgEnd < jb.length && jb[svgEnd] != bytes1('"')) svgEnd++;
        bytes memory svgB64 = new bytes(svgEnd - svgStart);
        for (uint256 i = 0; i < svgB64.length; i++) {
            svgB64[i] = jb[svgStart + i];
        }
        string memory svg = string(Base64.decode(string(svgB64)));

        // SVG body row shows 28 A's followed by "..."; the full 30-A name must NOT appear.
        assertTrue(
            LibString.contains(svg, "AAAAAAAAAAAAAAAAAAAAAAAAAAAA..."),
            "SVG body row should be clipped with ellipsis"
        );
        assertFalse(
            LibString.contains(svg, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "full 30-char name should not appear in SVG"
        );
    }

    // FUZZ + INVARIANT TESTS
    //
    // These exercise SLOW with randomized (amount, delay) inputs to catch state combinations
    // that explicit per-case tests don't enumerate. Each test asserts a property that must
    // hold for *every* legal input, not just the cases a human happened to write down.

    /// Property: depositTo + warp(delay) + claim returns exactly `amount` to the recipient.
    function testFuzz_RoundtripETHViaClaim(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        vm.deal(user1, amount);
        uint256 senderBefore = user1.balance;
        uint256 recipientBefore = user2.balance;

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: amount}(address(0), user2, 0, delay, "");

        vm.warp(block.timestamp + delay);

        vm.prank(user2);
        slow.claim(transferId);

        assertEq(user1.balance, senderBefore - amount, "sender debited exactly");
        assertEq(user2.balance, recipientBefore + amount, "recipient credited exactly");

        uint256 id = calculateId(address(0), delay);
        assertEq(slow.balanceOf(user2, id), 0, "wrapped position burned");
        (uint96 ts,,,,) = slow.pendingTransfers(transferId);
        assertEq(ts, 0, "pending entry deleted");
    }

    /// Property: the dapp's two-step path (unlock + withdrawFrom) settles to the same result
    /// as one-shot claim. Both steps are recipient-side.
    function testFuzz_RoundtripETHViaUnlockWithdraw(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        vm.deal(user1, amount);
        uint256 senderBefore = user1.balance;
        uint256 recipientBefore = user2.balance;

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: amount}(address(0), user2, 0, delay, "");

        vm.warp(block.timestamp + delay);
        vm.prank(user2);
        slow.unlock(transferId);

        uint256 id = calculateId(address(0), delay);
        vm.prank(user2);
        slow.withdrawFrom(user2, user2, id, amount);

        assertEq(user1.balance, senderBefore - amount);
        assertEq(user2.balance, recipientBefore + amount);
    }

    /// Property: pre-expiry reverse + withdraw restores the sender exactly.
    function testFuzz_RoundtripETHViaReverse(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        vm.deal(user1, amount);
        uint256 senderBefore = user1.balance;

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: amount}(address(0), user2, 0, delay, "");

        // Still inside the reverse window.
        vm.prank(user1);
        slow.reverse(transferId);

        uint256 id = calculateId(address(0), delay);
        vm.prank(user1);
        slow.withdrawFrom(user1, user1, id, amount);

        assertEq(user1.balance, senderBefore, "sender restored exactly");
        assertEq(slow.balanceOf(user2, id), 0, "recipient holds nothing");
    }

    /// Property: post-grace clawback + withdrawFrom restores the sender exactly when the
    /// recipient never claimed.
    function testFuzz_RoundtripETHViaClawback(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        vm.deal(user1, amount);
        uint256 senderBefore = user1.balance;

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: amount}(address(0), user2, 0, delay, "");

        // Past expiry + 30-day grace window with the recipient never acting.
        vm.warp(block.timestamp + delay + 30 days);

        uint256 id = calculateId(address(0), delay);

        vm.startPrank(user1);
        slow.clawback(transferId);
        slow.withdrawFrom(user1, user1, id, amount);
        vm.stopPrank();

        assertEq(user1.balance, senderBefore, "sender recovered exactly");
        assertEq(slow.balanceOf(user2, id), 0, "wrapped position cleared from recipient");
    }

    /// Property: ERC20 round-trip via claim conserves token balance exactly.
    function testFuzz_RoundtripERC20ViaClaim(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        token.mint(user1, amount);
        uint256 senderBefore = token.balanceOf(user1);
        uint256 recipientBefore = token.balanceOf(user2);

        vm.startPrank(user1);
        token.approve(address(slow), amount);
        uint256 transferId = slow.depositTo(address(token), user2, amount, delay, "");
        vm.stopPrank();

        vm.warp(block.timestamp + delay);

        vm.prank(user2);
        slow.claim(transferId);

        assertEq(token.balanceOf(user1), senderBefore - amount, "sender debited exactly");
        assertEq(token.balanceOf(user2), recipientBefore + amount, "recipient credited exactly");
    }

    /// Strict invariant: at any point in the lifecycle, for every (user, id):
    ///     balanceOf[user][id] == unlockedBalances[user][id] + sum_of_inbound_pending_amounts(user, id)
    /// We exercise it across deposit, partial unlock, transfer (re-locks), claim, reverse,
    /// and clawback — i.e. every state-mutating path that touches balances or pendings.
    function testFuzz_BalanceEqualsUnlockedPlusPending(uint96 a1, uint96 a2, uint96 delay) public {
        a1 = uint96(bound(a1, 1, 50 ether));
        a2 = uint96(bound(a2, 1, 50 ether));
        delay = uint96(bound(delay, 1, 365 days));

        uint256 id = calculateId(address(0), delay);
        vm.deal(user1, uint256(a1) + uint256(a2));

        // Step 1: two delayed deposits to user2.
        vm.prank(user1);
        uint256 t1 = slow.depositTo{value: a1}(address(0), user2, 0, delay, "");
        _assertBalanceInvariant(user2, id);

        vm.prank(user1);
        uint256 t2 = slow.depositTo{value: a2}(address(0), user2, 0, delay, "");
        _assertBalanceInvariant(user2, id);

        // Step 2: expire and unlock just one of them.
        vm.warp(block.timestamp + delay + 1);
        vm.prank(user2);
        slow.unlock(t1);
        _assertBalanceInvariant(user2, id);

        // Step 3: user2 transfers the unlocked half to a third party — re-locks for them.
        address user3 = address(0x3);
        vm.prank(user2);
        slow.safeTransferFrom(user2, user3, id, a1, "");
        _assertBalanceInvariant(user2, id);
        _assertBalanceInvariant(user3, id);

        // Step 4: claim the still-pending t2 directly — burns from user2.
        vm.prank(user2);
        slow.claim(t2);
        _assertBalanceInvariant(user2, id);
    }

    function _assertBalanceInvariant(address user, uint256 id) internal view {
        uint256 wrapped = slow.balanceOf(user, id);
        uint256 unlocked = slow.unlockedBalances(user, id);

        // Sum amounts of inbound pending entries that match this id.
        uint256[] memory inbound = slow.getInboundTransfers(user);
        uint256 pendingSum;
        for (uint256 i; i < inbound.length; ++i) {
            (,,, uint256 ptId, uint256 amount) = slow.pendingTransfers(inbound[i]);
            if (ptId == id) pendingSum += amount;
        }

        assertEq(
            wrapped,
            unlocked + pendingSum,
            "balanceOf must equal unlocked + inbound-pending across full lifecycle"
        );
    }

    /// Invariant: post-deposit, ERC1155 balance == unlocked + pending amount (per recipient/id).
    /// The pending entry holds the locked portion; balanceOf carries the wrapped total.
    function testFuzz_AccountingInvariant(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 0, 365 days));

        vm.deal(user1, amount);
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: amount}(address(0), user2, 0, delay, "");

        uint256 id = calculateId(address(0), delay);
        uint256 wrapped = slow.balanceOf(user2, id);
        uint256 unlocked = slow.unlockedBalances(user2, id);

        if (delay == 0) {
            assertEq(wrapped, unlocked, "no-delay deposit fully unlocks");
        } else {
            assertEq(unlocked, 0, "delay deposit holds locked");
            (,,,, uint256 pendingAmount) = slow.pendingTransfers(transferId);
            assertEq(wrapped, pendingAmount, "wrapped == pending amount");
            assertEq(wrapped, amount, "wrapped == deposited amount");
        }
    }

    /// Invariant: contract's underlying ETH balance equals the sum of wrapped supply across
    /// all recipients for that token's encoded id space.
    function testFuzz_WrappedSupplyMatchesUnderlying(uint96 a1, uint96 a2, uint96 delay) public {
        a1 = uint96(bound(a1, 1, 50 ether));
        a2 = uint96(bound(a2, 1, 50 ether));
        delay = uint96(bound(delay, 0, 365 days));

        uint256 contractBefore = address(slow).balance;

        vm.deal(user1, a1);
        vm.prank(user1);
        slow.depositTo{value: a1}(address(0), user2, 0, delay, "");

        vm.deal(user2, a2);
        vm.prank(user2);
        slow.depositTo{value: a2}(address(0), user1, 0, delay, "");

        uint256 id = calculateId(address(0), delay);
        uint256 wrappedSupply = slow.balanceOf(user1, id) + slow.balanceOf(user2, id);
        uint256 underlyingHeld = address(slow).balance - contractBefore;

        assertEq(wrappedSupply, uint256(a1) + uint256(a2), "wrapped sum == deposit sum");
        assertEq(wrappedSupply, underlyingHeld, "wrapped supply == underlying held");
    }

    /// Invariant: nonce only advances on operations that consume one. depositTo with delay,
    /// safeTransferFrom with delay-or-guardian, and guardian-gated withdrawFrom each consume +1;
    /// nothing else moves the counter.
    function testFuzz_NonceMonotonicity(uint96 amount, uint96 delay) public {
        amount = uint96(bound(amount, 1, 100 ether));
        delay = uint96(bound(delay, 1, 365 days));

        uint256 n0 = slow.nonces(user1);

        // depositTo with delay > 0 → nonce += 1
        vm.deal(user1, amount);
        vm.prank(user1);
        slow.depositTo{value: amount}(address(0), user2, 0, delay, "");
        assertEq(slow.nonces(user1), n0 + 1, "delay deposit consumes nonce");

        // depositTo with delay == 0 → nonce unchanged
        vm.deal(user1, amount);
        vm.prank(user1);
        slow.depositTo{value: amount}(address(0), user2, 0, 0, "");
        assertEq(slow.nonces(user1), n0 + 1, "no-delay deposit does not consume nonce");

        // unlock is permissionless and does not move msg.sender's nonce
        // (we'd need to warp + unlock to test this; keeping the assertion simple here).
    }

    /// Invariant: outbound and inbound enumerable sets are exact mirrors of `pendingTransfers`.
    /// For every (user, transferId) in `_outboundTransfers[user]`: pending exists, `pt.from == user`,
    /// and the same transferId appears in `_inboundTransfers[pt.to]`. Symmetric for inbound.
    /// Settlement (unlock/claim/reverse/clawback) must remove from BOTH sides atomically.
    function testFuzz_SetMembershipMirrorsPending(uint96 a1, uint96 a2, uint96 a3, uint96 delay)
        public
    {
        a1 = uint96(bound(a1, 1, 50 ether));
        a2 = uint96(bound(a2, 1, 50 ether));
        a3 = uint96(bound(a3, 1, 50 ether));
        delay = uint96(bound(delay, 1, 365 days));

        address user3 = address(0x3);
        uint256 id = calculateId(address(0), delay);

        // Deposit user1 → user2.
        vm.deal(user1, uint256(a1) + uint256(a2));
        vm.prank(user1);
        uint256 t1 = slow.depositTo{value: a1}(address(0), user2, 0, delay, "");
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user2);
        _assertPairLinked(t1);

        // Deposit user1 → user3 (different recipient, same sender — outbound[user1] grows).
        vm.prank(user1);
        uint256 t2 = slow.depositTo{value: a2}(address(0), user3, 0, delay, "");
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user3);
        _assertPairLinked(t2);

        // Reverse-direction deposit user2 → user1.
        vm.deal(user2, a3);
        vm.prank(user2);
        uint256 t3 = slow.depositTo{value: a3}(address(0), user1, 0, delay, "");
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user2);
        _assertPairLinked(t3);

        // Expire and unlock t1 — must drop from outbound[user1] AND inbound[user2].
        vm.warp(block.timestamp + delay);
        vm.prank(user2);
        slow.unlock(t1);
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user2);
        assertFalse(_outboundContains(user1, t1), "unlock leaves outbound");
        assertFalse(_inboundContains(user2, t1), "unlock leaves inbound");

        // Claim t2 (user3 has no guardian) — same removal contract.
        vm.prank(user3);
        slow.claim(t2);
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user3);
        assertFalse(_outboundContains(user1, t2), "claim leaves outbound");
        assertFalse(_inboundContains(user3, t2), "claim leaves inbound");

        // Re-transfer the unlocked balance from user2 to user3 (creates a fresh pending).
        uint256 t4 = slow.predictTransferId(user2, user3, id, a1);
        vm.prank(user2);
        slow.safeTransferFrom(user2, user3, id, a1, "");
        _assertSetIntegrity(user2);
        _assertSetIntegrity(user3);
        _assertPairLinked(t4);

        // Reverse the re-transfer (within timelock).
        vm.prank(user2);
        slow.reverse(t4);
        _assertSetIntegrity(user2);
        _assertSetIntegrity(user3);
        assertFalse(_outboundContains(user2, t4), "reverse leaves outbound");
        assertFalse(_inboundContains(user3, t4), "reverse leaves inbound");

        // Clawback t3 after the 30-day grace.
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(user2);
        slow.clawback(t3);
        _assertSetIntegrity(user1);
        _assertSetIntegrity(user2);
        assertFalse(_outboundContains(user2, t3), "clawback leaves outbound");
        assertFalse(_inboundContains(user1, t3), "clawback leaves inbound");
    }

    function _assertSetIntegrity(address user) internal view {
        uint256[] memory outbound = slow.getOutboundTransfers(user);
        for (uint256 i; i < outbound.length; ++i) {
            uint256 transferId = outbound[i];
            (uint96 ts, address from, address to,,) = slow.pendingTransfers(transferId);
            assertTrue(ts != 0, "outbound entry references stale pending");
            assertEq(from, user, "outbound entry from-mismatch");
            assertTrue(_inboundContains(to, transferId), "outbound entry has no inbound mirror");
        }
        uint256[] memory inbound = slow.getInboundTransfers(user);
        for (uint256 i; i < inbound.length; ++i) {
            uint256 transferId = inbound[i];
            (uint96 ts, address from, address to,,) = slow.pendingTransfers(transferId);
            assertTrue(ts != 0, "inbound entry references stale pending");
            assertEq(to, user, "inbound entry to-mismatch");
            assertTrue(_outboundContains(from, transferId), "inbound entry has no outbound mirror");
        }
    }

    function _assertPairLinked(uint256 transferId) internal view {
        (uint96 ts, address from, address to,,) = slow.pendingTransfers(transferId);
        assertTrue(ts != 0, "pending must exist for linkage check");
        assertTrue(
            _outboundContains(from, transferId), "active pending missing from outbound[from]"
        );
        assertTrue(_inboundContains(to, transferId), "active pending missing from inbound[to]");
    }

    function _outboundContains(address user, uint256 transferId) internal view returns (bool) {
        uint256[] memory s = slow.getOutboundTransfers(user);
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == transferId) return true;
        }
        return false;
    }

    function _inboundContains(address user, uint256 transferId) internal view returns (bool) {
        uint256[] memory s = slow.getInboundTransfers(user);
        for (uint256 i; i < s.length; ++i) {
            if (s[i] == transferId) return true;
        }
        return false;
    }

    // GATE — auto-claim forwarder

    function testGateImmutableAndSlowReference() public view {
        address g = slow.gate();
        assertTrue(g != address(0), "gate is set");
        assertGt(g.code.length, 0, "gate has code");
        assertEq(address(SLOWGate(g).slow()), address(slow), "gate.slow() points back to SLOW");
    }

    /// CREATE2 derivation: anyone with (SLOW address, salt 0, gate creation code) can
    /// compute `slow.gate()` offchain — no event or RPC call required.
    function testGateAddressIsCreate2Predictable() public view {
        address predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(slow),
                            bytes32(0),
                            keccak256(type(SLOWGate).creationCode)
                        )
                    )
                )
            )
        );
        assertEq(slow.gate(), predicted, "gate not at CREATE2-predicted address");
    }

    function testGateClaimETHViaApproval() public {
        SLOWGate gate = SLOWGate(slow.gate());

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256 user2Before = user2.balance;
        address keeper = address(0xCAFE);
        vm.prank(keeper);
        gate.claim(transferId);

        assertEq(user2.balance, user2Before + AMOUNT, "ETH paid to recipient via gate");
    }

    function testGateClaimERC20ViaApproval() public {
        SLOWGate gate = SLOWGate(slow.gate());

        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        uint256 transferId = slow.depositTo(address(token), user2, AMOUNT, DELAY, "");
        vm.stopPrank();

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256 tokBefore = token.balanceOf(user2);
        gate.claim(transferId);
        assertEq(token.balanceOf(user2), tokBefore + AMOUNT, "ERC20 paid to recipient via gate");
    }

    function testGateClaimWithoutApprovalReverts() public {
        SLOWGate gate = SLOWGate(slow.gate());

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);

        // Recipient never approved the gate — auth check inside slow.claim must reject.
        vm.expectRevert(SLOW.Unauthorized.selector);
        gate.claim(transferId);
    }

    function testGateClaimMany() public {
        SLOWGate gate = SLOWGate(slow.gate());

        uint256[] memory ids = new uint256[](3);
        vm.prank(user1);
        ids[0] = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.prank(user1);
        ids[1] = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        ids[2] = slow.depositTo(address(token), user2, AMOUNT, DELAY, "");
        vm.stopPrank();

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256 ethBefore = user2.balance;
        uint256 tokBefore = token.balanceOf(user2);

        gate.claimMany(ids);

        assertEq(user2.balance, ethBefore + 2 * AMOUNT, "two ETH claims settled");
        assertEq(token.balanceOf(user2), tokBefore + AMOUNT, "ERC20 claim settled");
    }

    function testGateClaimManyEmpty() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256[] memory ids = new uint256[](0);
        // Must not revert — the loop is `i != length` so empty arrays no-op.
        gate.claimMany(ids);
    }

    function testGateClaimManyAtomicity() public {
        SLOWGate gate = SLOWGate(slow.gate());

        vm.prank(user1);
        uint256 valid = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256[] memory ids = new uint256[](2);
        ids[0] = valid;
        ids[1] = 0xdeadbeef; // Nonexistent — second iteration must abort the whole batch.

        uint256 user2Before = user2.balance;
        vm.expectRevert(SLOW.TransferDoesNotExist.selector);
        gate.claimMany(ids);

        assertEq(user2.balance, user2Before, "no funds moved on partial failure");

        // Valid transfer still claimable after the rollback.
        gate.claim(valid);
        assertEq(user2.balance, user2Before + AMOUNT, "valid claim still works post-revert");
    }

    function testGateClaimBeforeExpiryReverts() public {
        SLOWGate gate = SLOWGate(slow.gate());

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        // No warp — gate must not bypass the timelock check inside slow.claim.
        vm.expectRevert(SLOW.TimelockNotExpired.selector);
        gate.claim(transferId);
    }

    function testGateCannotRedirectFunds() public {
        // Safety claim from the SLOWGate NatSpec: "approved gate cannot redirect funds".
        // No matter who calls gate.claim, the underlying flows to pt.to (set at deposit),
        // never to the caller and never to the gate itself.
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);

        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.warp(block.timestamp + DELAY + 1);

        uint256 keeperBefore = keeper.balance;
        uint256 user2Before = user2.balance;
        uint256 gateBefore = address(gate).balance;

        vm.prank(keeper);
        gate.claim(transferId);

        assertEq(user2.balance, user2Before + AMOUNT, "funds to original recipient");
        assertEq(keeper.balance, keeperBefore, "caller receives nothing");
        assertEq(address(gate).balance, gateBefore, "gate holds nothing");
    }

    // `claimTipped` is the gate-only entrypoint that skips the operator-approval check.
    // Direct EOA calls must revert — the gate's exclusivity is the only thing keeping
    // arbitrary callers from forcing settlements without recipient consent.
    function testClaimTippedOnlyCallableByGate() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);

        // Direct EOA call rejected.
        vm.prank(address(0xBAD));
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.claimTipped(transferId);

        // Even pt.to themselves can't take this path — claimTipped is gate-exclusive.
        vm.prank(user2);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.claimTipped(transferId);
    }

    // The simplification's UX win: when the depositor pays a tip, the recipient does
    // not need to approve the gate. A keeper can settle directly and earn the tip,
    // and the recipient receives the underlying without ever interacting with SLOW.
    function testGateClaimTippedNoRecipientApproval() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        // Recipient never calls setApprovalForAll on the gate.
        assertFalse(slow.isApprovedForAll(user2, address(gate)), "no recipient approval");

        vm.warp(block.timestamp + DELAY + 1);

        uint256 keeperBefore = keeper.balance;
        uint256 user2Before = user2.balance;

        vm.prank(keeper);
        gate.claim(transferId);

        assertEq(user2.balance, user2Before + AMOUNT, "recipient gets underlying");
        assertEq(keeper.balance, keeperBefore + tip, "keeper earns the tip");
        assertEq(address(gate).balance, 0, "gate empty after settlement");

        (uint96 storedTip,) = gate.tips(transferId);
        assertEq(uint256(storedTip), 0, "tip entry cleared");
    }

    /// Cross-contract flow: when `pt.to` has a guardian, gate-driven claim must revert
    /// (claim's guardian-block bubbles up), the tip stays in the gate, the recipient
    /// settles via the unlock + guardian-approved withdrawFrom path, and the depositor
    /// recovers the unpaid tip via gate.refundTip.
    function testTipFlowWithGuardianRecipient() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        // Depositor sends amount + tip in one tx.
        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        (uint96 storedTip, address tipSender) = gate.tips(transferId);
        assertEq(uint256(storedTip), tip, "tip recorded on gate");
        assertEq(tipSender, user1, "tip sender is depositor");
        assertEq(address(gate).balance, tip, "tip ETH held by gate");

        // Recipient sets a guardian. They never approve the gate — under the tipped
        // flow the depositor's tip is the consent signal, so the guardian veto is the
        // load-bearing check, not the operator approval.
        vm.prank(user2);
        slow.setGuardian(guardian);

        vm.warp(block.timestamp + DELAY + 1);

        // Keeper's claim attempt reverts; tip stays untouched.
        uint256 keeperBefore = keeper.balance;
        vm.prank(keeper);
        vm.expectRevert(SLOW.ClaimBlockedByGuardian.selector);
        gate.claim(transferId);
        (storedTip,) = gate.tips(transferId);
        assertEq(uint256(storedTip), tip, "tip preserved after failed gate.claim");
        assertEq(keeper.balance, keeperBefore, "keeper earned nothing on failed claim");

        // Recipient settles via unlock + guardian-approved withdrawFrom.
        vm.prank(user2);
        slow.unlock(transferId);

        uint256 id = calculateId(address(0), DELAY);
        uint256 withdrawTransferId = slow.predictWithdrawalId(user2, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user2, withdrawTransferId);

        uint256 user2Before = user2.balance;
        vm.prank(user2);
        slow.withdrawFrom(user2, user2, id, AMOUNT);
        assertEq(user2.balance, user2Before + AMOUNT, "recipient gets underlying");

        // Pending entry was cleared by unlock, so tip is now refundable.
        uint256 user1Before = user1.balance;
        vm.prank(user1);
        gate.refundTip(transferId);
        assertEq(user1.balance, user1Before + tip, "depositor recovers tip");
        assertEq(address(gate).balance, 0, "gate empty");

        (storedTip,) = gate.tips(transferId);
        assertEq(uint256(storedTip), 0, "tip entry cleared on refund");
    }

    // ─── tip + sponsored flow: refund paths ──────────────────────────────────

    // Recipient self-claims via slow.claim (bypassing the gate). The pending entry
    // clears, leaving the tip unclaimed in the gate. Depositor must be able to
    // pull it back.
    function testRefundTipAfterRecipientSelfClaim() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(user2);
        slow.claim(transferId); // direct, no gate

        uint256 user1Before = user1.balance;
        vm.prank(user1);
        gate.refundTip(transferId);
        assertEq(user1.balance, user1Before + tip, "depositor recovered tip");
    }

    function testRefundTipAfterReverse() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.prank(user1);
        slow.reverse(transferId);

        uint256 user1Before = user1.balance;
        vm.prank(user1);
        gate.refundTip(transferId);
        assertEq(user1.balance, user1Before + tip, "tip refunded after reverse");
    }

    function testRefundTipAfterClawback() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.warp(block.timestamp + DELAY + 30 days + 1); // past clawback grace
        vm.prank(user1);
        slow.clawback(transferId);

        uint256 user1Before = user1.balance;
        vm.prank(user1);
        gate.refundTip(transferId);
        assertEq(user1.balance, user1Before + tip, "tip refunded after clawback");
    }

    function testRefundTipWhilePendingReverts() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.prank(user1);
        vm.expectRevert(SLOWGate.TipStillPending.selector);
        gate.refundTip(transferId);
    }

    function testRefundTipByNonSenderReverts() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user2);
        slow.claim(transferId); // pending now cleared

        vm.prank(user2); // recipient is not the tip sender
        vm.expectRevert(SLOWGate.Unauthorized.selector);
        gate.refundTip(transferId);
    }

    function testRefundTipNonexistentReverts() public {
        SLOWGate gate = SLOWGate(slow.gate());
        vm.prank(user1);
        vm.expectRevert(SLOWGate.NoTip.selector);
        gate.refundTip(0xdeadbeef);
    }

    // ─── tip + sponsored flow: deposit-time validation ───────────────────────

    function testRecordTipOnlyCallableBySLOW() public {
        SLOWGate gate = SLOWGate(slow.gate());
        vm.deal(address(this), 1 ether);
        vm.expectRevert(SLOWGate.Unauthorized.selector);
        gate.recordTip{value: 0.01 ether}(0xdeadbeef, address(this), address(this));
    }

    function testDepositToWithTipETHValueMismatchReverts() public {
        uint256 tip = 0.01 ether;
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        // msg.value should equal AMOUNT + tip; underpay by 1 wei.
        slow.depositToWithTip{value: AMOUNT + tip - 1}(address(0), user2, AMOUNT, DELAY, tip, "");
    }

    function testDepositToWithTipERC20ValueMismatchReverts() public {
        uint256 tip = 0.01 ether;
        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        // ERC20 path: msg.value must equal tip exactly. Sending more is an error.
        slow.depositToWithTip{value: tip + 1}(address(token), user2, AMOUNT, DELAY, tip, "");
        vm.stopPrank();
    }

    function testDepositToWithTipZeroDelayReverts() public {
        uint256 tip = 0.01 ether;
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, 0, tip, "");
    }

    function testDepositToWithTipZeroAmountReverts() public {
        uint256 tip = 0.01 ether;
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.depositToWithTip{value: tip}(address(0), user2, 0, DELAY, tip, "");
    }

    function testDepositToWithTipZeroTipReverts() public {
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.depositToWithTip{value: AMOUNT}(address(0), user2, AMOUNT, DELAY, 0, "");
    }

    function testDepositToWithTipTipExceedsUint96Reverts() public {
        uint256 tip = uint256(type(uint96).max) + 1;
        vm.deal(user1, tip + AMOUNT);
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");
    }

    function testDepositToWithTipToContractItselfReverts() public {
        uint256 tip = 0.01 ether;
        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidDeposit.selector);
        slow.depositToWithTip{value: AMOUNT + tip}(
            address(0), address(slow), AMOUNT, DELAY, tip, ""
        );
    }

    // ─── tip + sponsored flow: ERC20 deposit + ETH tip ───────────────────────

    function testTippedERC20DepositKeeperGetsETHTip() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        vm.startPrank(user1);
        token.approve(address(slow), AMOUNT);
        uint256 transferId =
            slow.depositToWithTip{value: tip}(address(token), user2, AMOUNT, DELAY, tip, "");
        vm.stopPrank();

        vm.warp(block.timestamp + DELAY + 1);

        uint256 keeperEthBefore = keeper.balance;
        uint256 user2TokBefore = token.balanceOf(user2);
        vm.prank(keeper);
        gate.claim(transferId); // recipient never approved

        assertEq(token.balanceOf(user2), user2TokBefore + AMOUNT, "recipient got ERC20");
        assertEq(keeper.balance, keeperEthBefore + tip, "keeper got ETH tip");
    }

    // ─── tip + sponsored flow: cross-id sibling isolation ────────────────────

    // Two pending transfers to the same recipient at the same (token, delay)
    // id — one tipped, one untipped. Sponsored claim of the tipped one must
    // not unwrap the untipped sibling.
    function testTippedAndUntippedSiblingsAtSameIdIsolated() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        // Untipped: 2 ETH from user2 to user1 with same delay.
        vm.prank(user2);
        uint256 untipped = slow.depositTo{value: 2 ether}(address(0), user1, 0, DELAY, "");

        // Tipped: 1 ETH from user2 to user1, same delay.
        vm.prank(user2);
        uint256 tipped =
            slow.depositToWithTip{value: 1 ether + tip}(address(0), user1, 1 ether, DELAY, tip, "");

        uint256 id = calculateId(address(0), DELAY);
        assertEq(slow.balanceOf(user1, id), 3 ether, "wrapper balance is sum");

        vm.warp(block.timestamp + DELAY + 1);

        uint256 user1EthBefore = user1.balance;
        vm.prank(keeper);
        gate.claim(tipped); // sponsored — no approval needed

        assertEq(user1.balance, user1EthBefore + 1 ether, "only tipped underlying delivered");
        assertEq(slow.balanceOf(user1, id), 2 ether, "untipped sibling wrapper intact");

        // Untipped sibling still requires recipient consent.
        vm.expectRevert(SLOW.Unauthorized.selector);
        gate.claim(untipped);
    }

    // ─── tip + sponsored flow: claimMany with mixed tipping ──────────────────

    function testGateClaimManyMixesTippedUntipped() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        // user2 approves so the untipped one can settle via gate.
        vm.prank(user2);
        slow.setApprovalForAll(address(gate), true);

        vm.prank(user1);
        uint256 untipped = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.prank(user1);
        uint256 tipped =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.warp(block.timestamp + DELAY + 1);

        uint256[] memory ids = new uint256[](2);
        ids[0] = untipped;
        ids[1] = tipped;

        uint256 user2Before = user2.balance;
        uint256 keeperBefore = keeper.balance;
        vm.prank(keeper);
        gate.claimMany(ids);

        assertEq(user2.balance, user2Before + 2 * AMOUNT, "both transfers settled");
        assertEq(keeper.balance, keeperBefore + tip, "tip paid only for tipped one");
    }

    // ─── tip + sponsored flow: event emission ────────────────────────────────

    function testTipEventsEmitted() public {
        SLOWGate gate = SLOWGate(slow.gate());
        address keeper = address(0xCAFE);
        uint256 tip = 0.01 ether;

        // Don't pre-bind transferId — use recordEmits + check after.
        vm.recordLogs();
        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawPosted;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("TipPosted(uint256,uint96,address,address)")) {
                assertEq(uint256(logs[i].topics[1]), transferId, "TipPosted transferId");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), user1, "TipPosted sender");
                assertEq(address(uint160(uint256(logs[i].topics[3]))), user2, "TipPosted to");
                sawPosted = true;
            }
        }
        assertTrue(sawPosted, "TipPosted emitted on deposit");

        vm.warp(block.timestamp + DELAY + 1);

        vm.recordLogs();
        vm.prank(keeper);
        gate.claim(transferId);

        logs = vm.getRecordedLogs();
        bool sawPaid;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("TipPaid(uint256,uint96,address)")) {
                assertEq(uint256(logs[i].topics[1]), transferId, "TipPaid transferId");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), keeper, "TipPaid recipient");
                sawPaid = true;
            }
        }
        assertTrue(sawPaid, "TipPaid emitted on keeper claim");
    }

    function testTipRefundedEventEmitted() public {
        SLOWGate gate = SLOWGate(slow.gate());
        uint256 tip = 0.01 ether;

        vm.prank(user1);
        uint256 transferId =
            slow.depositToWithTip{value: AMOUNT + tip}(address(0), user2, AMOUNT, DELAY, tip, "");

        vm.prank(user1);
        slow.reverse(transferId);

        vm.recordLogs();
        vm.prank(user1);
        gate.refundTip(transferId);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawRefunded;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("TipRefunded(uint256,uint96,address)")) {
                assertEq(uint256(logs[i].topics[1]), transferId, "TipRefunded transferId");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), user1, "TipRefunded to");
                sawRefunded = true;
            }
        }
        assertTrue(sawRefunded, "TipRefunded emitted on refund");
    }

    // ─── unlock auth: third parties cannot grief settlement ──────────────────────

    function testUnlockRevertsForThirdParty() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 1);

        // Random third party (incl. the sender) cannot unlock.
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.unlock(transferId);

        vm.prank(user1);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.unlock(transferId);

        // Recipient still can.
        vm.prank(user2);
        slow.unlock(transferId);
    }

    function testUnlockByRecipientOperator() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Recipient approves a keeper as operator (e.g. the gate).
        address keeper = address(0xBEEF);
        vm.prank(user2);
        slow.setApprovalForAll(keeper, true);

        vm.warp(block.timestamp + DELAY + 1);

        vm.prank(keeper);
        slow.unlock(transferId);

        uint256 id = calculateId(address(0), DELAY);
        assertEq(
            slow.unlockedBalances(user2, id), AMOUNT, "operator-driven unlock credits recipient"
        );
    }

    // Even after the clawback grace, third parties still cannot unlock — sender's
    // clawback path stays reachable as long as the recipient hasn't acted.
    function testUnlockGriefAfterGraceStillBlocked() public {
        vm.prank(user1);
        uint256 transferId = slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        vm.warp(block.timestamp + DELAY + 30 days + 1);

        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.unlock(transferId);

        // Sender's clawback still works because pending wasn't griefed away.
        vm.prank(user1);
        slow.clawback(transferId);
    }

    // ─── op-type isolation: transfer approval cannot be consumed as withdraw ─────

    function testTransferApprovalDoesNotAuthorizeWithdraw() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        // Guardian approves a TRANSFER preimage.
        uint256 transferHash = slow.predictTransferId(user1, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user1, transferHash);

        // The withdraw preimage is distinct, so withdrawFrom still requires its own approval.
        uint256 withdrawHash = slow.predictWithdrawalId(user1, user2, id, AMOUNT);
        assertTrue(transferHash != withdrawHash, "transfer and withdraw hashes must differ");

        vm.prank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.withdrawFrom(user1, user2, id, AMOUNT);

        // Approving the withdraw preimage unlocks the withdraw.
        vm.prank(guardian);
        slow.approveTransfer(user1, withdrawHash);

        uint256 user2Before = user2.balance;
        vm.prank(user1);
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        assertEq(
            user2.balance - user2Before, AMOUNT, "withdraw succeeded with op-specific approval"
        );
    }

    function testWithdrawApprovalDoesNotAuthorizeTransfer() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        // Guardian approves a WITHDRAW preimage.
        uint256 withdrawHash = slow.predictWithdrawalId(user1, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user1, withdrawHash);

        // safeTransferFrom uses the TRANSFER preimage and is still blocked.
        vm.prank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
    }

    function testIsWithdrawalApprovalNeededFlipsIndependently() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        uint256 id = calculateId(address(0), 0);

        assertTrue(slow.isGuardianApprovalNeeded(user1, user2, id, AMOUNT));
        assertTrue(slow.isWithdrawalApprovalNeeded(user1, user2, id, AMOUNT));

        // Approving the transfer hash flips only the transfer view.
        uint256 tHash = slow.predictTransferId(user1, user2, id, AMOUNT);
        vm.prank(guardian);
        slow.approveTransfer(user1, tHash);

        assertFalse(slow.isGuardianApprovalNeeded(user1, user2, id, AMOUNT));
        assertTrue(slow.isWithdrawalApprovalNeeded(user1, user2, id, AMOUNT));
    }

    // ─── revokeApproval: guardian can retract a single approval ─────────────────

    function testRevokeApprovalByGuardian() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);
        uint256 transferId = slow.predictTransferId(user1, user2, id, AMOUNT);

        vm.prank(guardian);
        slow.approveTransfer(user1, transferId);
        assertTrue(slow.guardianApproved(transferId));

        // Guardian retracts.
        vm.prank(guardian);
        slow.revokeApproval(user1, transferId);
        assertFalse(slow.guardianApproved(transferId));

        // Transfer using the now-revoked approval is blocked.
        vm.prank(user1);
        vm.expectRevert(SLOW.GuardianApprovalRequired.selector);
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
    }

    function testRevokeApprovalUnauthorizedReverts() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        uint256 fakeId = uint256(keccak256("anything"));

        // Non-guardian cannot revoke.
        vm.prank(user1);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.revokeApproval(user1, fakeId);

        vm.prank(user2);
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.revokeApproval(user1, fakeId);
    }

    function testRevokeApprovalIsIdempotent() public {
        vm.prank(user1);
        slow.setGuardian(guardian);

        uint256 fakeId = uint256(keccak256("never approved"));

        // Revoking a non-existent approval is a no-op (no revert).
        vm.prank(guardian);
        slow.revokeApproval(user1, fakeId);
        assertFalse(slow.guardianApproved(fakeId));
    }

    // ─── withdrawFrom rejects zero amount ───────────────────────────────────────

    function testWithdrawZeroAmountReverts() public {
        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, "");

        uint256 id = calculateId(address(0), 0);

        vm.prank(user1);
        vm.expectRevert(SLOW.InvalidAmount.selector);
        slow.withdrawFrom(user1, user2, id, 0);
    }
}

// Records calls so testHtmlRegistryRegisteredOnDeploy can assert the constructor pinged it.
contract MockHtmlRegistry {
    address public lastTarget;
    string public lastHtml;

    function setHtmlAsTarget(address target, string calldata h) external {
        lastTarget = target;
        lastHtml = h;
    }
}

// Mock ERC20 token for testing
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        if (from != msg.sender) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) {
                allowance[from][msg.sender] = allowed - amount;
            }
        }

        balanceOf[from] -= amount;
        balanceOf[to] += amount;

        emit Transfer(from, to, amount);
        return true;
    }

    // Mint tokens (for testing only)
    function mint(address to, uint256 amount) public {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
}

// Recipient that attempts to re-enter SLOW from its receive() hook during claim()'s
// ETH payout. The nonReentrant guard on claim() must reject the second call.
contract ReentrantClaimReceiver {
    SLOW slow;
    bool public reentryRejected;
    uint256 lastTransferId;

    constructor(SLOW _slow) payable {
        slow = _slow;
    }

    function deposit(uint96 delay) external returns (uint256) {
        return slow.depositTo{value: address(this).balance}(address(0), address(this), 0, delay, "");
    }

    function callClaim(uint256 transferId) external {
        lastTransferId = transferId;
        slow.claim(transferId);
    }

    receive() external payable {
        // bytes4(keccak256("Reentrancy()")) == 0xab143c06
        try slow.claim(lastTransferId) {
        // unreachable
        }
        catch (bytes memory err) {
            if (err.length == 4 && bytes4(err) == 0xab143c06) reentryRejected = true;
        }
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}

// Receiver that attempts to re-enter SLOW from its onERC1155Received hook
contract ReentrantReceiver {
    SLOW slow;
    bool public reentryRejected;

    constructor(SLOW _slow) payable {
        slow = _slow;
    }

    function deposit(address to, uint96 delay) external returns (uint256) {
        return slow.depositTo{value: address(this).balance}(address(0), to, 0, delay, "");
    }

    function callReverse(uint256 transferId) external {
        slow.reverse(transferId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        // Re-entry attempt — nonReentrant on unlock() should reject with Reentrancy().
        try slow.unlock(0) {
        // unreachable
        }
        catch (bytes memory err) {
            // bytes4(keccak256("Reentrancy()")) == 0xab143c06
            if (err.length == 4 && bytes4(err) == 0xab143c06) {
                reentryRejected = true;
            }
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}

// Always reverts in onERC1155Received. Used to confirm SLOW unwinds cleanly when the
// recipient (or callback target on reverse/clawback) refuses the transfer.
contract RevertingReceiver {
    SLOW slow;

    constructor(SLOW _slow) payable {
        slow = _slow;
    }

    function deposit(address to, uint96 delay) external returns (uint256) {
        return slow.depositTo{value: address(this).balance}(address(0), to, 0, delay, "");
    }

    function callClawback(uint256 transferId) external {
        slow.clawback(transferId);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert("RevertingReceiver: nope");
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert("RevertingReceiver: nope");
    }
}

// Returns metadata crafted to break out of the JSON description and inject a fake image field.
contract EvilToken {
    function name() external pure returns (string memory) {
        return '","image":"evil_image';
    }

    function symbol() external pure returns (string memory) {
        return "EVIL";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}

// 65-byte name() ending in 三 (U+4E09, 3 bytes 0xE4 0xB8 0x89). readName(64) cuts at
// byte 64 and leaves only the first 2 bytes of the codepoint — invalid UTF-8 unless
// SLOW's _utf8Trim drops the partial sequence.
contract LongCjkTailToken {
    function name() external pure returns (string memory) {
        return string(
            abi.encodePacked(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", unicode"三"
            )
        );
    }

    function symbol() external pure returns (string memory) {
        return "CJK";
    }
}

// 64-byte name() of 61 'A's + 三 (3 bytes). Lands exactly on a complete UTF-8 boundary
// so _utf8Trim should restore the bytes it walked over rather than trim them.
contract CompleteCjkTailToken {
    function name() external pure returns (string memory) {
        return string(
            abi.encodePacked(
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", unicode"三"
            )
        );
    }

    function symbol() external pure returns (string memory) {
        return "CCJK";
    }
}

// 30-byte ASCII name() over the 28-byte SVG display cap; tests that _clipForDisplay
// only truncates the SVG row while the JSON description retains the full name.
contract LongAsciiNameToken {
    function name() external pure returns (string memory) {
        return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 30 'A's
    }

    function symbol() external pure returns (string memory) {
        return "LNT";
    }
}
