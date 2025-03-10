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
      slowContract = getContract({
        address: SLOW_CONTRACT_ADDRESS,
        abi: SlowAbi,
        client: { 
          public: basePublicClient,
          wallet: walletClient
        }
      });
          
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
      await onboard.setChain({ chainId: 8453 }); // Base chainId
      return { success: false, message: "Please switch to Base network" };
    }
    
    // Initialize the SLOW contract with viem
    slowContract = getContract({
      address: SLOW_CONTRACT_ADDRESS,
      abi: SlowAbi,
      client: {
        public: basePublicClient,
        wallet: walletClient
      }
    });
        
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
  if (ensCache[cacheKey]) {
    return ensCache[cacheKey];
  }

  try {
    // Use readContract directly with the mainnetClient
    const name = await mainnetClient.readContract({
      address: CTC_CONTRACT_ADDRESS,
      abi: CTCAbi,
      functionName: 'whatIsTheNameOf',
      args: [address]
    });

    if (name) {
      ensCache[cacheKey] = name;
    }

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
  if (ensCache[cacheKey]) {
    return ensCache[cacheKey];
  }

  try {
    // Use readContract directly with the mainnetClient
    console.log("ENS Try", name)
    const result = await mainnetClient.readContract({
      address: CTC_CONTRACT_ADDRESS,
      abi: CTCAbi,
      functionName: 'whatIsTheAddressOf',
      args: [name]
    });

    console.log("ENS Result", result)

    if (result && result[0]) {
      ensCache[cacheKey] = result[0];
      return result[0];
    }

    return null;
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
  if (tokenDecimalsCache[tokenAddress]) {
    return tokenDecimalsCache[tokenAddress];
  }

  // Use default for ETH
  if (tokenAddress === "0x0000000000000000000000000000000000000000") {
    tokenDecimalsCache[tokenAddress] = 18;
    return 18;
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
  
  // Simple regex check for Ethereum address format
  return /^0x[a-fA-F0-9]{40}$/.test(address);
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
 * Deposit funds to the SLOW contract
 * @param {Object} params - Deposit parameters
 * @returns {Promise<{success: boolean, hash?: string}>} - Result of the deposit
 */
export async function depositFunds({
  tokenAddress,
  recipient,
  amount,
  delay
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
    
    return { success: true, hash };
  } catch (error) {
    console.error("Error depositing funds:", error);
    return { success: false, message: "Transaction failed" };
  }
}

// Export the contract addresses
export { SLOW_CONTRACT_ADDRESS, CTC_CONTRACT_ADDRESS };