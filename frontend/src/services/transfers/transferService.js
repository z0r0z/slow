import { getSlowContract, getTokenDecimals } from '../wallet/walletService';
import { formatTimeDiff } from '../utils';
import { encodeFunctionData } from 'viem';
import { SlowAbi } from '../../abis/SlowAbi';

// Indexer URL
const INDEXER_URL = "https://slow-production-3176.up.railway.app/";

// Cache for pending transfers
let transfersCache = {
  outbound: [],
  inbound: [],
  lastUpdated: 0,
  loading: false,
  unlockedTransferIds: new Set()
};

/**
 * Fetch user data from the indexer
 * @param {string} address - User address
 * @returns {Promise<Object>} - User data from indexer
 */
async function fetchUserFromIndexer(address) {
  try {
    if (!address) {
      throw new Error("Address is required");
    }

    const userAddress = address.toLowerCase();
    
    const query = `
      query GetUser {
        user(id: "${userAddress}") {
          guardian
          id
          lastGuardianChange
          nonce
          transfers {
            totalCount
            items {
              amount
              blockNumber
              expiryTimestamp
              fromAddress
              id
              status
              timestamp
              toAddress
              tokenId
              transactionHash
              token {
                address
                decimals
                delaySeconds
                name
                symbol
              }
            }
          }
        }
      }
    `;

    const response = await fetch(INDEXER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL error: ${JSON.stringify(data.errors)}`);
    }

    return data.data.user;
  } catch (error) {
    console.error("Error fetching user from indexer:", error);
    throw error;
  }
}

/**
 * Load pending transfers for a user using the indexer
 * @param {Object} params - Parameters for loading transfers
 * @returns {Promise<Object>} Result with transfers
 */
export async function loadPendingTransfers({
  address,
  publicClient,
  slowContract = getSlowContract(),
  isDetailed = true
}) {
  if (!address) {
    return { success: false, message: "Address is required" };
  }

  if (transfersCache.loading) {
    return { success: false, message: "Already loading transfers" };
  }

  try {
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

    // Fetch user data from indexer for their outbound transfers
    const userData = await fetchUserFromIndexer(address);
    
    if (!userData || !userData.transfers || !userData.transfers.items) {
      transfersCache.loading = false;
      return { success: false, message: "No transfer data found" };
    }

    // We need to also query for inbound transfers separately
    // The indexer query at the user level gives us transfers FROM this user
    // But we also need to query for transfers TO this user
    const queryInbound = `
      query GetInboundTransfers {
        transfers(
          where: { 
            toAddress: "${address.toLowerCase()}",
            status: "PENDING"
          }
        ) {
          totalCount
          items {
            amount
            blockNumber
            expiryTimestamp
            fromAddress
            id
            status
            timestamp
            toAddress
            tokenId
            transactionHash
            token {
              address
              decimals
              delaySeconds
              name
              symbol
            }
          }
        }
      }
    `;

    // Execute query for inbound transfers
    const inboundResponse = await fetch(INDEXER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: queryInbound
      }),
    });

    // Process outbound and inbound transfers
    const outbound = [];
    const inbound = [];
    const unlockedIds = new Set(transfersCache.unlockedTransferIds);
    
    // Process outbound transfers (from user's data)
    const transfers = userData.transfers.items;
    const pendingOutboundTransfers = transfers.filter(transfer => 
      transfer.status === 'PENDING'
    );

    // Process outbound transfers first
    for (const transfer of pendingOutboundTransfers) {
      // Skip if in our unlocked set
      if (unlockedIds.has(transfer.id)) {
        continue;
      }
      
      // Create basic transfer object
      const transferData = {
        id: transfer.id,
        from: transfer.fromAddress,
        to: transfer.toAddress,
        tokenId: transfer.tokenId,
        amount: transfer.amount,
      };

      // Add detailed information if requested
      if (isDetailed) {
        const token = transfer.token;
        const delay = token ? Number(token.delaySeconds) : 0;
        const timestamp = Number(transfer.timestamp);
        const unlockTime = Number(transfer.expiryTimestamp);

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

      outbound.push(transferData);
    }
    
    // Process inbound transfers
    if (inboundResponse.ok) {
      const inboundData = await inboundResponse.json();
      
      if (inboundData.data && inboundData.data.transfers && inboundData.data.transfers.items) {
        const inboundTransfers = inboundData.data.transfers.items;
        
        for (const transfer of inboundTransfers) {
          // Skip if in our unlocked set
          if (unlockedIds.has(transfer.id)) {
            continue;
          }
          
          // Create basic transfer object
          const transferData = {
            id: transfer.id,
            from: transfer.fromAddress,
            to: transfer.toAddress,
            tokenId: transfer.tokenId,
            amount: transfer.amount,
          };

          // Add detailed information if requested
          if (isDetailed) {
            const token = transfer.token;
            const delay = token ? Number(token.delaySeconds) : 0;
            const timestamp = Number(transfer.timestamp);
            const unlockTime = Number(transfer.expiryTimestamp);

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

          inbound.push(transferData);
        }
      }
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
      unlockedTransferIds: unlockedIds
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
 * Helper function to refresh the transfers cache
 * @param {string} address - User address
 */
export async function refreshTransfersCache(address) {
  if (!address) return;
  
  // Force a refresh next time loadPendingTransfers is called
  transfersCache.lastUpdated = 0;
  
  // Optionally pre-load the data
  try {
    await loadPendingTransfers({ address });
  } catch (error) {
    console.error("Error pre-loading transfers:", error);
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

    const hash = await slowContract.write.multicall([calldata]);
    
    // Add the transfer ID to our unlocked set
    transfersCache.unlockedTransferIds.add(transferId);
    
    // Refresh cache
    refreshTransfersCache(userAddress);
    
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

    const reverseCalldata = encodeFunctionData({
      abi: SlowAbi,
      functionName: 'reverse',
      args: [transferId]
    });
    
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
    
    // Refresh cache
    refreshTransfersCache(userAddress);
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error executing reverse and withdraw:", error);
    return { success: false, message: "Failed to reverse and return funds" };
  }
}
