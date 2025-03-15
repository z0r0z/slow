import "./polyfills";
import "./styles.css";
import AppState from './ui/AppState';
import UIController from './ui/UIController';
import { 
  connectWallet, 
  disconnectWallet, 
  lookupENSName, 
  lookupENSAddress, 
  isValidAddress,
  formatAddress,
  checkAllowance,
  approveToken,
  depositFunds,
  getSlowContract
} from './services/wallet/walletService';
import {
  loadPendingTransfers,
  reverseTransfer,
  unlockTransfer,
  unlockAndWithdraw,
  reverseAndWithdraw,
  setupTransferRefreshAfterTx
} from './services/transfers/transferService';
import {
  showToast,
  showLoading,
  hideLoading,
  formatCustomTimeInputs,
  formatNumber,
  debounce
} from './services/utils';

// Initialize application state
const appState = new AppState();

// DOM elements
const elements = {
  body: document.body,
  backButton: document.getElementById("backButton"),
  buttonContainer: document.getElementById("buttonContainer"),
  sendBox: document.getElementById("sendBox"),
  takeBox: document.getElementById("takeBox"),
  cryptoGrid: document.getElementById("cryptoGrid"),
  amountSelector: document.getElementById("amountSelector"),
  timeSelector: document.getElementById("timeSelector"),
  takeLinesContainer: document.getElementById("takeLinesContainer"),
  confirmationModal: document.getElementById("confirmationModal"),
  modalContent: document.getElementById("modalContent"),
  modalSummary: document.getElementById("modalSummary"),
  recipientInput: document.getElementById("recipientInput"),
  ensStatus: document.getElementById("ensStatus"),
  confirmButton: document.getElementById("confirmButton"),
  loadingIndicator: document.getElementById("loadingIndicator"),
  loadingText: document.getElementById("loadingText"),
  toast: document.getElementById("toastNotification"),
  walletButton: document.getElementById("walletButton"),
  $connect: document.querySelector(".connect-button"),
  $disconnect: document.querySelector(".disconnect-button"),
  $wallet: document.querySelector(".wallet"),
  $disconnected: document.querySelector(".disconnected"),
  $address: document.querySelector(".address"),
  $label: document.querySelector(".label"),
  approveModal: document.getElementById("approveModal"),
  approveButton: document.getElementById("approveButton"),
  approveDetails: document.getElementById("approveDetails"),
  transferTabs: document.getElementById("transferTabs"),
  outboundTab: document.getElementById("outboundTab"),
  inboundTab: document.getElementById("inboundTab"),
  customAmountOption: document.getElementById("customAmountOption"),
  customAmountModal: document.getElementById("customAmountModal"),
  customAmountInputModal: document.getElementById("customAmountInputModal"),
  applyCustomAmount: document.getElementById("applyCustomAmount"),
  customTimeOption: document.getElementById("customTimeOption"),
  customTimeModal: document.getElementById("customTimeModal"),
  daysInput: document.getElementById("daysInput"),
  hoursInput: document.getElementById("hoursInput"),
  minutesInput: document.getElementById("minutesInput"),
  secondsInput: document.getElementById("secondsInput"),
  applyCustomTime: document.getElementById("applyCustomTime"),
  cryptoBoxes: {
    eth: document.getElementById("ethBox"),
    usdc: document.getElementById("usdcBox"),
    dai: document.getElementById("daiBox"),
    usdt: document.getElementById("usdtBox"),
  },
};

// Create UI controller
const uiController = new UIController(elements);

// ==========================================
// Wallet Connection Functions
// ==========================================

/**
 * Connect to Ethereum wallet
 * @returns {Promise<boolean>} - True if successfully connected
 */
async function handleConnectWallet() {
  try {
    console.log("Clicked handleConnectWallet");
    // Always use a tiny delay before starting wallet connection
    // This ensures any DOM events finish processing
    await new Promise(resolve => setTimeout(resolve, 50));
    
    console.log("Initiating wallet connection...");
    try {
      const result = await connectWallet();
      
      // Show loading only after the wallet popup is handled
      showLoading(elements.loadingIndicator, elements.loadingText, "Finalizing connection...");
      
      if (!result.success) {
        showToast(elements.toast, result.message || "Failed to connect wallet.", 3000);
        hideLoading(elements.loadingIndicator);
        return false;
      }
      
      // Update application state
      appState.updateWallet({
        connected: true,
        address: result.address,
        walletClient: result.walletClient,
        publicClient: result.publicClient,
        chainId: result.chainId,
        ensName: result.ensName,
        label: result.label
      });
      
      // Update UI
      if (result.ensName) {
        elements.walletButton.textContent = result.ensName;
      } else {
        elements.walletButton.textContent = formatAddress(result.address);
      }
      
      elements.$address.innerHTML = formatAddress(result.address);
      elements.$disconnected.classList.add("hidden");
      
      // Force update the wallet button text
      const walletBtn = document.getElementById("walletButton");
      if (walletBtn) {
        walletBtn.textContent = result.ensName || formatAddress(result.address);
        console.log("Updated wallet button text to:", walletBtn.textContent);
      }
      
      showToast(elements.toast, "Wallet connected successfully!", 3000);
      
      // Verify contract connection after wallet is connected
      const slowContract = getSlowContract();
      if (!slowContract) {
        console.warn("Warning: SLOW contract not initialized after wallet connection");
        showToast(elements.toast, "Wallet connected, but contract not initialized. Please try reloading the page.", 5000);
      } else {
        console.log("SLOW contract initialized successfully after wallet connection");
      }
      
      // Load pending transfers with forceRefresh to avoid "Already loading transfers" error
      await handleLoadPendingTransfers(true);
      
      hideLoading(elements.loadingIndicator);
      return true;
    } catch (connectError) {
      console.error("Error in connectWallet:", connectError);
      hideLoading(elements.loadingIndicator);
      showToast(elements.toast, "Failed to connect wallet. Please try again.", 3000);
      return false;
    }
  } catch (error) {
    console.error("Error in handleConnectWallet:", error);
    hideLoading(elements.loadingIndicator);
    showToast(elements.toast, "Failed to connect wallet. Please try again.", 3000);
    return false;
  }
}

/**
 * Disconnect wallet
 */
function handleDisconnectWallet() {
  try {
    disconnectWallet(appState.wallet.label);
    
    // Update application state
    appState.updateWallet({
      connected: false,
      address: null,
      walletClient: null,
      publicClient: null,
      chainId: null,
      ensName: null,
      label: null
    });
    
    // Update UI
    elements.walletButton.textContent = "Connect Wallet";
    elements.$wallet.classList.add("hidden");
    elements.$disconnected.classList.remove("hidden"); // Show connect button when disconnected
    
    localStorage.removeItem("walletConnected");
    showToast(elements.toast, "Wallet disconnected", 3000);
    
    // Reset app state
    resetApp();
  } catch (error) {
    console.error("Error disconnecting wallet:", error);
    showToast(elements.toast, "Failed to disconnect wallet", 3000);
  }
}

// ==========================================
// ENS Resolution Functions
// ==========================================

/**
 * Resolve a string as either an ENS name or Ethereum address
 * @param {string} input - ENS name or Ethereum address
 * @returns {Promise<{success: boolean, address?: string, name?: string, isAddress?: boolean, message?: string}>} - Result object
 */
async function resolveAddressOrENS(input) {
  // Set looking up state
  appState.currentState.lookingUpENS = true;
  elements.ensStatus.textContent = "Resolving address";
  elements.ensStatus.className = "ens-status ens-loading";
  
  try {
    if (isValidAddress(input)) {
      // Input is an Ethereum address
      appState.currentState.resolvedAddress = input;
      // Use the direct resolution method
      const name = await lookupENSName(input);
      
      appState.currentState.lookingUpENS = false;
      return {
        success: true,
        address: input,
        name,
        isAddress: true
      };
    } else if (input.includes(".")) {
      // Input might be an ENS name
      // Use the direct resolution method that doesn't require wallet connection
      const address = await lookupENSAddress(input);
      
      if (address && isValidAddress(address)) {
        appState.currentState.resolvedAddress = address;
        appState.currentState.lookingUpENS = false;
        return {
          success: true,
          address,
          isAddress: false
        };
      } else {
        appState.currentState.resolvedAddress = null;
        appState.currentState.lookingUpENS = false;
        return {
          success: false,
          message: "Could not resolve ENS name"
        };
      }
    } else {
      appState.currentState.resolvedAddress = null;
      appState.currentState.lookingUpENS = false;
      return {
        success: false,
        message: "Invalid address or ENS name"
      };
    }
  } catch (error) {
    console.error("Error resolving address or ENS:", error);
    appState.currentState.resolvedAddress = null;
    appState.currentState.lookingUpENS = false;
    return {
      success: false,
      message: "Error resolving address"
    };
  }
}

// ==========================================
// Transfer Management Functions
// ==========================================

/**
 * Load pending transfers
 * @param {boolean} forceRefresh - Force refresh even if already loading
 */
async function handleLoadPendingTransfers(forceRefresh = false) {
  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    return;
  }
  
  try {
    // Show loading UI if we're in the take view
    if (appState.currentState.screen === "takeLinesShown") {
      elements.takeLinesContainer.innerHTML = `
        <div class="take-loading">
          <div class="spinner"></div>
          <div>Loading transfers...</div>
        </div>
      `;
    }
    
    const result = await loadPendingTransfers({
      address: appState.wallet.address,
      publicClient: appState.wallet.publicClient,
      isDetailed: true,
      forceRefresh: forceRefresh
    });
    
    if (result.success) {
      appState.updateTransfers({
        outbound: result.outbound,
        inbound: result.inbound,
        loading: false,
        lastUpdated: Date.now()
      });
      
      // Update UI if we're in the take view
      if (appState.currentState.screen === "takeLinesShown") {
        uiController.updateTransferView(
          appState,
          handleReverseAndWithdraw,
          handleUnlockAndWithdraw,
          handleUnlockTransfer
        );
      }
    } else {
      showToast(elements.toast, result.message || "Failed to load transfers", 3000);
      
      // Show error in the take view
      if (appState.currentState.screen === "takeLinesShown") {
        elements.takeLinesContainer.innerHTML = `
          <div class="take-loading">
            <div>Failed to load transfers. Please try again.</div>
            <button class="modal-button" style="margin-top: 20px" onclick="handleLoadPendingTransfers()">Retry</button>
          </div>
        `;
      }
    }
  } catch (error) {
    console.error("Error loading pending transfers:", error);
    showToast(elements.toast, "Failed to load transfers", 3000);
  }
}

/**
 * Unlock and withdraw a transfer
 * @param {string} transferId - ID of the transfer to unlock and withdraw
 */
async function handleUnlockAndWithdraw(transferId) {
  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    const connected = await handleConnectWallet();
    if (!connected) return;
  }
  
  console.log("Executing unlock and withdraw for transfer:", transferId);
  
  try {
    // Don't show loading until after wallet interaction
    const result = await unlockAndWithdraw({
      transferId,
      userAddress: appState.wallet.address
    });
    
    if (result.success) {
      showToast(elements.toast, "Transfer unlocked and funds withdrawn!", 5000);
      
      // Refresh transfers
      await handleLoadPendingTransfers(true);
    } else {
      showToast(elements.toast, result.message || "Failed to unlock and withdraw", 5000);
    }
  } catch (error) {
    console.error("Error in unlock and withdraw:", error);
    hideLoading(elements.loadingIndicator);
    
    let errorMessage = "Failed to unlock transfer";
    
    if (error.message) {
      if (error.message.includes("rejected") || error.message.includes("cancelled")) {
        errorMessage = "Transaction was rejected in wallet";
      } else if (error.message.includes("timelock")) {
        errorMessage = "Transfer timelock has not expired yet";
      } else {
        errorMessage += ": " + error.message;
      }
    }
    
    showToast(elements.toast, errorMessage, 5000);
  }
}

/**
 * Just unlock a transfer for the recipient (without withdrawing)
 * @param {string} transferId - ID of the transfer to unlock
 */
async function handleUnlockTransfer(transferId) {
  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    const connected = await handleConnectWallet();
    if (!connected) return;
  }
  
  console.log("Executing unlock for transfer:", transferId);
  
  try {
    // Don't show loading until after wallet interaction
    const result = await unlockTransfer({
      transferId
    });
    
    if (result.success) {
      showToast(elements.toast, "Transfer unlocked for recipient successfully!", 5000);
      
      // Refresh transfers
      await handleLoadPendingTransfers(true);
    } else {
      showToast(elements.toast, result.message || "Failed to unlock transfer", 5000);
    }
  } catch (error) {
    console.error("Error in unlock transfer:", error);
    hideLoading(elements.loadingIndicator);
    
    let errorMessage = "Failed to unlock transfer";
    
    if (error.message) {
      if (error.message.includes("rejected") || error.message.includes("cancelled")) {
        errorMessage = "Transaction was rejected in wallet";
      } else if (error.message.includes("timelock")) {
        errorMessage = "Transfer timelock has not expired yet";
      } else {
        errorMessage += ": " + error.message;
      }
    }
    
    showToast(elements.toast, errorMessage, 5000);
  }
}

/**
 * Reverse and withdraw a transfer
 * @param {string} transferId - ID of the transfer to reverse and withdraw
 */
async function handleReverseAndWithdraw(transferId) {
  console.warn("▶️ handleReverseAndWithdraw called with transferId:", transferId);
  
  try {
    // Check wallet connection
    if (!appState.wallet.connected) {
      console.warn("❌ Wallet not connected");
      showToast(elements.toast, "Please connect your wallet first", 3000);
      const connected = await handleConnectWallet();
      if (!connected) {
        return; // User canceled or connection failed
      }
    }
    
    console.warn("✅ Wallet connected, preparing to reverse transfer");
    
    // First verify that we can reverse this transfer
    // Get the current contract instance
    let slowContract = getSlowContract();
    console.warn("Retrieved slow contract:", !!slowContract);
    
    if (!slowContract) {
      console.warn("SlowContract not available, attempting to reconnect wallet");
      
      // Try to reconnect the wallet
      const walletConnectionResult = await connectWallet();
      console.warn("Wallet reconnection result:", walletConnectionResult);
      
      // Try to get the contract again
      slowContract = getSlowContract();
      console.warn("Refreshed contract available:", !!slowContract);
      
      if (!slowContract) {
        showToast(elements.toast, "Contract not available. Please check your connection and try again.", 5000);
        return;
      }
    }
    
    // Check if transfer can be reversed - but don't show loading yet
    // to allow wallet popup to be visible
    try {
      console.warn("Checking if transfer can be reversed...");
      const canReverseResult = await slowContract.read.canReverseTransfer([transferId]);
      const canReverse = canReverseResult[0];
      const reason = canReverseResult[1];
      
      console.warn("Can reverse check:", { canReverse, reason });
      
      if (!canReverse) {
        if (reason === "0x8f9a780c") {
          showToast(elements.toast, "This transfer can't be reversed because the timelock has expired.", 5000);
        } else {
          showToast(elements.toast, "This transfer can't be reversed.", 5000);
        }
        return;
      }
    } catch (checkError) {
      console.error("Error checking if transfer can be reversed:", checkError);
      if (checkError.message && checkError.message.includes("contract not available")) {
        showToast(elements.toast, "Contract not available. Please check your wallet connection and try again.", 5000);
        return;
      }
      // Continue anyway for other errors - the main reverseAndWithdraw will do this check again
    }
    
    // Verify we have a valid address before proceeding
    if (!appState.wallet.address) {
      showToast(elements.toast, "Wallet address not found. Please try reconnecting your wallet.", 5000);
      return;
    }
    
    // Execute the reverse and withdraw operation - Without loading yet
    // to allow the wallet popup to be visible
    console.warn("Calling reverseAndWithdraw with:", {
      transferId,
      userAddress: appState.wallet.address
    });
    
    // Now execute the transaction and wait for the wallet popup
    const result = await reverseAndWithdraw({
      transferId,
      userAddress: appState.wallet.address
    });
    
    // After transaction is sent (and wallet popup is handled), show loading
    // while we wait for confirmation
    showLoading(elements.loadingIndicator, elements.loadingText, "Processing transaction...");
    
    // Once we get a result, hide loading
    hideLoading(elements.loadingIndicator);
    
    if (result.success) {
      // Show appropriate success message based on operation details
      if (result.message) {
        showToast(elements.toast, result.message, 5000);
      } else if (result.withdrawHash) {
        // Two separate transactions were used
        showToast(elements.toast, "Transfer reversed and funds returned in two transactions!", 5000);
      } else if (result.hash) {
        // One multicall transaction was used
        showToast(elements.toast, "Transfer reversed and funds returned in a single multicall transaction!", 5000);
      } else {
        // Generic fallback
        showToast(elements.toast, "Transfer reversed and funds returned!", 5000);
      }
      
      // Refresh transfers
      await handleLoadPendingTransfers(true);
    } else {
      // Enhanced error message
      let errorMsg = result.message || "Failed to reverse and withdraw";
      
      // Provide guidance on what to do next
      if (errorMsg.includes("rejected")) {
        errorMsg = "Transaction was rejected in your wallet. Try again when you're ready.";
      } else if (errorMsg.includes("gas")) {
        errorMsg = "Gas estimation failed. Try again or try during lower network congestion.";
      }
      
      showToast(elements.toast, errorMsg, 5000);
    }
  } catch (error) {
    console.error("Error in handleReverseAndWithdraw:", error);
    hideLoading(elements.loadingIndicator);
    
    // Provide a more user-friendly error message
    let errorMessage = "Failed to reverse transfer";
    
    if (error.message) {
      if (error.message.includes("user rejected") || 
          error.message.includes("User rejected") || 
          error.message.includes("cancelled") || 
          error.message.includes("denied")) {
        errorMessage = "Transaction was rejected in wallet";
      } else if (error.message.includes("TimelockExpired")) {
        errorMessage = "Transfer can't be reversed because the timelock has expired";
      } else if (error.message.includes("Unauthorized")) {
        errorMessage = "You are not authorized to reverse this transfer";
      } else if (error.message.includes("gas")) {
        errorMessage = "Transaction failed due to gas estimation. Try again.";
      } else if (error.message.includes("wallet")) {
        errorMessage = "Wallet connection issue. Please try reconnecting.";
      } else {
        errorMessage += ": " + error.message;
      }
    }
    
    showToast(elements.toast, errorMessage, 5000);
  }
}

/**
 * Deposit funds to the SLOW contract
 */
async function handleDepositFunds() {
  try {
    if (!appState.wallet.connected) {
      showToast(elements.toast, "Please connect your wallet first.", 3000);
      const connected = await handleConnectWallet();
      if (!connected) return;
    }

    const {
      selectedCryptoAddress,
      selectedAmount,
      selectedTime,
      resolvedAddress,
    } = appState.currentState;

    if (!resolvedAddress) {
      showToast(elements.toast, "Please enter a valid recipient address or ENS name.", 3000);
      return;
    }

    console.log("Preparing to deposit funds to SLOW contract...");
    
    // First execute the transaction - don't show loading so wallet popup is visible
    const result = await depositFunds({
      tokenAddress: selectedCryptoAddress,
      recipient: resolvedAddress,
      amount: selectedAmount,
      delay: selectedTime,
      waitForConfirmation: true // Wait for blockchain confirmation
    });

    // Show loading after wallet interaction, for blockchain confirmation
    showLoading(elements.loadingIndicator, elements.loadingText, "Waiting for confirmation...");

    if (result.success) {
      if (result.confirmed) {
        showToast(elements.toast, "Transaction confirmed! Funds sent to SLOW contract.", 5000);
      } else {
        showToast(elements.toast, "Transaction sent! Waiting for confirmation...", 5000);
      }
      
      showLoading(elements.loadingIndicator, elements.loadingText, "Updating transfer data...");
      
      // Set up polling for updated transfers
      setupTransferRefreshAfterTx(result.hash, appState.wallet.address);
      
      // Wait a bit for our initial transfer data to be updated
      setTimeout(async () => {
        // First force-refresh transfers
        await handleLoadPendingTransfers(true);
        hideLoading(elements.loadingIndicator);
        
        // Reset app state and go back to initial view
        resetApp();
        
        // Show toast encouraging user to check the transfers tab
        showToast(elements.toast, "Your new transfer will appear in the 'Take' tab once confirmed.", 5000);
      }, 2000);
    } else {
      hideLoading(elements.loadingIndicator);
      
      let errorMessage = result.message || "Transaction failed. Please try again.";
      
      // Make transaction rejection messages more user-friendly
      if (errorMessage.includes("rejected") || errorMessage.includes("cancelled")) {
        errorMessage = "Transaction was rejected in your wallet.";
      }
      
      showToast(elements.toast, errorMessage, 5000);
    }
  } catch (error) {
    console.error("Error depositing funds:", error);
    hideLoading(elements.loadingIndicator);
    
    let errorMessage = "Transaction failed. Please try again.";
    
    if (error.message) {
      if (error.message.includes("rejected") || error.message.includes("cancelled")) {
        errorMessage = "Transaction was rejected in your wallet.";
      } else if (error.message.includes("insufficient")) {
        errorMessage = "Insufficient funds for this transfer.";
      }
    }
    
    showToast(elements.toast, errorMessage, 5000);
  }
}

// ==========================================
// UI Control Functions
// ==========================================

/**
 * Handle background clicks and modal dismissals
 */
elements.body.onclick = function(event) {
  // Debug to see what element was clicked
  console.log("🔍 Body click detected on:", event.target.tagName, 
              event.target.id ? `#${event.target.id}` : '',
              event.target.className ? `.${event.target.className.split(' ').join('.')}` : '');
  
  // List of interactive elements that should handle their own clicks
  const interactiveElements = [
    elements.buttonContainer,
    elements.cryptoGrid,
    elements.backButton,
    elements.amountSelector,
    elements.timeSelector,
    elements.modalContent,
    elements.takeLinesContainer,
    elements.walletButton,
    elements.approveModal,
    elements.transferTabs,
    elements.customTimeModal,
    elements.customAmountModal,
    elements.sendBox,
    elements.takeBox,
    elements.$connect,
    elements.$disconnect,
    elements.$wallet,
  ];

  // Check if clicked on action menu
  if (
    uiController.actionMenu &&
    (uiController.actionMenu.contains(event.target) || uiController.actionMenu === event.target)
  ) {
    console.log("Click on action menu - let the menu handle it");
    return;
  }

  // Check if the click was on an interactive element
  const isInteractive = interactiveElements.some(
    (el) => el && el.contains(event.target)
  );
  
  // Log the interactive status
  console.log("Is interactive element:", isInteractive);

  // Handle confirmation modal click outside
  if (
    elements.confirmationModal.style.display === "flex" &&
    !elements.modalContent.contains(event.target)
  ) {
    event.stopPropagation();
    elements.confirmationModal.style.display = "none";
    appState.currentState.screen = "timeShown";
    return;
  }

  // Handle approve modal click outside
  if (
    elements.approveModal.style.display === "flex" &&
    !elements.approveModal
      .querySelector(".approve-content")
      .contains(event.target)
  ) {
    event.stopPropagation();
    elements.approveModal.style.display = "none";
    return;
  }

  // Handle custom amount modal click outside
  if (
    elements.customAmountModal.style.display === "flex" &&
    !elements.customAmountModal
      .querySelector(".custom-amount-content")
      .contains(event.target)
  ) {
    event.stopPropagation();
    elements.customAmountModal.style.display = "none";
    return;
  }

  // Handle custom time modal click outside
  if (
    elements.customTimeModal.style.display === "flex" &&
    !elements.customTimeModal
      .querySelector(".custom-time-content")
      .contains(event.target)
  ) {
    event.stopPropagation();
    elements.customTimeModal.style.display = "none";
    return;
  }

  // Handle background click for color toggle
  if (!isInteractive) {
    appState.saveState();
    appState.currentState.invertedBackground =
      !appState.currentState.invertedBackground;
    uiController.toggleColors();
    elements.backButton.style.display = "block";
  }
};

/**
 * Reset application state
 */
function resetApp() {
  // Reset app state
  appState.resetApp();

  // Reset UI elements
  if (elements.body.classList.contains("inverted")) {
    elements.body.classList.remove("inverted");
  }

  elements.sendBox.classList.remove("clicked");
  elements.takeBox.classList.remove("clicked");

  uiController.clearSelections();

  elements.recipientInput.value = "";
  elements.ensStatus.textContent = "";
  elements.ensStatus.className = "ens-status";

  uiController.updateScreenVisibility("initial");
  elements.backButton.style.display = "none";
}

/**
 * Handle back button clicks
 */
elements.backButton.onclick = function(event) {
  console.log("💥 Back button ONCLICK triggered");
  event.stopPropagation();

  // Handle modals first
  if (elements.confirmationModal.style.display === "flex") {
    elements.confirmationModal.style.display = "none";
    elements.recipientInput.value = "";
    elements.ensStatus.textContent = "";
    elements.ensStatus.className = "ens-status";
    appState.currentState.screen = "timeShown";
    return false;
  }

  if (elements.approveModal.style.display === "flex") {
    elements.approveModal.style.display = "none";
    return false;
  }

  if (elements.customTimeModal.style.display === "flex") {
    elements.customTimeModal.style.display = "none";
    return false;
  }

  if (elements.customAmountModal.style.display === "flex") {
    elements.customAmountModal.style.display = "none";
    return false;
  }

  // Handle state history
  if (appState.goBack()) {
    const currentState = appState.currentState;
    const previousState = { ...currentState };

    // Handle background color
    if (previousState.invertedBackground !== currentState.invertedBackground) {
      uiController.toggleColors();
    }

    // Handle send box
    if (previousState.sendBoxClicked !== currentState.sendBoxClicked) {
      elements.sendBox.classList.toggle("clicked");
    }

    // Handle take box
    if (previousState.takeBoxClicked !== currentState.takeBoxClicked) {
      elements.takeBox.classList.toggle("clicked");
    }

    // Update UI
    uiController.updateScreenVisibility(currentState.screen);
    uiController.restoreSelections(currentState);

    // Hide back button if we're at initial state with no inversions
    if (
      !appState.canGoBack() &&
      currentState.screen === "initial" &&
      !currentState.sendBoxClicked &&
      !currentState.takeBoxClicked &&
      !currentState.invertedBackground
    ) {
      elements.backButton.style.display = "none";
    }
  }
  return false;
};

/**
 * Handle send box click
 */
elements.sendBox.onclick = function(event) {
  console.log("💥 Send box ONCLICK triggered");
  event.stopPropagation();

  appState.saveState();
  elements.sendBox.classList.toggle("clicked");
  appState.currentState.sendBoxClicked = !appState.currentState.sendBoxClicked;

  if (elements.cryptoGrid.style.display !== "grid") {
    uiController.updateScreenVisibility("cryptoShown");
    appState.currentState.screen = "cryptoShown";
  } else {
    uiController.updateScreenVisibility("initial");
    appState.currentState.screen = "initial";
  }

  elements.backButton.style.display = "block";
  return false;
};

/**
 * Handle take box click
 */
elements.takeBox.onclick = function(event) {
  console.log("💥 Take box ONCLICK triggered");
  event.stopPropagation();

  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    
    handleConnectWallet()
      .then((connected) => {
        if (connected) {
          handleTakeBoxClick();
        }
      })
      .catch(error => {
        console.error("Error connecting wallet from take box:", error);
      });
    return false;
  }

  handleTakeBoxClick();
  return false;
};

/**
 * Helper function for take box click handling
 */
function handleTakeBoxClick() {
  appState.saveState();
  elements.takeBox.classList.toggle("clicked");
  appState.currentState.takeBoxClicked = !appState.currentState.takeBoxClicked;

  if (appState.currentState.takeBoxClicked) {
    uiController.updateScreenVisibility("takeLinesShown");
    appState.currentState.screen = "takeLinesShown";
    
    // Hide the transfer tabs as we're showing both inbound and outbound transfers
    elements.transferTabs.style.display = "none";
    
    // Set to loading state first
    const loadingMsg = document.createElement("div");
    loadingMsg.className = "take-loading";
    loadingMsg.innerHTML = `
      <div class="spinner"></div>
      <div>Loading transfers...</div>
    `;
    elements.takeLinesContainer.innerHTML = '';
    elements.takeLinesContainer.appendChild(loadingMsg);
    
    // Always force-refresh the transfers when entering the Take view
    // This ensures we have the latest data, even after a recent transaction
    handleLoadPendingTransfers(true);
  } else {
    uiController.updateScreenVisibility("initial");
    appState.currentState.screen = "initial";
  }

  elements.backButton.style.display = "block";
}

/**
 * Handle wallet button click
 */
// Direct onclick handler for more reliable behavior
elements.walletButton.onclick = function(event) {
  // Debug to see if this handler is triggered
  console.log("💥 Wallet button ONCLICK triggered");
  
  event.stopPropagation();
  console.log("Wallet connection state:", appState.wallet.connected);
  
  if (appState.wallet.connected) {
    handleDisconnectWallet();
  } else {
    console.log("⚠️ Attempting wallet connection from button click");
    handleConnectWallet().catch(error => {
      console.error("Wallet button connection error:", error);
      showToast(elements.toast, "Failed to connect wallet", 3000);
    });
  }
  
  // Return false to prevent default behavior
  return false;
};

/**
 * Handle connect button click
 */
elements.$connect.onclick = function(event) {
  // Debug to see if this handler is triggered
  console.log("💥 Connect button ONCLICK triggered");
  
  event.stopPropagation();
  // Don't use async here - directly call the function
  handleConnectWallet().catch(error => {
    console.error("Connect button error:", error);
    showToast(elements.toast, "Failed to connect wallet", 3000);
  });
  
  // Return false to prevent default behavior
  return false;
};

/**
 * Handle disconnect button click
 */
elements.$disconnect.onclick = function(event) {
  console.log("💥 Disconnect button ONCLICK triggered");
  event.stopPropagation();
  handleDisconnectWallet();
  return false;
};

// We no longer need tab click handlers as we show both inbound and outbound transfers
// The tabs will be hidden in the UI

/**
 * Handle crypto box selection
 */
Object.keys(elements.cryptoBoxes).forEach((crypto) => {
  elements.cryptoBoxes[crypto].addEventListener("click", function (event) {
    event.stopPropagation();

    appState.saveState();
    uiController.clearSelections();

    this.classList.add("selected");
    appState.currentState.selectedCrypto = crypto;
    appState.currentState.selectedCryptoAddress = this.dataset.token;
    appState.currentState.selectedCryptoSymbol = this.dataset.symbol;

    uiController.updateScreenVisibility("amountShown");
    appState.currentState.screen = "amountShown";
    elements.backButton.style.display = "block";
  });
});

/**
 * Handle amount selection
 */
elements.amountSelector.addEventListener("click", function (event) {
  const option = event.target.closest(
    ".amount-option:not(.custom-input-option)",
  );
  if (!option) return;

  event.stopPropagation();
  appState.saveState();

  document
    .querySelectorAll(".amount-option")
    .forEach((el) => el.classList.remove("selected"));

  option.classList.add("selected");
  appState.currentState.selectedAmount = parseFloat(option.dataset.value);

  uiController.updateScreenVisibility("timeShown");
  appState.currentState.screen = "timeShown";
  elements.backButton.style.display = "block";
});

/**
 * Handle time selection
 */
elements.timeSelector.addEventListener("click", function (event) {
  const option = event.target.closest(".time-option:not(.custom-input-option)");
  if (!option) return;

  event.stopPropagation();
  appState.saveState();

  document
    .querySelectorAll(".time-option")
    .forEach((el) => el.classList.remove("selected"));

  option.classList.add("selected");
  appState.currentState.selectedTime = parseInt(option.dataset.value);
  appState.currentState.selectedTimeDisplay = option.dataset.display;

  elements.modalSummary.textContent = `${appState.currentState.selectedAmount} ${appState.currentState.selectedCryptoSymbol} with ${option.dataset.display} time delay`;

  elements.confirmationModal.style.display = "flex";
  elements.recipientInput.focus();

  appState.currentState.screen = "confirmationShown";
  elements.backButton.style.display = "block";
});

/**
 * Handle custom amount option click
 */
elements.customAmountOption.addEventListener("click", function (event) {
  event.stopPropagation();

  // Restore any previously entered custom amount in the modal
  if (appState.inputCache.amount !== null) {
    elements.customAmountInputModal.value = appState.inputCache.amount;
  } else {
    elements.customAmountInputModal.value = "";
  }

  // Show custom amount modal
  elements.customAmountModal.style.display = "flex";
});

/**
 * Handle custom amount application
 */
elements.applyCustomAmount.addEventListener("click", function (event) {
  event.stopPropagation();

  const customAmount = parseFloat(elements.customAmountInputModal.value);
  if (isNaN(customAmount) || customAmount <= 0) {
    showToast(elements.toast, "Please enter a valid amount greater than 0", 3000);
    return;
  }

  appState.saveState();

  // Cache the custom amount
  appState.inputCache.amount = customAmount;

  // Clear other selections and mark custom option as selected
  document
    .querySelectorAll(".amount-option")
    .forEach((el) => el.classList.remove("selected"));
  elements.customAmountOption.classList.add("selected");

  // Update the display in the custom option
  elements.customAmountOption.querySelector(
    ".custom-input-display"
  ).textContent = formatNumber(customAmount);

  // Update application state
  appState.currentState.selectedAmount = customAmount;

  // Hide modal and show time selector
  elements.customAmountModal.style.display = "none";
  uiController.updateScreenVisibility("timeShown");
  appState.currentState.screen = "timeShown";
  elements.backButton.style.display = "block";
});

/**
 * Handle custom time option click
 */
elements.customTimeOption.addEventListener("click", function (event) {
  event.stopPropagation();

  // Restore any previously entered custom time values
  const timeCache = appState.inputCache.time;
  elements.daysInput.value = timeCache.days !== null ? timeCache.days : "";
  elements.hoursInput.value = timeCache.hours !== null ? timeCache.hours : "";
  elements.minutesInput.value = timeCache.minutes !== null ? timeCache.minutes : "";
  elements.secondsInput.value = timeCache.seconds !== null ? timeCache.seconds : "";

  // Show custom time modal
  elements.customTimeModal.style.display = "flex";
});

/**
 * Handle custom time application
 */
elements.applyCustomTime.addEventListener("click", function (event) {
  event.stopPropagation();

  const timeInputs = {
    days: elements.daysInput.value,
    hours: elements.hoursInput.value,
    minutes: elements.minutesInput.value,
    seconds: elements.secondsInput.value
  };
  
  // Cache the custom time inputs
  appState.inputCache.time = {
    days: timeInputs.days || null,
    hours: timeInputs.hours || null,
    minutes: timeInputs.minutes || null,
    seconds: timeInputs.seconds || null,
  };
  
  const timeResult = formatCustomTimeInputs(timeInputs);

  if (timeResult.seconds <= 0) {
    showToast(elements.toast, "Please enter a time greater than 0 seconds", 3000);
    return;
  }

  appState.saveState();

  // Clear other selections and mark custom option as selected
  document
    .querySelectorAll(".time-option")
    .forEach((el) => el.classList.remove("selected"));
  elements.customTimeOption.classList.add("selected");

  // Update the display in the custom option
  elements.customTimeOption.querySelector(".custom-input-display").textContent =
    timeResult.display;

  // Update application state
  appState.currentState.selectedTime = timeResult.seconds;
  appState.currentState.selectedTimeDisplay = timeResult.display;

  // Hide modal and show confirmation
  elements.customTimeModal.style.display = "none";
  elements.modalSummary.textContent = `${appState.currentState.selectedAmount} ${appState.currentState.selectedCryptoSymbol} with ${timeResult.display} time delay`;
  elements.confirmationModal.style.display = "flex";
  elements.recipientInput.focus();

  appState.currentState.screen = "confirmationShown";
  elements.backButton.style.display = "block";
});

/**
 * Handle recipient input with ENS resolution
 */
// Create a debounced ENS resolver function with improved performance
const debouncedENSResolver = debounce(async (input) => {
  if (input.length > 0) {
    // Only proceed with ENS resolution for inputs that look legitimate
    if (input.length >= 3 && (input.includes('.') || (input.startsWith('0x') && input.length >= 10))) {
      const result = await resolveAddressOrENS(input);
      uiController.updateAfterENSResolution(result, input);
    } else {
      elements.ensStatus.textContent = "Type a valid address or ENS name";
      elements.ensStatus.className = "ens-status ens-error";
      appState.currentState.resolvedAddress = null;
    }
  } else {
    elements.ensStatus.textContent = "";
    elements.ensStatus.className = "ens-status";
    appState.currentState.resolvedAddress = null;
  }
}, 400); // Reduce debounce time for better responsiveness

elements.recipientInput.addEventListener("input", function () {
  const input = this.value.trim();
  appState.currentState.recipient = input;

  if (input.length === 0) {
    elements.ensStatus.textContent = "";
    elements.ensStatus.className = "ens-status";
    appState.currentState.resolvedAddress = null;
    return;
  }

  // Use the debounced function for better performance
  debouncedENSResolver(input);
});

/**
 * Handle confirm button click
 */
elements.confirmButton.addEventListener("click", async function (event) {
  event.stopPropagation();

  // First resolve the ENS address if needed - this can work without wallet connection
  if (!appState.currentState.resolvedAddress) {
    if (appState.currentState.lookingUpENS) {
      showToast(elements.toast, "Please wait while we resolve the address...", 3000);
      return;
    }

    const input = elements.recipientInput.value.trim();
    const result = await resolveAddressOrENS(input);
    uiController.updateAfterENSResolution(result, input);

    if (!result.success) {
      showToast(elements.toast, "Please enter a valid Ethereum address or ENS name", 3000);
      elements.recipientInput.focus();
      return;
    }
  }
  
  // Then check wallet connection status
  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet to continue", 3000);
    await handleConnectWallet();
    if (!appState.wallet.connected) return;
  }

  elements.confirmationModal.style.display = "none";

  // Check if token approval is needed
  if (
    appState.currentState.selectedCryptoAddress !==
    "0x0000000000000000000000000000000000000000"
  ) {
    const hasAllowance = await checkAllowance(
      appState.currentState.selectedCryptoAddress,
      appState.wallet.address,
      appState.currentState.selectedAmount
    );

    if (!hasAllowance) {
      elements.approveDetails.textContent = `Allow SLOW contract to use your ${appState.currentState.selectedCryptoSymbol}`;
      elements.approveModal.style.display = "flex";
      return;
    }
  }

  await handleDepositFunds();
});

/**
 * Handle approve button click
 */
elements.approveButton.addEventListener("click", async function (event) {
  event.stopPropagation();

  showLoading(elements.loadingIndicator, elements.loadingText, "Approving token...");

  const result = await approveToken(appState.currentState.selectedCryptoAddress);

  if (result.success) {
    showToast(elements.toast, "Token approval successful!", 3000);
    elements.approveModal.style.display = "none";
    
    // Now deposit the funds
    await handleDepositFunds();
  } else {
    showToast(elements.toast, result.message || "Token approval failed. Please try again.", 5000);
  }
  
  hideLoading(elements.loadingIndicator);
});

/**
 * Handle Enter key in recipient input
 */
elements.recipientInput.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    elements.confirmButton.click();
  }
});

// ==========================================
// Application Initialization
// ==========================================

/**
 * Initialize the application
 */
function init() {
  // Initialize UI
  uiController.updateScreenVisibility("initial");
  elements.backButton.style.display = "none";
  
  // Initialize wallet display
  if (appState.wallet.connected) {
    elements.$wallet.classList.remove("hidden");
    elements.$disconnected.classList.add("hidden");
  } else {
    elements.$wallet.classList.add("hidden");
    elements.$disconnected.classList.remove("hidden"); // Show connect button when disconnected
  }
  
  // IMPORTANT: Do not add duplicate passive event listeners
  // The existing click handler is already properly attached and working
  // These passive handlers are causing conflicts with the actual handlers

  // Safely attach a single window blur handler
  window.onblur = function() {
    console.log("Window blur detected");
    // Clear only UI update intervals, not transaction timeouts
    if (appState.timeoutIds.progressBarUpdate) {
      clearInterval(appState.timeoutIds.progressBarUpdate);
      delete appState.timeoutIds.progressBarUpdate;
    }
  };

  // Safely attach a single window focus handler
  window.onfocus = function() {
    console.log("Window focus detected");
    if (
      appState.currentState.screen === "takeLinesShown" &&
      appState.wallet.connected
    ) {
      // Only reload transfers if it's been a while since the last update
      if (Date.now() - appState.pendingTransfers.lastUpdated > 60000) {
        handleLoadPendingTransfers(true); // Force refresh to avoid "Already loading" state
      } else {
        // Just update the progress bars
        uiController.updateProgressBars();

        // Set up interval for progress bar updates if not already running
        if (!appState.timeoutIds.progressBarUpdate) {
          // Use a more efficient update interval (10 seconds instead of 5)
          appState.timeoutIds.progressBarUpdate = setInterval(
            () => uiController.updateProgressBars(),
            10000
          );
        }
      }
    }
  };

  // Network connectivity checks
  function checkConnection() {
    if (!navigator.onLine) {
      showToast(
        elements.toast,
        "You appear to be offline. Some features may not work properly.",
        5000
      );
    }
  }

  // Safely attach single online/offline handlers
  window.ononline = function() {
    console.log("Online status detected");
    showToast(elements.toast, "You're back online!", 3000);

    if (
      appState.currentState.screen === "takeLinesShown" &&
      appState.wallet.connected
    ) {
      handleLoadPendingTransfers();
    }
  };

  window.onoffline = function() {
    console.log("Offline status detected");
    showToast(elements.toast, "You're offline. Please check your connection.", 5000);
  };

  // Check for Ethereum wallet
  if (!window.ethereum) {
    console.log("No Ethereum provider detected, showing install option");
    elements.walletButton.textContent = "Install MetaMask";
    // Override the existing onclick handler with MetaMask installation
    elements.walletButton.onclick = function() {
      window.open("https://metamask.io/download.html", "_blank");
      return false;
    };
  }

  checkConnection();
}

// Initialize the application
init();