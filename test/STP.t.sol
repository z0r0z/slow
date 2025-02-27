// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.19;

import {STP} from "../src/STP.sol";
import {Test} from "../lib/forge-std/src/Test.sol";

contract STPTest is Test {
    STP internal stp;
    MockERC20 internal token;

    address internal owner;
    address internal user1;
    address internal user2;
    address internal guardian;

    uint256 internal constant AMOUNT = 1 ether;
    uint96 internal constant DELAY = 1 days;

    event TransferApproved(
        address indexed guardian, address indexed user, bytes32 indexed transferId
    );
    event GuardianSet(address indexed user, address indexed guardian);
    event Transferred(bytes32 indexed transferId);

    function setUp() public payable {
        stp = new STP();
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

        bytes32 expectedTransferId = keccak256(
            abi.encodePacked(user1, user2, uint256(0) | (DELAY << 160), AMOUNT, uint256(0))
        );

        vm.expectEmit(true, true, true, true);
        emit Transferred(expectedTransferId);

        stp.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");

        assertEq(stp.balanceOf(user2, uint256(0) | (DELAY << 160)), AMOUNT);

        vm.stopPrank();
    }

    // Test ERC20 deposit
    function testDepositERC20() public {
        vm.startPrank(user1);

        uint256 id = uint256(uint160(address(token))) | (DELAY << 160);
        bytes32 expectedTransferId =
            keccak256(abi.encodePacked(user1, user2, id, AMOUNT, uint256(0)));

        token.approve(address(stp), AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit Transferred(expectedTransferId);

        stp.depositTo(address(token), user2, AMOUNT, DELAY, "");

        assertEq(stp.balanceOf(user2, id), AMOUNT);
        assertEq(token.balanceOf(address(stp)), AMOUNT);

        vm.stopPrank();
    }

    // Test timelock restrictions
    function testTimelockRestrictions() public {
        // Setup - deposit with delay
        vm.startPrank(user1);
        stp.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = uint256(0) | (DELAY << 160);

        // Try to transfer before delay expires - should fail
        vm.startPrank(user1);
        vm.expectRevert(STP.Timelocked.selector);
        stp.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Now transfer should succeed
        vm.startPrank(user1);
        stp.safeTransferFrom(user1, user2, id, AMOUNT, "");
        assertEq(stp.balanceOf(user1, id), 0);
        assertEq(stp.balanceOf(user2, id), AMOUNT);
        vm.stopPrank();
    }

    // Test guardian setup
    function testSetGuardian() public {
        vm.startPrank(user1);

        vm.expectEmit(true, true, true, true);
        emit GuardianSet(user1, guardian);

        stp.setGuardian(guardian);
        assertEq(stp.guardians(user1), guardian);

        vm.stopPrank();
    }

    // Test guardian cooldown
    function testGuardianCooldown() public {
        vm.startPrank(user1);

        // Set guardian first time
        stp.setGuardian(guardian);

        // Try to change guardian immediately - should fail
        vm.expectRevert(STP.GuardianCooldownNotElapsed.selector);
        stp.setGuardian(address(0x4));

        // Advance time past cooldown
        vm.warp(block.timestamp + 1 days + 1);

        // Now should succeed
        stp.setGuardian(address(0x4));
        assertEq(stp.guardians(user1), address(0x4));

        vm.stopPrank();
    }

    // Test guardian approval flow
    function testGuardianApproval() public {
        // Setup - set guardian and deposit
        vm.prank(user1);
        stp.setGuardian(guardian);

        vm.prank(user1);
        stp.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");

        uint256 id = uint256(0) | (DELAY << 160);

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Calculate the transferId with nonce = 1 (after deposit)
        bytes32 transferId = keccak256(abi.encodePacked(user1, user2, id, AMOUNT, uint256(1)));

        // Try to transfer without guardian approval - should fail
        vm.startPrank(user1);
        vm.expectRevert(STP.GuardianApprovalRequired.selector);
        stp.safeTransferFrom(user1, user2, id, AMOUNT, "");
        vm.stopPrank();

        // Guardian approves using the new function signature
        vm.startPrank(guardian);
        vm.expectEmit(true, true, true, true);
        emit TransferApproved(guardian, user1, transferId); // Updated event parameters
        stp.approveTransfer(user1, transferId); // New function signature with from address first
        vm.stopPrank();

        // Now transfer should succeed
        vm.startPrank(user1);
        stp.safeTransferFrom(user1, user2, id, AMOUNT, "");
        assertEq(stp.balanceOf(user1, id), 0);
        assertEq(stp.balanceOf(user2, id), AMOUNT);
        vm.stopPrank();
    }

    // Test transfer reversal
    function testReversal() public {
        // Setup - deposit with delay
        vm.startPrank(user1);

        bytes32 transferId = keccak256(
            abi.encodePacked(user1, user2, uint256(0) | (DELAY << 160), AMOUNT, uint256(0))
        );

        stp.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = uint256(0) | (DELAY << 160);

        // Reverse within delay period - caller must be original sender
        vm.prank(user1);
        stp.reverse(transferId);

        // Check balances after reversal
        assertEq(stp.balanceOf(user2, id), 0);
        assertEq(stp.balanceOf(user1, id), AMOUNT);
    }

    // Test reversal after delay expired
    function testReversalAfterDelay() public {
        // Setup - deposit with delay
        vm.startPrank(user1);

        bytes32 transferId = keccak256(
            abi.encodePacked(user1, user2, uint256(0) | (DELAY << 160), AMOUNT, uint256(0))
        );

        stp.depositTo{value: AMOUNT}(address(0), user2, 0, DELAY, "");
        vm.stopPrank();

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Try to reverse after delay - should fail
        vm.startPrank(user1);
        vm.expectRevert(STP.TransferFinalized.selector);
        stp.reverse(transferId);
        vm.stopPrank();
    }

    // Test withdrawal
    function testWithdrawal() public {
        // Setup - deposit ETH
        vm.startPrank(user1);
        stp.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");
        vm.stopPrank();

        uint256 id = uint256(0) | (DELAY << 160);

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Withdraw
        uint256 balanceBefore = user2.balance;

        vm.startPrank(user1);
        stp.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check results
        assertEq(user2.balance, balanceBefore + AMOUNT);
        assertEq(stp.balanceOf(user1, id), 0);
    }

    // Test withdrawal with guardian
    function testWithdrawalWithGuardian() public {
        // Setup - set guardian and deposit
        vm.prank(user1);
        stp.setGuardian(guardian);

        vm.prank(user1);
        stp.depositTo{value: AMOUNT}(address(0), user1, 0, DELAY, "");

        uint256 id = uint256(0) | (DELAY << 160);

        // Advance time past delay
        vm.warp(block.timestamp + DELAY + 1);

        // Current nonce after deposit is 1
        uint256 currentNonce = 1;

        // Calculate the transferId that will be used on withdrawal
        bytes32 transferId = keccak256(abi.encodePacked(user1, user2, id, AMOUNT, currentNonce));

        // Try to withdraw without guardian approval - should fail
        vm.startPrank(user1);
        vm.expectRevert(STP.GuardianApprovalRequired.selector);
        stp.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Since transaction reverted, nonce doesn't increment
        // Guardian approves with the original transferId, providing the from address
        vm.prank(guardian);
        stp.approveTransfer(user1, transferId);

        // Now withdrawal should succeed
        uint256 balanceBefore = user2.balance;

        vm.startPrank(user1);
        stp.withdrawFrom(user1, user2, id, AMOUNT);
        vm.stopPrank();

        // Check results
        assertEq(user2.balance, balanceBefore + AMOUNT);
        assertEq(stp.balanceOf(user1, id), 0);
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
