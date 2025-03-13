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
import { decodeFunctionData, erc20Abi, zeroAddress } from "viem";

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
  const [_, from, to, tokenId, amount] = pendingTransfer;

  const approvalRequired = await client.readContract({
    address: SLOW.address,
    abi: SLOW.abi,
    functionName: "isGuardianApprovalNeeded",
    args: [from, to, tokenId, amount],
  });

  const fromNonce = await client.readContract({
    address: SLOW.address,
    abi: SLOW.abi,
    functionName: "nonces",
    args: [from],
  });

  const toNonce = await client.readContract({
    address: SLOW.address,
    abi: SLOW.abi,
    functionName: "nonces",
    args: [to],
  });

  // Ensure user records exist for both sender and receiver
  await context.db
    .insert(user)
    .values({
      id: from,
      guardian: "0x0000000000000000000000000000000000000000",
      lastGuardianChange: 0n,
      nonce: fromNonce,
    })
    .onConflictDoUpdate({
      nonce: fromNonce,
    });

  await context.db
    .insert(user)
    .values({
      id: to,
      guardian: "0x0000000000000000000000000000000000000000",
      lastGuardianChange: 0n,
      nonce: toNonce,
    })
    .onConflictDoUpdate({
      nonce: toNonce,
    });

  const expiryTimestamp = BigInt(event.block.timestamp) + BigInt(delay);

  // insert `transfer` record
  await context.db.insert(transfer).values({
    id: transferId,
    fromAddress: from,
    toAddress: to,
    tokenId: tokenId,
    amount: amount,
    expiryTimestamp,
    status: approvalRequired ? "APPROVAL_REQUIRED" : "PENDING",
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
  });

  const [tokenAddress, delaySeconds] = await client.readContract({
    abi: SLOW.abi,
    address: SLOW.address,
    functionName: "decodeId",
    args: [tokenId],
  });

  let name, symbol, decimals;
  if (tokenAddress != zeroAddress) {
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
      address: tokenAddress,
      decimals,
      delaySeconds,
      name: name,
      symbol: symbol,
    })
    .onConflictDoNothing();
});

ponder.on("SLOW:TransferSingle", async ({ event, context }) => {
  // Extract event args
  const { from, to, id, amount } = event.args;
  const {
    db,
    client,
    contracts: { SLOW },
  } = context;

  // Determine transaction type
  const isMint = from === "0x0000000000000000000000000000000000000000";
  const isBurn = to === "0x0000000000000000000000000000000000000000";

  // For actual transfers (not mints/burns), track the transferId
  if (!isMint && !isBurn) {
    const { functionName, args } = decodeFunctionData({
      abi: SLOW.abi,
      data: event.transaction.input,
    });

    let status = null;
    let transferId = null;
    if (functionName === "multicall") {
      const calls = args[0];
      for (const call of calls) {
        const decoded = decodeFunctionData({
          abi: SLOW.abi,
          data: call,
        });

        // note: having both reverse and unlock in same multicall batch is not possible as reverse will revert if unlockable and unlock will revert if reverseable
        if (decoded.functionName === "unlock") {
          status = "UNLOCKED";
          transferId = decoded.args[0];
        } else if (decoded.functionName === "reverse") {
          status = "REVERSED";
          transferId = decoded.args[0];
        }
      }
    } else if (functionName === "unlock") {
      status = "UNLOCKED";
    } else if (functionName === "reverse") {
      status = "REVERSED";
    }
    if (status !== null && transferId !== null) {
      await db
        .update(transfer, {
          id: transferId,
        })
        .set({
          // @ts-expect-error
          status,
        });
    }

    // update balance of sender and receiver
    const fromBalance = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "balanceOf",
      args: [from, id],
    });
    const toBalance = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "balanceOf",
      args: [to, id],
    });
    const unlockedBalanceFrom = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "unlockedBalances",
      args: [from, id],
    });
    const unlockedBalanceTo = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "unlockedBalances",
      args: [to, id],
    });

    await db
      .insert(balance)
      .values({
        userAddress: from,
        tokenId: id,
        totalBalance: fromBalance,
        unlockedBalance: unlockedBalanceFrom,
      })
      .onConflictDoUpdate({
        totalBalance: fromBalance,
        unlockedBalance: unlockedBalanceFrom,
      });

    await db
      .insert(balance)
      .values({
        userAddress: to,
        tokenId: id,
        totalBalance: toBalance,
        unlockedBalance: unlockedBalanceTo,
      })
      .onConflictDoUpdate({
        totalBalance: toBalance,
        unlockedBalance: unlockedBalanceTo,
      });
  } else if (isBurn && !isMint) {
    // Update receiver's balance (for transfers and mints)
    const fromBalance = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "balanceOf",
      args: [from, id],
    });
    const unlockedBalance = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "unlockedBalances",
      args: [from, id],
    });

    await db
      .insert(balance)
      .values({
        userAddress: from,
        tokenId: id,
        totalBalance: fromBalance,
        unlockedBalance: unlockedBalance,
      })
      .onConflictDoUpdate({
        totalBalance: fromBalance,
        unlockedBalance: unlockedBalance,
      });
  } else if (isMint && !isBurn) {
    const toBalance = await client.readContract({
      address: SLOW.address,
      abi: SLOW.abi,
      functionName: "balanceOf",
      args: [to, id],
    });

    await db
      .insert(balance)
      .values({
        userAddress: to,
        tokenId: id,
        totalBalance: toBalance,
      })
      .onConflictDoUpdate({
        totalBalance: toBalance,
      });
  }
});

ponder.on("SLOW:URI", async ({ event, context }) => {
  // Event args: value (string), id (uint256)
  const { id } = event.args;

  const tokenId = BigInt(id.toString());
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
  const {
    contracts: { SLOW },
  } = context;
  const callData = event.transaction.input;
  const decoded = decodeFunctionData({
    abi: SLOW.abi,
    data: callData,
  });

  let transferId;
  if (decoded.functionName === "multicall") {
    const calls = decoded.args[0];
    for (const call of calls) {
      const { functionName, args } = decodeFunctionData({
        abi: SLOW.abi,
        data: call,
      });

      if (functionName === "unlock") {
        transferId = args[0];
      }
    }
  } else if (decoded.functionName === "unlock") {
    transferId = decoded.args[0];
  }

  if (transferId) {
    await context.db
      .update(transfer, {
        id: transferId,
      })
      .set({
        status: "UNLOCKED",
      });
  }

  await context.db
    .insert(balance)
    .values({
      userAddress: userAddress,
      tokenId: tokenId,
      unlockedBalance: BigInt(amount),
    })
    .onConflictDoUpdate((row) => ({
      unlockedBalance: (row.unlockedBalance ?? 0n) + BigInt(amount),
    }));

  await context.db.insert(unlockEvent).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    blockNumber: BigInt(event.block.number),
    transactionHash: event.transaction.hash,
    timestamp: BigInt(event.block.timestamp),
    userAddress: userAddress,
    tokenId: tokenId,
    amount: BigInt(amount),
    transferId: transferId,
  });
});
