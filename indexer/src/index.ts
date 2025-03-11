import { ponder } from "ponder:registry";
import {
  users,
  tokens,
  balances,
  transfers,
  guardianSetEvents,
  transferApprovedEvents,
  unlockEvents,
} from "ponder:schema";

ponder.on("SLOW:GuardianSet", async ({ event, context }) => {
  // Event args: user (address), guardian (address)
  const { user, guardian } = event.args;

  await context.db
    .insert(users)
    .values({
      id: user,
      guardian: guardian,
      lastGuardianChange: BigInt(event.block.timestamp),
    })
    .onConflictDoUpdate({
      guardian: guardian,
      lastGuardianChange: BigInt(event.block.timestamp),
    });

  // Also record this as a guardian event
  await context.db.insert(guardianSetEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    userAddress: user,
    guardianAddress: guardian,
  });
});

ponder.on("SLOW:TransferApproved", async ({ event, context }) => {
  // Event args: guardian (address), user (address), transferId (uint256)
  const { guardian, user, transferId } = event.args;

  await context.db
    .update(transfers, {
      id: transferId,
    })
    .set({ status: "APPROVED" });

  // Record this as a guardian approval event
  await context.db.insert(transferApprovedEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    userAddress: user,
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

  await context.db.insert(transfers).values({
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
    .insert(balances)
    .values({
      userAddress: from,
      tokenId: tokenId,
      unlockedBalance: BigInt(0) - BigInt(amount),
      totalBalance: BigInt(0),
    })
    .onConflictDoUpdate((row) => ({
      unlockedBalance: (row.unlockedBalance ?? 0n) - BigInt(amount),
    }));
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
  await context.db.insert(transfers).values({
    id: transferId,
    fromAddress: from,
    toAddress: to,
    tokenId: tokenId,
    amount: amount,
    status: "TRANSFERRED",
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
  });

  // Update balances
  // For the sender
  if (from !== "0x0000000000000000000000000000000000000000") {
    const fromBalanceExists = await context.db.find(balances, {
      userAddress: from,
      tokenId: tokenId,
    });

    if (fromBalanceExists) {
      await context.db
        .update(balances, { userAddress: from, tokenId: tokenId })
        .set((row) => ({
          totalBalance: (row.totalBalance || BigInt(0)) - BigInt(amount),
          unlockedBalance: (row.unlockedBalance || BigInt(0)) - BigInt(amount),
        }));
    }
  }

  // For the receiver
  if (to !== "0x0000000000000000000000000000000000000000") {
    const toBalanceExists = await context.db.find(balances, {
      userAddress: to,
      tokenId: tokenId,
    });

    if (toBalanceExists) {
      await context.db
        .update(balances, { userAddress: to, tokenId: tokenId })
        .set((row) => ({
          totalBalance: (row.totalBalance || BigInt(0)) + BigInt(amount),
          unlockedBalance: (row.unlockedBalance || BigInt(0)) + BigInt(amount),
        }));
    } else {
      await context.db.insert(balances).values({
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
  const existingToken = await context.db.find(tokens, { id: tokenId });
  if (existingToken) {
    await context.db
      .update(tokens, { id: tokenId })
      .set({ uri: event.args.value });
  }
});

ponder.on("SLOW:Unlocked", async ({ event, context }) => {
  // Event args: user (address), id (uint256), amount (uint256)
  const { user, id: tokenId, amount } = event.args;

  await context.db.insert(unlockEvents).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    userAddress: user,
    tokenId: tokenId,
    amount: amount,
  });

  await context.db
    .insert(balances)
    .values({
      userAddress: user,
      tokenId: tokenId,
      totalBalance: BigInt(amount),
      unlockedBalance: BigInt(amount),
    })
    .onConflictDoUpdate((row) => ({
      totalBalance: (row.totalBalance ?? 0n) + BigInt(amount),
      unlockedBalance: (row.unlockedBalance ?? 0n) + BigInt(amount),
    }));
});
