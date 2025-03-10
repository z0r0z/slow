import { createWalletClient, createPublicClient, custom, getContract, http } from 'viem';
import { mainnet, base } from 'viem/chains';
import onboard from '../../onboard';

// Contract ABIs
const SLOW_CONTRACT_ADDRESS = "0x000000000000888741B254d37e1b27128AfEAaBC";
const CTC_CONTRACT_ADDRESS = "0x0000000000cDC1F8d393415455E382c30FBc0a84";

const SLOW_CONTRACT_ABI = [
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function depositTo(address token, address to, uint256 amount, uint96 delay, bytes data) payable returns (uint256 transferId)",
  "function withdrawFrom(address from, address to, uint256 id, uint256 amount)",
  "function reverse(uint256 transferId)",
  "function unlock(uint256 transferId)",
  "function multicall(bytes[] calldata data) returns (bytes[] memory)",
  "function pendingTransfers(uint256 transferId) view returns (uint96 timestamp, address from, address to, uint256 id, uint256 amount)",
  "function unlockedBalances(address user, uint256 id) view returns (uint256)",
  "function predictTransferId(address from, address to, uint256 id, uint256 amount) view returns (uint256)",
  "function encodeId(address token, uint256 delay) pure returns (uint256 id)",
  "function decodeId(uint256 id) pure returns (address token, uint256 delay)",
  "function canReverseTransfer(uint256 transferId) view returns (bool canReverse, bytes4 reason)",
  "event TransferPending(uint256 indexed transferId, uint256 indexed delay)",
  "event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount)",
];

const CTC_CONTRACT_ABI = [
  "function whatIsTheAddressOf(string calldata name) view returns (address _owner, address receiver, bytes32 node)",
  "function whatIsTheNameOf(address user) view returns (string memory)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Initialize a public client for read-only operations on mainnet
let mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http('https://eth-mainnet.g.alchemy.com/v2/demo')
});

// Initialize public and wallet clients for Base
let basePublicClient = null;
let walletClient = null;
let slowContract = null;
let ctcContract = null;

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
    
    // Use onboard to connect wallet and show the modal
    // Set autoselect option to false to ensure the modal always opens
    const wallets = await onboard.connectWallet();
    
    console.log("Onboard connect wallet result:", wallets);
    
    if (wallets.length === 0) {
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
      // Use onboard to set chain
      await onboard.setChain({ chainId: '0x2105' }); // Base chainId in hex
      return { success: false, message: "Please switch to Base network" };
    }
    
    // Initialize the SLOW contract with viem
    slowContract = getContract({
      address: SLOW_CONTRACT_ADDRESS,
      abi: SLOW_CONTRACT_ABI,
      publicClient: basePublicClient,
      walletClient
    });
    
    // Initialize CTC contract on mainnet
    ctcContract = getContract({
      address: CTC_CONTRACT_ADDRESS,
      abi: CTC_CONTRACT_ABI,
      publicClient: mainnetClient
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
    // Initialize CTC contract if needed
    if (!ctcContract) {
      ctcContract = getContract({
        address: CTC_CONTRACT_ADDRESS,
        abi: CTC_CONTRACT_ABI,
        publicClient: mainnetClient
      });
    }

    const name = await ctcContract.read.whatIsTheNameOf([address]);

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
    // Initialize CTC contract if needed
    if (!ctcContract) {
      ctcContract = getContract({
        address: CTC_CONTRACT_ADDRESS,
        abi: CTC_CONTRACT_ABI,
        publicClient: mainnetClient
      });
    }

    const result = await ctcContract.read.whatIsTheAddressOf([name]);

    if (result && result.receiver) {
      ensCache[cacheKey] = result.receiver;
      return result.receiver;
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
    abi: ERC20_ABI,
    publicClient: basePublicClient,
    walletClient
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