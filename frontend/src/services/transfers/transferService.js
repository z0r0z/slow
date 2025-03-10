import { getSlowContract, getTokenDecimals } from '../wallet/walletService';
import { SLOW_CONTRACT_ADDRESS } from '../wallet/walletService';
import { formatTimeDiff } from '../utils';

// Deployment block of the SLOW contract
const SLOW_DEPLOYMENT_BLOCK = 27245775;

// Cache for pending transfers
let transfersCache = {
  outbound: [],
  inbound: [],
  lastUpdated: 0,
  loading: false,
  unlockedTransferIds: new Set()
};

/**
 * Load pending transfers for a user
 * @param {Object} params - Parameters for loading transfers
 * @returns {Promise<Object>} Result with transfers
 */
export async function loadPendingTransfers({
  address,
  publicClient,
  slowContract = getSlowContract(),
  isDetailed = true
}) {
  if (!address || !publicClient || !slowContract || transfersCache.loading) {
    return { success: false, message: "Can't load transfers" };
  }

  try {
    // Set loading state
    transfersCache.loading = true;

    // Get block number
    const currentBlock = await publicClient.getBlockNumber();

    // Determine if we need to refresh the data
    const now = Date.now();
    const shouldRefresh = now - transfersCache.lastUpdated > 120000 || 
                          transfersCache.outbound.length === 0 && 
                          transfersCache.inbound.length === 0;

    // Get events
    let events = [];
    if (shouldRefresh) {
      // Query for TransferPending events
      const blocksToSearch = Number(currentBlock) - SLOW_DEPLOYMENT_BLOCK;
      const CHUNK_SIZE = 10000; // Adjust based on RPC provider limits

      if (blocksToSearch > CHUNK_SIZE) {
        // Query in chunks to avoid RPC timeouts for large ranges
        let startBlock = SLOW_DEPLOYMENT_BLOCK;
        while (startBlock < Number(currentBlock)) {
          const endBlock = Math.min(startBlock + CHUNK_SIZE, Number(currentBlock));

          console.log(`Querying events from block ${startBlock} to ${endBlock}`);

          const chunkEvents = await publicClient.getLogs({
            address: SLOW_CONTRACT_ADDRESS,
            event: {
              anonymous: false,
              inputs: [
                { indexed: true, name: 'transferId', type: 'uint256' },
                { indexed: true, name: 'delay', type: 'uint256' }
              ],
              name: 'TransferPending',
              type: 'event'
            },
            fromBlock: BigInt(startBlock),
            toBlock: BigInt(endBlock)
          });
          
          events = [...events, ...chunkEvents];
          startBlock = endBlock + 1;
        }
      } else {
        // For smaller ranges, query all at once
        events = await publicClient.getLogs({
          address: SLOW_CONTRACT_ADDRESS,
          event: {
            anonymous: false,
            inputs: [
              { indexed: true, name: 'transferId', type: 'uint256' },
              { indexed: true, name: 'delay', type: 'uint256' }
            ],
            name: 'TransferPending',
            type: 'event'
          },
          fromBlock: BigInt(SLOW_DEPLOYMENT_BLOCK),
          toBlock: BigInt(currentBlock)
        });
      }

      // Now fetch Unlocked events to track which transfers have been processed
      let unlockedEvents = [];

      if (blocksToSearch > CHUNK_SIZE) {
        // Query in chunks to avoid RPC timeouts
        let startBlock = SLOW_DEPLOYMENT_BLOCK;
        while (startBlock < Number(currentBlock)) {
          const endBlock = Math.min(startBlock + CHUNK_SIZE, Number(currentBlock));

          console.log(`Querying unlocked events from block ${startBlock} to ${endBlock}`);

          const chunkEvents = await publicClient.getLogs({
            address: SLOW_CONTRACT_ADDRESS,
            event: {
              anonymous: false,
              inputs: [
                { indexed: true, name: 'user', type: 'address' },
                { indexed: true, name: 'id', type: 'uint256' },
                { indexed: true, name: 'amount', type: 'uint256' }
              ],
              name: 'Unlocked',
              type: 'event'
            },
            fromBlock: BigInt(startBlock),
            toBlock: BigInt(endBlock)
          });
          
          unlockedEvents = [...unlockedEvents, ...chunkEvents];
          startBlock = endBlock + 1;
        }
      } else {
        unlockedEvents = await publicClient.getLogs({
          address: SLOW_CONTRACT_ADDRESS,
          event: {
            anonymous: false,
            inputs: [
              { indexed: true, name: 'user', type: 'address' },
              { indexed: true, name: 'id', type: 'uint256' },
              { indexed: true, name: 'amount', type: 'uint256' }
            ],
            name: 'Unlocked',
            type: 'event'
          },
          fromBlock: BigInt(SLOW_DEPLOYMENT_BLOCK),
          toBlock: BigInt(currentBlock)
        });
      }

      // Build a set of unlocked transfer IDs
      const unlockedIds = new Set();
      for (const event of unlockedEvents) {
        if (event.args && event.args.id) {
          unlockedIds.add(event.args.id.toString());
        }
      }

      // Store in cache
      transfersCache.unlockedTransferIds = unlockedIds;
      transfersCache.lastUpdated = now;
    }

    const outbound = [];
    const inbound = [];

    // Use a map to track processed transfers
    const processedTransfers = new Map();

    // Process transfers in batches
    const batchSize = 20;
    const transferBatches = [];
    for (let i = 0; i < events.length; i += batchSize) {
      transferBatches.push(events.slice(i, i + batchSize));
    }

    // Process each batch
    for (const batch of transferBatches) {
      const batchPromises = batch.map(async (event) => {
        const transferId = event.args.transferId.toString();

        // Skip if already processed
        if (processedTransfers.has(transferId)) return null;
        processedTransfers.set(transferId, true);

        try {
          const transfer = await slowContract.read.pendingTransfers([transferId]);

          // Skip if unlocked or reversed
          if (transfer[0] === 0n) {
            return null;
          }

          // Skip if in our unlocked set
          if (transfersCache.unlockedTransferIds.has(transferId)) {
            return null;
          }

          // Check if this transfer involves the current user
          const isFromUser = transfer[1].toLowerCase() === address.toLowerCase();
          const isToUser = transfer[2].toLowerCase() === address.toLowerCase();

          if (!isFromUser && !isToUser) return null;

          // Only add basic info if detailed view not requested
          if (!isDetailed) {
            const basic = {
              id: transferId,
              from: transfer[1],
              to: transfer[2],
              tokenId: transfer[3],
              amount: transfer[4],
            };
            
            if (isFromUser) outbound.push(basic);
            if (isToUser) inbound.push(basic);
            return basic;
          }

          // Get token and delay information
          const decodedId = await slowContract.read.decodeId([transfer[3]]);
          const token = decodedId[0];
          const delay = Number(decodedId[1]);

          // Find token symbol from the crypto box elements
          let symbol = "???";
          const cryptoBoxes = document.querySelectorAll(".crypto-box");
          for (const box of cryptoBoxes) {
            if (box.dataset.token.toLowerCase() === token.toLowerCase()) {
              symbol = box.dataset.symbol;
              break;
            }
          }

          // Format amount using token decimals
          const decimals = await getTokenDecimals(token);
          const formattedAmount = Number(transfer[4]) / (10 ** decimals);

          const timestamp = Number(transfer[0]);
          const unlockTime = timestamp + delay;

          const transferData = {
            id: transferId,
            from: transfer[1],
            to: transfer[2],
            token,
            symbol,
            amount: formattedAmount,
            timestamp: timestamp,
            delay: delay,
            unlockTime: unlockTime,
          };

          // Add to appropriate arrays
          if (isFromUser) {
            outbound.push(transferData);
          }

          if (isToUser) {
            inbound.push(transferData);
          }

          return transferData;
        } catch (error) {
          console.error("Error processing transfer:", error);
          return null;
        }
      });

      // Process this batch
      await Promise.all(batchPromises);
    }

    // Sort transfers by unlock time (ascending)
    outbound.sort((a, b) => a.unlockTime - b.unlockTime);
    inbound.sort((a, b) => a.unlockTime - b.unlockTime);

    // Update cache
    transfersCache = {
      outbound,
      inbound,
      loading: false,
      lastUpdated: now,
      unlockedTransferIds: transfersCache.unlockedTransferIds
    };

    return {
      success: true,
      outbound,
      inbound
    };
  } catch (error) {
    console.error("Error loading pending transfers:", error);
    transfersCache.loading = false;
    return { success: false, message: "Failed to load transfers" };
  }
}

/**
 * Check if a transfer can be reversed
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} - Result with can reverse status
 */
export async function canReverseTransfer({
  transferId,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) return { success: false, canReverse: false };
    
    const result = await slowContract.read.canReverseTransfer([transferId]);
    return {
      success: true,
      canReverse: result[0],
      reason: result[1]
    };
  } catch (error) {
    console.error("Error checking if transfer can be reversed:", error);
    return { success: false, canReverse: false };
  }
}

/**
 * Reverse a pending transfer
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} - Result of the reversal
 */
export async function reverseTransfer({
  transferId,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      return { success: false, message: "Contract not available" };
    }

    // Get transfer details for better error reporting
    const transfer = await slowContract.read.pendingTransfers([transferId]);
    
    if (transfer[0] === 0n) {
      return { 
        success: false, 
        message: "This transfer has already been unlocked or reversed" 
      };
    }

    const canReverse = await canReverseTransfer({ transferId, slowContract });
    
    if (!canReverse.success || !canReverse.canReverse) {
      if (canReverse.reason === "0x8f9a780c") {
        return { 
          success: false, 
          message: "This transfer can't be reversed because the timelock has expired" 
        };
      } else {
        return { success: false, message: "This transfer can't be reversed" };
      }
    }

    const hash = await slowContract.write.reverse([transferId]);
    
    // Add the transfer ID to our unlocked set
    transfersCache.unlockedTransferIds.add(transferId);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error reversing transfer:", error);
    return { success: false, message: "Failed to reverse transfer" };
  }
}

/**
 * Unlock a pending transfer
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} - Result of the unlock operation
 */
export async function unlockTransfer({
  transferId,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      return { success: false, message: "Contract not available" };
    }

    // Get transfer details for better error reporting
    const transfer = await slowContract.read.pendingTransfers([transferId]);
    
    if (transfer[0] === 0n) {
      return { 
        success: false, 
        message: "This transfer has already been unlocked or reversed" 
      };
    }

    const decodedId = await slowContract.read.decodeId([transfer[3]]);
    const delay = Number(decodedId[1]);
    const unlockTime = Number(transfer[0]) + delay;
    const now = Math.floor(Date.now() / 1000);

    if (now < unlockTime) {
      const remaining = formatTimeDiff(unlockTime - now);
      return { 
        success: false, 
        message: `Cannot unlock yet. ${remaining} remaining until unlock` 
      };
    }

    const hash = await slowContract.write.unlock([transferId]);
    
    // Add the transfer ID to our unlocked set
    transfersCache.unlockedTransferIds.add(transferId);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error unlocking transfer:", error);
    return { success: false, message: "Failed to unlock transfer" };
  }
}

/**
 * Prepare multicall data for unlock and withdraw operations
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} - Array of encoded function calls
 */
export async function prepareUnlockAndWithdrawCalldata({
  transferId,
  userAddress,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      throw new Error("Contract not available");
    }

    const transfer = await slowContract.read.pendingTransfers([transferId]);

    if (transfer[0] === 0n) {
      throw new Error("Transfer does not exist or has already been unlocked/reversed");
    }

    const unlockCalldata = slowContract.write.unlock.populateTransaction([transferId]);
    
    const withdrawCalldata = slowContract.write.withdrawFrom.populateTransaction([
      transfer[2], // to (recipient of the original transfer)
      userAddress, // destination for the withdrawn funds
      transfer[3], // tokenId
      transfer[4]  // amount
    ]);

    return [unlockCalldata, withdrawCalldata];
  } catch (error) {
    console.error("Error preparing multicall data:", error);
    throw error;
  }
}

/**
 * Unlock and withdraw funds in a single transaction
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} - Result of the operation
 */
export async function unlockAndWithdraw({
  transferId,
  userAddress,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      return { success: false, message: "Contract not available" };
    }

    // Get transfer details for better error reporting
    const transfer = await slowContract.read.pendingTransfers([transferId]);
    
    if (transfer[0] === 0n) {
      return { 
        success: false, 
        message: "This transfer has already been unlocked or withdrawn" 
      };
    }

    const decodedId = await slowContract.read.decodeId([transfer[3]]);
    const delay = Number(decodedId[1]);
    const unlockTime = Number(transfer[0]) + delay;
    const now = Math.floor(Date.now() / 1000);

    if (now < unlockTime) {
      const remaining = formatTimeDiff(unlockTime - now);
      return { 
        success: false, 
        message: `Cannot unlock yet. ${remaining} remaining until unlock` 
      };
    }

    const calldata = await prepareUnlockAndWithdrawCalldata({
      transferId,
      userAddress,
      slowContract
    });

    const hash = await slowContract.write.multicall([calldata]);
    
    // Add the transfer ID to our unlocked set
    transfersCache.unlockedTransferIds.add(transferId);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error executing unlock and withdraw:", error);
    return { success: false, message: "Failed to unlock and withdraw" };
  }
}

/**
 * Prepare multicall data for reverse and withdraw operations
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} - Array of encoded function calls
 */
export async function prepareReverseAndWithdrawCalldata({
  transferId,
  userAddress,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      throw new Error("Contract not available");
    }
    
    const transfer = await slowContract.read.pendingTransfers([transferId]);

    if (transfer[0] === 0n) {
      throw new Error("Transfer does not exist or has already been unlocked/reversed");
    }

    const reverseCalldata = slowContract.write.reverse.populateTransaction([transferId]);
    
    const withdrawCalldata = slowContract.write.withdrawFrom.populateTransaction([
      transfer[1], // from (sender of the original transfer)
      userAddress, // destination for the withdrawn funds
      transfer[3], // tokenId
      transfer[4]  // amount
    ]);

    return [reverseCalldata, withdrawCalldata];
  } catch (error) {
    console.error("Error preparing reverse multicall data:", error);
    throw error;
  }
}

/**
 * Reverse and withdraw funds in a single transaction
 * @param {Object} params - Parameters
 * @returns {Promise<Object>} - Result of the operation
 */
export async function reverseAndWithdraw({
  transferId,
  userAddress,
  slowContract = getSlowContract()
}) {
  try {
    if (!slowContract) {
      return { success: false, message: "Contract not available" };
    }

    // Get transfer details for better error reporting
    const transfer = await slowContract.read.pendingTransfers([transferId]);
    
    if (transfer[0] === 0n) {
      return { 
        success: false, 
        message: "This transfer has already been unlocked or reversed" 
      };
    }

    const canReverse = await canReverseTransfer({ transferId, slowContract });
    
    if (!canReverse.success || !canReverse.canReverse) {
      if (canReverse.reason === "0x8f9a780c") {
        return { 
          success: false, 
          message: "This transfer can't be reversed because the timelock has expired" 
        };
      } else {
        return { success: false, message: "This transfer can't be reversed" };
      }
    }

    const calldata = await prepareReverseAndWithdrawCalldata({
      transferId,
      userAddress,
      slowContract
    });

    const hash = await slowContract.write.multicall([calldata]);
    
    // Add the transfer ID to our unlocked set
    transfersCache.unlockedTransferIds.add(transferId);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error executing reverse and withdraw:", error);
    return { success: false, message: "Failed to reverse and return funds" };
  }
}