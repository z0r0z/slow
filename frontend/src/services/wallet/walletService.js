import { createWalletClient, createPublicClient, custom, getContract, http, erc20Abi } from 'viem';
import { mainnet, base } from 'viem/chains';
import onboard from '../../onboard';
import { CTCAbi } from '../../abis/CTCAbi';
import { SlowAbi } from '../../abis/SlowAbi';
// Contract ABIs
const SLOW_CONTRACT_ADDRESS = "0x000000000000888741B254d37e1b27128AfEAaBC";
const CTC_CONTRACT_ADDRESS = "0x0000000000cDC1F8d393415455E382c30FBc0a84";


// Initialize a public client for read-only operations on mainnet
let mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http()
});

// Initialize public and wallet clients for Base
let basePublicClient = null;
let walletClient = null;
let slowContract = null;

// Cache for token decimals and ENS names
const tokenDecimalsCache = {};
const ensCache = {};
// Cache expiration time in milliseconds (24 hours)
const ENS_CACHE_EXPIRY = 24 * 60 * 60 * 1000;

/**
 * Connect to wallet using web3-onboard
 * @returns {Promise<Object>} Connection result with wallet details
 */
export async function connectWallet() {
  try {
    console.log("Starting wallet connection with onboard...");
    
    // Get the current wallet state first
    const currentState = onboard.state.get();
    console.log("Current onboard state:", currentState);
    
    // If wallet is already connected, use it
    if (currentState.wallets && currentState.wallets.length > 0) {
      console.log("Wallet already connected, using existing wallet");
      const wallets = currentState.wallets;
      const connectedWallet = wallets[0];
      const provider = connectedWallet.provider;
      const account = connectedWallet.accounts[0].address;
      
      // Create the wallet client
      walletClient = createWalletClient({
        account,
        chain: base,
        transport: custom(provider)
      });
      
      // Create the public client for Base
      basePublicClient = createPublicClient({
        chain: base,
        transport: custom(provider)
      });
      
      // Check if we're on the Base network
      const chainId = await basePublicClient.getChainId();
      console.log("Connected to chain:", chainId);
      
      if (chainId !== base.id) {
        console.log("Wrong network, requesting chain switch to Base");
        await onboard.setChain({ chainId: 8453 }); // Base chainId
        return { success: false, message: "Please switch to Base network" };
      }
      
      // Initialize the SLOW contract with viem
      try {
        slowContract = getContract({
          address: SLOW_CONTRACT_ADDRESS,
          abi: SlowAbi,
          client: { 
            public: basePublicClient,
            wallet: walletClient
          }
        });
        
        // Verify contract is working properly
        await slowContract.read.owner();
      } catch (error) {
        console.error("Error initializing SLOW contract:", error);
        // Don't fail the connection, but log the error
      }
          
      // Get ENS name if available
      const ensName = await lookupENSName(account);
      
      return {
        success: true,
        address: account,
        walletClient,
        publicClient: basePublicClient,
        chainId,
        ensName,
        label: connectedWallet.label
      };
    }
    
    // If no wallet is connected yet, connect one
    let wallets;
    try {
      wallets = await onboard.connectWallet();
      console.log("Onboard connect wallet result:", wallets);
    } catch (error) {
      console.error("Error in onboard.connectWallet:", error);
      
      // Get the state after the error to see if a wallet was connected despite the error
      const state = onboard.state.get();
      console.log("Onboard state after error:", state);
      
      if (state.wallets && state.wallets.length > 0) {
        wallets = state.wallets;
      } else {
        return { success: false, message: "Failed to connect wallet. Please try again." };
      }
    }
    
    if (!wallets || wallets.length === 0) {
      return { success: false, message: "No wallet connected" };
    }
    
    const connectedWallet = wallets[0];

    const provider = connectedWallet.provider;
    const account = connectedWallet.accounts[0].address;
    
    // Create the wallet client
    walletClient = createWalletClient({
      account,
      chain: base,
      transport: custom(provider)
    });

    const [address] = await walletClient.getAddresses() 
    
    // Create the public client for Base
    basePublicClient = createPublicClient({
      chain: base,
      transport: custom(provider)
    });
    
    // Check if we're on the Base network
    const chainId = await basePublicClient.getChainId();
    console.log("Connected to chain:", chainId);
    
    if (chainId !== base.id) {
      console.log("Wrong network, requesting chain switch to Base");
      try {
        await onboard.setChain({ chainId: 8453 }); // Base chainId
        // Verify the chain switch was successful
        const newChainId = await basePublicClient.getChainId();
        if (newChainId !== base.id) {
          return { success: false, message: "Please switch to Base network" };
        }
      } catch (error) {
        console.error("Error switching chain:", error);
        return { success: false, message: "Failed to switch to Base network" };
      }
    }
    
    // Initialize the SLOW contract with viem
    try {
      slowContract = getContract({
        address: SLOW_CONTRACT_ADDRESS,
        abi: SlowAbi,
        client: {
          public: basePublicClient,
          wallet: walletClient
        }
      });
      
      // Verify contract is working properly
      await slowContract.read.owner();
    } catch (error) {
      console.error("Error initializing SLOW contract:", error);
      // Don't fail the connection, but log the error
    }
        
    // Get ENS name if available
    const ensName = await lookupENSName(account);
    
    return {
      success: true,
      address: account,
      walletClient,
      publicClient: basePublicClient,
      chainId,
      ensName,
      label: connectedWallet.label
    };
  } catch (error) {
    console.error("Error connecting wallet:", error);
    return { success: false, message: "Failed to connect wallet" };
  }
}

/**
 * Disconnect the connected wallet
 */
export async function disconnectWallet(label) {
  try {
    if (label) {
      onboard.disconnectWallet({ label });
    }
    
    // Reset clients
    walletClient = null;
    basePublicClient = null;
    slowContract = null;
    
    return { success: true };
  } catch (error) {
    console.error("Error disconnecting wallet:", error);
    return { success: false, message: "Failed to disconnect wallet" };
  }
}

/**
 * Look up ENS name for a given Ethereum address
 * @param {string} address - Ethereum address to look up
 * @returns {Promise<string|null>} - ENS name or null if not found
 */
export async function lookupENSName(address) {
  if (!address) return null;

  // Check cache first
  const cacheKey = address.toLowerCase();
  if (ensCache[cacheKey] !== undefined) {
    const cachedEntry = ensCache[cacheKey];
    // Check if it's a cached object with timestamp, and if it's still valid
    if (typeof cachedEntry === 'object' && cachedEntry.timestamp) {
      if (Date.now() - cachedEntry.timestamp < ENS_CACHE_EXPIRY) {
        return cachedEntry.value;
      }
      // Otherwise cache has expired, we'll refresh it
    } else {
      // Legacy cache format - upgrade to new format with current timestamp
      ensCache[cacheKey] = {
        value: cachedEntry,
        timestamp: Date.now()
      };
      return cachedEntry;
    }
  }

  try {
    // Use readContract directly with the mainnetClient
    const name = await mainnetClient.readContract({
      address: CTC_CONTRACT_ADDRESS,
      abi: CTCAbi,
      functionName: 'whatIsTheNameOf',
      args: [address]
    });

    // Cache the result with timestamp (even if null)
    ensCache[cacheKey] = {
      value: name || null,
      timestamp: Date.now()
    };

    return name || null;
  } catch (error) {
    console.error("Error looking up ENS name:", error);
    return null;
  }
}

/**
 * Look up Ethereum address for a given ENS name
 * @param {string} name - ENS name to resolve
 * @returns {Promise<string|null>} - Ethereum address or null if not found
 */
export async function lookupENSAddress(name) {
  if (!name || !name.includes(".")) return null;

  const cacheKey = name.toLowerCase();
  if (ensCache[cacheKey] !== undefined) {
    const cachedEntry = ensCache[cacheKey];
    // Check if it's a cached object with timestamp, and if it's still valid
    if (typeof cachedEntry === 'object' && cachedEntry.timestamp) {
      if (Date.now() - cachedEntry.timestamp < ENS_CACHE_EXPIRY) {
        return cachedEntry.value;
      }
      // Otherwise cache has expired, we'll refresh it
    } else {
      // Legacy cache format - upgrade to new format with current timestamp
      ensCache[cacheKey] = {
        value: cachedEntry,
        timestamp: Date.now()
      };
      return cachedEntry;
    }
  }

  try {
    // Use readContract directly with the mainnetClient
    const result = await mainnetClient.readContract({
      address: CTC_CONTRACT_ADDRESS,
      abi: CTCAbi,
      functionName: 'whatIsTheAddressOf',
      args: [name]
    });

    const address = result && result[0] ? result[0] : null;
    // Cache the result with timestamp (even if null)
    ensCache[cacheKey] = {
      value: address,
      timestamp: Date.now()
    };
    
    // Also cache the reverse lookup
    if (address) {
      ensCache[address.toLowerCase()] = {
        value: name,
        timestamp: Date.now()
      };
    }
    
    return address;
  } catch (error) {
    console.error("Error looking up ENS address:", error);
    return null;
  }
}

/**
 * Get the SLOW contract instance
 * @returns {Object} Contract instance
 */
export function getSlowContract() {
  if (!slowContract) {
    console.warn("SLOW contract not initialized, attempting to get fresh instance");
    
    // Check if wallet client is available
    if (walletClient && basePublicClient) {
      console.warn("Wallet client available, creating fresh contract instance");
      
      try {
        // Create a fresh contract instance
        slowContract = getContract({
          address: SLOW_CONTRACT_ADDRESS,
          abi: SlowAbi,
          client: {
            public: basePublicClient,
            wallet: walletClient
          }
        });
        
        console.warn("Fresh contract instance created:", !!slowContract);
      } catch (error) {
        console.error("Error creating fresh contract instance:", error);
      }
    } else {
      console.warn("Wallet not connected, contract cannot be initialized");
    }
  }
  
  return slowContract;
}

/**
 * Create a contract instance for an ERC20 token
 * @param {string} tokenAddress - Token address
 * @returns {Object} Contract instance
 */
export function getTokenContract(tokenAddress) {
  if (!tokenAddress || !walletClient || !basePublicClient) {
    return null;
  }
  
  return getContract({
    address: tokenAddress,
    abi: erc20Abi,
    client: {
      public: basePublicClient,
      wallet: walletClient
    }
  });
}

/**
 * Get token decimals for a specific token address
 * @param {string} tokenAddress - Ethereum token address
 * @returns {Promise<number>} - Number of decimals for the token
 */
export async function getTokenDecimals(tokenAddress) {
  // Check cache first
  if (tokenDecimalsCache[tokenAddress] !== undefined) {
    return tokenDecimalsCache[tokenAddress];
  }

  // Use default for ETH
  if (tokenAddress === "0x0000000000000000000000000000000000000000") {
    tokenDecimalsCache[tokenAddress] = 18;
    return 18;
  }
  
  // Add common Base network tokens to cache if not yet initialized
  if (Object.keys(tokenDecimalsCache).length === 0) {
    // Cache common token decimals to avoid repeated contract calls
    tokenDecimalsCache["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"] = 6; // USDC on Base
    tokenDecimalsCache["0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb"] = 18; // DAI on Base
    tokenDecimalsCache["0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"] = 6; // USDT on Base
  }

  try {
    const tokenContract = getTokenContract(tokenAddress);
    
    if (!tokenContract) {
      return 18; // Default if we can't get the contract
    }

    const decimals = await tokenContract.read.decimals();
    
    // Cache the result
    tokenDecimalsCache[tokenAddress] = decimals;
    return decimals;
  } catch (error) {
    console.error("Error getting token decimals:", error);
    return 18; // Default to 18 if we can't get the decimals
  }
}

/**
 * Check if an address is valid
 * @param {string} address - Address to check
 * @returns {boolean} Is a valid address
 */
export function isValidAddress(address) {
  if (!address || typeof address !== 'string') return false;
  
  // Faster check: verify length first, then check hex pattern
  return address.length === 42 && 
         address.startsWith('0x') && 
         /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Format an Ethereum address for display (truncated)
 * @param {string} address - Ethereum address
 * @returns {string} - Truncated address
 */
export function formatAddress(address) {
  if (!address || typeof address !== 'string') return '';
  return `${address.substring(0, 6)}...${address.substring(38)}`;
}

/**
 * Check token allowance for the SLOW contract
 * @param {string} tokenAddress - Token address
 * @param {string} userAddress - User address
 * @param {number} amount - Amount to check approval for
 * @returns {Promise<boolean>} - True if allowance is sufficient
 */
export async function checkAllowance(tokenAddress, userAddress, amount) {
  try {
    if (tokenAddress === "0x0000000000000000000000000000000000000000") {
      return true; // ETH doesn't need approval
    }

    const tokenContract = getTokenContract(tokenAddress);
    if (!tokenContract) return false;

    const decimals = await getTokenDecimals(tokenAddress);
    const amountInWei = BigInt(Math.floor(amount * 10 ** decimals));

    const allowance = await tokenContract.read.allowance([
      userAddress,
      SLOW_CONTRACT_ADDRESS
    ]);

    return allowance >= amountInWei;
  } catch (error) {
    console.error("Error checking allowance:", error);
    return false;
  }
}

/**
 * Approve token spending for the SLOW contract
 * @param {string} tokenAddress - Token address
 * @returns {Promise<{success: boolean, hash?: string}>} - Result of the approval
 */
export async function approveToken(tokenAddress) {
  try {
    const tokenContract = getTokenContract(tokenAddress);
    if (!tokenContract) {
      return { success: false, message: "Token contract not available" };
    }

    // Use max uint256 for approval amount
    const maxApproval = 2n ** 256n - 1n;

    const hash = await tokenContract.write.approve([
      SLOW_CONTRACT_ADDRESS,
      maxApproval
    ]);

    return { success: true, hash };
  } catch (error) {
    console.error("Error approving token:", error);
    return { success: false, message: "Token approval failed" };
  }
}

/**
 * Wait for a transaction to be confirmed
 * @param {string} hash - Transaction hash
 * @returns {Promise<boolean>} - True if transaction confirmed
 */
export async function waitForTransaction(hash) {
  if (!hash || !basePublicClient) return false;
  
  try {
    const receipt = await basePublicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout: 60000 // 60 seconds timeout
    });
    
    return receipt.status === 1; // 1 = success, 0 = failed
  } catch (error) {
    console.error("Error waiting for transaction:", error);
    return false;
  }
}

/**
 * Deposit funds to the SLOW contract
 * @param {Object} params - Deposit parameters
 * @returns {Promise<{success: boolean, hash?: string, confirmed?: boolean}>} - Result of the deposit
 */
export async function depositFunds({
  tokenAddress,
  recipient,
  amount,
  delay,
  waitForConfirmation = false
}) {
  try {
    if (!slowContract || !walletClient) {
      return { success: false, message: "Wallet not connected" };
    }

    let txParams;
    
    if (tokenAddress === "0x0000000000000000000000000000000000000000") {
      // ETH deposit
      const decimals = 18;
      const amountInWei = BigInt(Math.floor(amount * 10 ** decimals));
      
      txParams = {
        args: [
          "0x0000000000000000000000000000000000000000", // token address
          recipient, // to address
          0n, // amount (0 for ETH, value is set separately)
          BigInt(delay), // delay in seconds
          "0x" // data
        ],
        value: amountInWei
      };
    } else {
      // ERC20 token deposit
      const decimals = await getTokenDecimals(tokenAddress);
      const amountInWei = BigInt(Math.floor(amount * 10 ** decimals));
      
      txParams = {
        args: [
          tokenAddress, // token address
          recipient, // to address
          amountInWei, // amount in token's smallest unit
          BigInt(delay), // delay in seconds
          "0x" // data
        ],
        value: 0n
      };
    }

    const hash = await slowContract.write.depositTo(txParams);
    
    // If we need to wait for confirmation, do it now
    if (waitForConfirmation) {
      const confirmed = await waitForTransaction(hash);
      return { success: true, hash, confirmed };
    }
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error depositing funds:", error);
    return { success: false, message: "Transaction failed" };
  }
}

// Export the contract addresses
export { SLOW_CONTRACT_ADDRESS, CTC_CONTRACT_ADDRESS };