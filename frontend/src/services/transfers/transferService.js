import { getSlowContract, getTokenDecimals } from '../wallet/walletService';
import { formatTimeDiff } from '../utils';
import { encodeFunctionData } from 'viem';
import { SlowAbi } from '../../abis/SlowAbi';

// Indexer URL
const INDEXER_URL = "https://slow-production-3176.up.railway.app";

// Cache for pending transfers
let transfersCache = {
  outbound: [],
  inbound: [],
  lastUpdated: 0,
  loading: false,
  unlockedTransferIds: new Set(),
  // Cache frequently accessed transfers data
  transfersById: new Map()
};

/**
 * Fetch transfers from the indexer using the REST API
 * @param {string} address - User address
 * @param {string} type - Type of transfers (outbound or inbound)
 * @param {string} status - Status to filter by (PENDING, APPROVAL_REQUIRED, etc.)
 * @returns {Promise<Array>} - Array of transfers
 */
async function fetchTransfersFromIndexer(address, type = 'outbound', status = 'PENDING') {
  try {
    if (!address) {
      throw new Error("Address is required");
    }

    const userAddress = address.toLowerCase();
    const url = `${INDEXER_URL}/transfers/${userAddress}?type=${type}&status=${status}`;
    
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const transfers = await response.json();
    return transfers;
  } catch (error) {
    console.error(`Error fetching ${type} transfers from indexer:`, error);
    throw error;
  }
}

/**
 * Load transfers for a user using the indexer
 * @param {Object} params - Parameters for loading transfers
 * @returns {Promise<Object>} Result with transfers
 */
export async function loadPendingTransfers({
  address,
  publicClient,
  slowContract = getSlowContract(),
  isDetailed = true,
  forceRefresh = false
}) {
  if (!address) {
    return { success: false, message: "Address is required" };
  }

  if (transfersCache.loading && !forceRefresh) {
    return { success: false, message: "Already loading transfers" };
  }

  try {
    // Reset loading state if forcing refresh
    if (forceRefresh) {
      transfersCache.loading = false;
    }
    
    // Set loading state
    transfersCache.loading = true;

    // Determine if we need to refresh the data
    const now = Date.now();
    const shouldRefresh = now - transfersCache.lastUpdated > 120000 || 
                          transfersCache.outbound.length === 0 && 
                          transfersCache.inbound.length === 0;

    if (!shouldRefresh) {
      // Return cached data
      transfersCache.loading = false;
      return {
        success: true,
        outbound: transfersCache.outbound,
        inbound: transfersCache.inbound
      };
    }

    // Fetch both outbound and inbound pending transfers in parallel
    const [outboundTransfers, inboundTransfers] = await Promise.all([
      fetchTransfersFromIndexer(address, 'outbound', 'PENDING'),
      fetchTransfersFromIndexer(address, 'inbound', 'PENDING')
    ]);
    
    // Process outbound and inbound transfers
    const outbound = [];
    const inbound = [];
    const unlockedIds = new Set(transfersCache.unlockedTransferIds);
    
    // Process outbound transfers
    for (const transfer of outboundTransfers) {
      // Skip if in our unlocked set
      if (unlockedIds.has(transfer.id)) {
        continue;
      }
      
      // Check if we already have the transfer details in cache
      const cachedTransfer = transfersCache.transfersById.get(transfer.id);
      if (cachedTransfer && !forceRefresh) {
        outbound.push(cachedTransfer);
        continue;
      }
      
      // Create basic transfer object
      const transferData = {
        id: transfer.id,
        from: transfer.fromAddress,
        to: transfer.toAddress,
        tokenId: transfer.token?.id || null,
        amount: transfer.amount,
      };

      // Add detailed information if requested
      if (isDetailed) {
        const token = transfer.token;
        const delay = token ? Number(token.delaySeconds) : 0;
        // Calculate timestamp from expiryTimestamp - delay
        const unlockTime = Number(transfer.expiryTimestamp);
        const timestamp = unlockTime - delay;

        // Format amount using token decimals
        const decimals = token ? Number(token.decimals) : 18;
        const formattedAmount = Number(transfer.amount) / (10 ** decimals);

        Object.assign(transferData, {
          token: token ? token.address : null,
          symbol: token ? token.symbol : "???",
          amount: formattedAmount,
          timestamp: timestamp,
          delay: delay,
          unlockTime: unlockTime,
        });
      }

      // Add to both the regular array and the map cache
      outbound.push(transferData);
      transfersCache.transfersById.set(transfer.id, transferData);
    }
    
    // Process inbound transfers
    for (const transfer of inboundTransfers) {
      // Skip if in our unlocked set
      if (unlockedIds.has(transfer.id)) {
        continue;
      }
      
      // Check if we already have the transfer details in cache
      const cachedTransfer = transfersCache.transfersById.get(transfer.id);
      if (cachedTransfer && !forceRefresh) {
        inbound.push(cachedTransfer);
        continue;
      }
      
      // Create basic transfer object
      const transferData = {
        id: transfer.id,
        from: transfer.fromAddress,
        to: transfer.toAddress,
        tokenId: transfer.token?.id || null,
        amount: transfer.amount,
      };

      // Add detailed information if requested
      if (isDetailed) {
        const token = transfer.token;
        const delay = token ? Number(token.delaySeconds) : 0;
        // Calculate timestamp from expiryTimestamp - delay
        const unlockTime = Number(transfer.expiryTimestamp);
        const timestamp = unlockTime - delay;

        // Format amount using token decimals
        const decimals = token ? Number(token.decimals) : 18;
        const formattedAmount = Number(transfer.amount) / (10 ** decimals);

        Object.assign(transferData, {
          token: token ? token.address : null,
          symbol: token ? token.symbol : "???",
          amount: formattedAmount,
          timestamp: timestamp,
          delay: delay,
          unlockTime: unlockTime,
        });
      }

      // Add to both the regular array and the map cache
      inbound.push(transferData);
      transfersCache.transfersById.set(transfer.id, transferData);
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
      unlockedTransferIds: unlockedIds,
      transfersById: transfersCache.transfersById
    };

    return {
      success: true,
      outbound,
      inbound
    };
  } catch (error) {
    console.error("Error loading pending transfers:", error);
    transfersCache.loading = false;
    return { success: false, message: "Failed to load transfers: " + error.message };
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
    // Remove from transfers by ID cache
    transfersCache.transfersById.delete(transferId);
    
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
    // Remove from transfers by ID cache
    transfersCache.transfersById.delete(transferId);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error unlocking transfer:", error);
    return { success: false, message: "Failed to unlock transfer" };
  }
}

/**
 * Helper function to refresh the transfers cache
 * @param {string} address - User address
 * @param {boolean} immediate - Whether to load immediately
 * @returns {Promise<boolean>} - Success status
 */
export async function refreshTransfersCache(address, immediate = true) {
  if (!address) return false;
  
  // Force a refresh next time loadPendingTransfers is called
  transfersCache.lastUpdated = 0;
  transfersCache.loading = false;
  
  // Optionally pre-load the data immediately
  if (immediate) {
    try {
      const result = await loadPendingTransfers({ address, forceRefresh: true });
      return result.success;
    } catch (error) {
      console.error("Error pre-loading transfers:", error);
      return false;
    }
  }
  
  return true;
}

/**
 * Set up automatic refresh after a transaction
 * @param {string} txHash - Transaction hash
 * @param {string} address - User address 
 * @param {number} attempts - Number of attempts
 * @returns {Promise<void>}
 */
export async function setupTransferRefreshAfterTx(txHash, address, attempts = 5) {
  if (!txHash || !address) return;
  
  // Create a polling mechanism to check for transfer updates
  let attempt = 0;
  
  // Set up polling interval to check for new transfers
  const pollInterval = setInterval(async () => {
    attempt++;
    
    try {
      // Force refresh with indexer
      await refreshTransfersCache(address, true);
      
      // If we've made enough attempts or loaded transfers, stop polling
      if (attempt >= attempts) {
        clearInterval(pollInterval);
      }
    } catch (error) {
      console.error("Error polling for transfer updates:", error);
      // On error, also stop polling
      clearInterval(pollInterval);
    }
  }, 4000); // Check every 4 seconds
  
  // Also stop polling after a max time (30s) regardless of success
  setTimeout(() => {
    clearInterval(pollInterval);
  }, 30000);
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

    const unlockCalldata = encodeFunctionData({
      abi: SlowAbi,
      functionName: 'unlock',
      args: [transferId]
    });
    
    const withdrawCalldata = encodeFunctionData({
      abi: SlowAbi,
      functionName: 'withdrawFrom',
      args: [
        transfer[2], // to (recipient of the original transfer)
        userAddress, // destination for the withdrawn funds
        transfer[3], // tokenId
        transfer[4]  // amount
      ]
    });

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

    // The multicall function expects an array of encoded function calls
    // Try the direct approach first (passing calldata directly)
    try {
      console.log("Executing unlock multicall...");
      const hash = await slowContract.write.multicall(calldata, {
        account: userAddress,
        gas: 600000n // Higher gas to be safe
      });
      
      // Add the transfer ID to our unlocked set
      transfersCache.unlockedTransferIds.add(transferId);
      // Remove from transfers by ID cache
      transfersCache.transfersById.delete(transferId);
      
      // Refresh cache
      refreshTransfersCache(userAddress);
      
      return { success: true, hash };
    } catch (primaryError) {
      console.error("First multicall attempt failed:", primaryError);
      
      // If first approach fails, try alternative format (wrapping in an array)
      try {
        console.log("Trying alternative multicall format with [calldata]");
        const hash = await slowContract.write.multicall([calldata], {
          account: userAddress,
          gas: 600000n // Higher gas to be safe
        });
        
        // Add the transfer ID to our unlocked set
        transfersCache.unlockedTransferIds.add(transferId);
        // Remove from transfers by ID cache
        transfersCache.transfersById.delete(transferId);
        
        // Refresh cache
        refreshTransfersCache(userAddress);
        
        return { success: true, hash };
      } catch (alternativeError) {
        console.error("Alternative multicall format also failed:", alternativeError);
        throw alternativeError; // Throw to be caught by outer catch
      }
    }
  } catch (error) {
    console.error("Error executing unlock and withdraw:", error);
    
    // Provide a more user-friendly error message
    let errorMessage = "Failed to unlock and withdraw";
    
    if (error.message) {
      if (error.message.includes("user rejected") || 
          error.message.includes("User rejected") ||
          error.message.includes("cancelled") || 
          error.message.includes("denied")) {
        errorMessage = "Transaction was rejected in your wallet";
      } else if (error.message.includes("gas")) {
        errorMessage = "Transaction failed due to gas estimation. Try again.";
      } else {
        errorMessage += ": " + error.message.substring(0, 100);
      }
    }
    
    return { success: false, message: errorMessage };
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
    console.log("Preparing reverse and withdraw calldata for transferId:", transferId);
    
    if (!slowContract) {
      throw new Error("Contract not available");
    }
    
    // First, get the transfer details
    const transfer = await slowContract.read.pendingTransfers([transferId]);
    
    if (transfer[0] === 0n) {
      throw new Error("Transfer does not exist or has already been unlocked/reversed");
    }

    // Encode the reverse function call - passes just transferId
    const reverseCalldata = encodeFunctionData({
      abi: SlowAbi,
      functionName: 'reverse',
      args: [transferId]
    });
    
    // Encode the withdrawFrom function call
    const withdrawCalldata = encodeFunctionData({
      abi: SlowAbi,
      functionName: 'withdrawFrom',
      args: [
        transfer[1], // from (sender of the original transfer)
        userAddress, // destination for the withdrawn funds
        transfer[3], // tokenId
        transfer[4]  // amount
      ]
    });

    // Return the array of calldata for the multicall
    return [reverseCalldata, withdrawCalldata];
  } catch (error) {
    console.error("Error preparing reverse multicall data:", error);
    throw error;
  }
}

/**
 * Reverse and withdraw funds in a single transaction using multicall
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

    // Check if transfer can be reversed
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

    // Prepare the calldata for the multicall - same approach as unlock
    const calldata = await prepareReverseAndWithdrawCalldata({
      transferId,
      userAddress,
      slowContract
    });

    // Try the direct approach first (passing calldata directly)
    try {
      console.log("Executing reverse multicall...");
      const hash = await slowContract.write.multicall(calldata, {
        account: userAddress
      });
      
      // Add the transfer ID to our unlocked set
      transfersCache.unlockedTransferIds.add(transferId);
      // Remove from transfers by ID cache
      transfersCache.transfersById.delete(transferId);
      
      // Refresh cache
      refreshTransfersCache(userAddress);
      
      return { 
        success: true, 
        hash,
        message: "Transfer reversed and funds returned to your wallet!" 
      };
    } catch (primaryError) {
      console.error("First multicall attempt failed:", primaryError);
      
      // Handle user rejection
      if (primaryError.message && 
          (primaryError.message.includes("user rejected") || 
           primaryError.message.includes("cancelled") || 
           primaryError.message.includes("denied"))) {
        return { success: false, message: "Transaction was rejected in your wallet" };
      }
      
      // If first approach fails, try alternative format (wrapping in an array)
      try {
        console.log("Trying alternative multicall format with [calldata]");
        const hash = await slowContract.write.multicall([calldata], {
          account: userAddress,
          gas: 600000n // Higher gas to be safe
        });
        
        // Add the transfer ID to our unlocked set
        transfersCache.unlockedTransferIds.add(transferId);
        // Remove from transfers by ID cache
        transfersCache.transfersById.delete(transferId);
        
        // Refresh cache
        refreshTransfersCache(userAddress);
        
        return { 
          success: true, 
          hash,
          message: "Transfer reversed and funds returned to your wallet!" 
        };
      } catch (alternativeError) {
        console.error("Alternative multicall format also failed:", alternativeError);
        
        // If the user rejected the transaction, return that message
        if (alternativeError.message && 
            (alternativeError.message.includes("user rejected") || 
             alternativeError.message.includes("cancelled") || 
             alternativeError.message.includes("denied"))) {
          return { success: false, message: "Transaction was rejected in your wallet" };
        }
        
        throw alternativeError; // Throw to be caught by outer catch
      }
    }
  } catch (error) {
    console.error("Error executing reverse and withdraw:", error);
    
    // Provide a user-friendly error message
    let errorMessage = "Failed to reverse transfer";
    
    if (error.message) {
      if (error.message.includes("user rejected") || 
          error.message.includes("User rejected") ||
          error.message.includes("cancelled") || 
          error.message.includes("denied")) {
        errorMessage = "Transaction was rejected in your wallet";
      } else if (error.message.includes("TimelockExpired")) {
        errorMessage = "Transfer can't be reversed because the timelock has expired";
      } else if (error.message.includes("Unauthorized")) {
        errorMessage = "You are not authorized to reverse this transfer";
      } else if (error.message.includes("gas")) {
        errorMessage = "Transaction failed due to gas estimation. Try again.";
      } else {
        errorMessage += ": " + error.message.substring(0, 100);
      }
    }
    
    return { success: false, message: errorMessage };
  }
}
