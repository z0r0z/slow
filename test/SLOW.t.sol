// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {SLOW} from "../src/SLOW.sol";
import {Test, Vm} from "../lib/forge-std/src/Test.sol";
import {console} from "forge-std/console.sol";

contract SLOWTest is Test {
    SLOW internal slow;
    MockERC20 internal token;

    address internal owner;
    address internal user1;
    address internal user2;
    address internal guardian;

    uint256 internal constant AMOUNT = 1 ether;
    uint96 internal constant DELAY = 1 days;

    event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount);
    event TransferApproved(
        address indexed guardian, address indexed user, uint256 indexed transferId
    );
    event GuardianSet(address indexed user, address indexed guardian);
    event Transferred(uint256 indexed transferId);

    function setUp() public payable {
        vm.createSelectFork(vm.rpcUrl("main")); // Ethereum mainnet fork.
        slow = new SLOW();
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

    // Test ETH deposit
    function testDepositETH() public {
        vm.startPrank(user1);

        // Perform the deposit and capture the transfer ID
        slow.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        // Check if the deposit was successful
        uint256 id = uint256(0) | (DELAY << 160);
        assertEq(slow.balanceOf(user2, id), AMOUNT);

        // Check that balance is locked
        assertEq(slow.unlockedBalances(user2, id), 0);
        assertEq(slow.lockedBalances(user2, id, block.timestamp + DELAY), AMOUNT);

        vm.stopPrank();
    }

    // Test zero delay ETH deposit
    function testDepositETHZeroDelay() public {
        vm.startPrank(user1);

        uint256 id = uint256(uint160(address(0))); // ID with zero delay

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
        uint256 id = uint256(uint160(_token)) | (delay << 160);
        string memory uri = slow.uri(id);
        console.log(uri);
    }

    // Test ERC20 deposit
    function testDepositERC20() public {
        vm.startPrank(user1);

        uint256 id = uint256(uint160(address(token))) | (DELAY << 160);

        token.approve(address(slow), AMOUNT);

        // Perform the deposit
        slow.depositTo(address(token), user2, AMOUNT, DELAY, "");

        assertEq(slow.balanceOf(user2, id), AMOUNT);
        assertEq(token.balanceOf(address(slow)), AMOUNT);

        // Check that balance is locked
        assertEq(slow.unlockedBalances(user2, id), 0);
        assertEq(slow.lockedBalances(user2, id, block.timestamp + DELAY), AMOUNT);

        vm.stopPrank();
    }

    // Test unlocking process
    function testUnlock() public {
        // Setup - deposit with delay
        vm.startPrank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = uint256(0) | (DELAY << 160);
        uint96 unlockTime = uint96(block.timestamp + DELAY);

        // Verify it's locked
        assertEq(slow.lockedBalances(user1, id, unlockTime), AMOUNT);
        assertEq(slow.unlockedBalances(user1, id), 0);

        // Try to unlock before time - should revert
        vm.startPrank(user1);
        vm.expectRevert(SLOW.TimelockNotExpired.selector);
        slow.unlock(id, unlockTime);
        vm.stopPrank();

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Now unlock should succeed
        vm.startPrank(user1);
        vm.expectEmit(true, true, true, false);
        emit Unlocked(user1, id, AMOUNT);
        slow.unlock(id, unlockTime);
        vm.stopPrank();

        // Check balances after unlock
        assertEq(slow.lockedBalances(user1, id, unlockTime), 0);
        assertEq(slow.unlockedBalances(user1, id), AMOUNT);
    }

    // Test unlocking multiple deposits with same timelock
    function testUnlockMultipleDeposits() public {
        uint256 firstAmount = 0.5 ether;
        uint256 secondAmount = 0.5 ether;
        uint256 id = uint256(0) | (DELAY << 160);

        // First deposit
        vm.startPrank(user1);
        slow.depositTo{value: firstAmount}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        // Record the unlock time
        uint96 unlockTime = uint96(block.timestamp + DELAY);

        // Second deposit at the same time
        vm.startPrank(user1);
        slow.depositTo{value: secondAmount}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        // Verify both amounts are locked at the same timestamp
        assertEq(slow.lockedBalances(user1, id, unlockTime), AMOUNT); // 0.5 + 0.5 = 1.0 ether

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Unlock both deposits at once
        vm.startPrank(user1);
        slow.unlock(id, unlockTime);
        vm.stopPrank();

        // Check unlocked balance has both deposits
        assertEq(slow.unlockedBalances(user1, id), AMOUNT);
    }

    // Test transfer with locked and unlocked balances
    function testTransferLockedUnlocked() public {
        // Setup - deposit with delay
        vm.startPrank(user1);

        // We need to construct the ID correctly with delay embedded
        uint256 id = uint256(0) | (DELAY << 160);
        console.log("ID value:", id);
        console.log("Delay extracted from ID:", id >> 160);

        slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        // Advance time past delay
        uint256 unlockTime = block.timestamp + DELAY;
        vm.warp(unlockTime + 1);

        // Unlock the balance
        vm.startPrank(user1);
        slow.unlock(id, uint96(unlockTime));

        // Save the current timestamp before transfer
        uint256 transferTime = block.timestamp;

        // Now transfer should succeed
        slow.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Check balances after transfer
        assertEq(slow.balanceOf(user1, id), 0);
        assertEq(slow.balanceOf(user2, id), AMOUNT);

        // Since the delay comes from the ID itself, check recipient's unlocked/locked balances
        if (id >> 160 != 0) {
            // If there's a delay in the ID, it should be in locked balances
            assertEq(slow.lockedBalances(user2, id, transferTime + (id >> 160)), AMOUNT);
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
        uint256 zeroDelayId = uint256(uint160(address(0))); // ID with zero delay
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
        uint256 zeroDelayId = uint256(uint160(address(0)));
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

        uint256 idWithoutDelay = uint256(0) | (DELAY << 160);

        // Reverse within delay period
        vm.prank(user1);
        slow.reverse(transferId);

        // Check balances after reversal
        assertEq(slow.balanceOf(user2, idWithoutDelay), 0);
        assertEq(slow.balanceOf(user1, idWithoutDelay), AMOUNT);
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

        uint256 id = uint256(0) | (DELAY << 160);

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
        vm.expectRevert(SLOW.TransferFinalized.selector);
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

    // Test removing guardian
    function testRemoveGuardian() public {
        // First set a guardian
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Wait for cooldown
        vm.warp(block.timestamp + 1 days + 1);

        // Remove the guardian
        vm.prank(user1);
        slow.setGuardian(address(0));

        // Verify guardian is removed
        assertEq(slow.guardians(user1), address(0));
    }

    // Test guardian cooldown
    function testGuardianCooldown() public {
        vm.startPrank(user1);

        // Set guardian first time
        slow.setGuardian(guardian);

        // Try to change guardian immediately - should fail
        vm.expectRevert(SLOW.GuardianCooldownNotElapsed.selector);
        slow.setGuardian(address(0x4));

        // Advance time past cooldown
        vm.warp(block.timestamp + 1 days + 1);

        // Now should succeed
        slow.setGuardian(address(0x4));
        assertEq(slow.guardians(user1), address(0x4));

        vm.stopPrank();
    }

    // Test guardian approval flow for transfers
    function testGuardianApproval() public {
        // Setup - set guardian and deposit
        vm.prank(user1);
        slow.setGuardian(guardian);

        vm.prank(user1);
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, 0, ""); // Using zero delay for simplicity

        uint256 id = uint256(uint160(address(0))); // Zero delay ID

        // Calculate the expected transferId - need to get nonce first
        uint256 currentNonce = slow.nonces(user1);
        uint256 transferId =
            uint256(keccak256(abi.encodePacked(user1, user2, id, AMOUNT, currentNonce + 1)));

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

    // Test unauthorized guardian approval attempt
    function testUnauthorizedGuardianApproval() public {
        // Setup - set guardian
        vm.prank(user1);
        slow.setGuardian(guardian);

        // Get current nonce
        uint256 currentNonce = slow.nonces(user1);

        // Calculate a transferId
        uint256 id = uint256(uint160(address(0)));
        uint256 transferId =
            uint256(keccak256(abi.encodePacked(user1, user2, id, AMOUNT, currentNonce + 1)));

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

        uint256 id = uint256(uint160(address(0)));

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
        slow.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = uint256(0) | (DELAY << 160);

        // Try to withdraw without unlocking - should revert with underflow
        vm.startPrank(user1);
        vm.expectRevert(); // Will fail with underflow
        slow.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Advance time and unlock
        vm.warp(block.timestamp + DELAY + 1);
        vm.prank(user1);
        slow.unlock(id, uint96(block.timestamp - 1));

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

        uint256 id = uint256(uint160(address(0)));

        // Get current nonce
        uint256 currentNonce = slow.nonces(user1);

        // Calculate the transferId that will be used on withdrawal
        uint256 withdrawalTransferId =
            uint256(keccak256(abi.encodePacked(user1, user2, id, AMOUNT, currentNonce + 1)));

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

        uint256 id = uint256(uint160(address(token)));

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

        uint256 id = uint256(0) | (DELAY << 160);

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
        ids[0] = uint256(uint160(address(0)));

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = AMOUNT;

        // Batch transfer should revert
        vm.expectRevert(SLOW.Unauthorized.selector);
        slow.safeBatchTransferFrom(user1, user2, ids, amounts, "");
        vm.stopPrank();
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
