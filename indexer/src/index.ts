import { ponder } from "ponder:registry";
import {
  user,
  token,
  balance,
  transfer,
  guardianSetEvent,
  transferApprovedEvent,
  unlockEvent,
} from "ponder:schema";
import { erc20Abi, zeroAddress } from "viem";

ponder.on("SLOW:GuardianSet", async ({ event, context }) => {
  // Event args: user (address), guardian (address)
  const { user: userAddress, guardian } = event.args;

  await context.db
    .insert(user)
    .values({
      id: userAddress,
      guardian: guardian,
      lastGuardianChange: BigInt(event.block.timestamp),
      nonce: 0n,
    })
    .onConflictDoUpdate({
      guardian: guardian,
      lastGuardianChange: BigInt(event.block.timestamp),
    });

  // Also record this as a guardian event
  await context.db.insert(guardianSetEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    userAddress: userAddress,
    guardianAddress: guardian,
  });
});

ponder.on("SLOW:TransferApproved", async ({ event, context }) => {
  // Event args: guardian (address), user (address), transferId (uint256)
  const { guardian, user: userAddress, transferId } = event.args;

  await context.db
    .update(transfer, {
      id: transferId,
    })
    .set({ status: "APPROVED" });

  // Record this as a guardian approval event
  await context.db.insert(transferApprovedEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    userAddress: userAddress,
    guardianAddress: guardian,
    transferId: transferId,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
  });
});

ponder.on("SLOW:TransferPending", async ({ event, context }) => {
  // Event args: transferId (uint256), delay (uint256)
  const { transferId, delay } = event.args;
  const client = context.client;
  const { SLOW } = context.contracts;

  const pendingTransfer = await client.readContract({
    address: SLOW.address,
    abi: SLOW.abi,
    functionName: "pendingTransfers",
    args: [transferId],
  });
  const [timestamp, from, to, tokenId, amount] = pendingTransfer;

  await context.db.insert(transfer).values({
    id: transferId,
    fromAddress: from,
    toAddress: to,
    tokenId: tokenId,
    amount: amount,
    status: "PENDING",
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
  });

  await context.db
    .insert(balance)
    .values({
      userAddress: from,
      tokenId: tokenId,
      unlockedBalance: BigInt(0) - BigInt(amount),
      totalBalance: BigInt(0),
    })
    .onConflictDoUpdate((row) => ({
      unlockedBalance: (row.unlockedBalance ?? 0n) - BigInt(amount),
    }));

  const [tokenAddress, delaySeconds] = await client.readContract({
    abi: SLOW.abi,
    address: SLOW.address,
    functionName: "decodeId",
    args: [tokenId],
  });

  // insert token if does not exist
  let name, symbol, decimals;
  if (tokenAddress !== zeroAddress) {
    name = await client.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "name",
    });
    symbol = await client.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "symbol",
    });
    decimals = await client.readContract({
      abi: erc20Abi,
      address: tokenAddress,
      functionName: "decimals",
    });
  } else {
    // ETH
    name = "Ether";
    symbol = "ETH";
    decimals = 18;
  }
  await context.db
    .insert(token)
    .values({
      id: tokenId,
      tokenAddress,
      decimals,
      delaySeconds,
      tokenName: name,
      tokenSymbol: symbol,
    })
    .onConflictDoNothing();
});

ponder.on("SLOW:TransferSingle", async ({ event, context }) => {
  // Event args: operator (address), from (address), to (address), id (uint256), amount (uint256)
  const { from, to, id, amount } = event.args;
  const tokenId = id;

  const client = context.client;
  const { SLOW } = context.contracts;

  const transferId = await client.readContract({
    abi: SLOW.abi,
    address: SLOW.address,
    functionName: "predictTransferId",
    args: [from, to, tokenId, amount],
  });

  // Only set the status to TRANSFERRED if it is a SLOW burn (to address is zero address)
  const status =
    to === "0x0000000000000000000000000000000000000000"
      ? "TRANSFERRED"
      : undefined;

  await context.db
    .insert(transfer)
    .values({
      id: transferId,
      fromAddress: from,
      toAddress: to,
      tokenId: tokenId,
      amount: amount,
      status: status,
      blockNumber: BigInt(event.block.number),
      transactionHash: event.transaction.hash,
      timestamp: BigInt(event.block.timestamp),
    })
    .onConflictDoUpdate(status ? { status } : {});

  // Mint SLOW
  if (from !== "0x0000000000000000000000000000000000000000") {
    const fromBalanceExists = await context.db.find(balance, {
      userAddress: from,
      tokenId: tokenId,
    });

    if (fromBalanceExists) {
      await context.db
        .update(balance, { userAddress: from, tokenId: tokenId })
        .set((row) => ({
          totalBalance: (row.totalBalance || BigInt(0)) - BigInt(amount),
          unlockedBalance: (row.unlockedBalance || BigInt(0)) - BigInt(amount),
        }));
    }
  }

  // Burn SLOW
  if (to !== "0x0000000000000000000000000000000000000000") {
    const toBalanceExists = await context.db.find(balance, {
      userAddress: to,
      tokenId: tokenId,
    });

    if (toBalanceExists) {
      await context.db
        .update(balance, { userAddress: to, tokenId: tokenId })
        .set((row) => ({
          totalBalance: (row.totalBalance || BigInt(0)) + BigInt(amount),
          unlockedBalance: (row.unlockedBalance || BigInt(0)) + BigInt(amount),
        }));
    } else {
      await context.db.insert(balance).values({
        userAddress: to,
        tokenId: tokenId,
        totalBalance: BigInt(amount),
        unlockedBalance: BigInt(amount),
      });
    }
  }
});

ponder.on("SLOW:URI", async ({ event, context }) => {
  // Event args: value (string), id (uint256)
  const { id } = event.args;

  const tokenId = id.toString();
  const existingToken = await context.db.find(token, { id: tokenId });
  if (existingToken) {
    await context.db
      .update(token, { id: tokenId })
      .set({ uri: event.args.value });
  }
});

ponder.on("SLOW:Unlocked", async ({ event, context }) => {
  // Event args: user (address), id (uint256), amount (uint256)
  const { user: userAddress, id: tokenId, amount } = event.args;

  await context.db.insert(unlockEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    userAddress: userAddress,
    tokenId: tokenId,
    amount: amount,
    transferId: 0n, // Default value as it's not available in the event
  });

  await context.db
    .insert(balance)
    .values({
      userAddress: userAddress,
      tokenId: tokenId,
      totalBalance: BigInt(amount),
      unlockedBalance: BigInt(amount),
    })
    .onConflictDoUpdate((row) => ({
      totalBalance: (row.totalBalance ?? 0n) + BigInt(amount),
      unlockedBalance: (row.unlockedBalance ?? 0n) + BigInt(amount),
    }));
});
