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
  depositFunds
} from './services/wallet/walletService';
import {
  loadPendingTransfers,
  reverseTransfer,
  unlockTransfer,
  unlockAndWithdraw,
  reverseAndWithdraw
} from './services/transfers/transferService';
import {
  showToast,
  showLoading,
  hideLoading,
  formatCustomTimeInputs,
  formatNumber
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
    console.log("Clicked handleConnectWallet")
    const result = await connectWallet();
    
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
    // elements.$wallet.classList.remove("hidden");
    elements.$disconnected.classList.add("hidden");
    
    // Force update the wallet button text
    const walletBtn = document.getElementById("walletButton");
    if (walletBtn) {
      walletBtn.textContent = result.ensName || formatAddress(result.address);
      console.log("Updated wallet button text to:", walletBtn.textContent);
    }
    
    showToast(elements.toast, "Wallet connected successfully!", 3000);
    
    // Load pending transfers with forceRefresh to avoid "Already loading transfers" error
    await handleLoadPendingTransfers(true);
    
    hideLoading(elements.loadingIndicator);
    return true;
  } catch (error) {
    console.error("Error connecting wallet:", error);
    showToast(elements.toast, "Failed to connect wallet. Please try again.", 3000);
    hideLoading(elements.loadingIndicator);
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
          handleUnlockAndWithdraw
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
    await handleConnectWallet();
    if (!appState.wallet.connected) return;
  }
  
  showLoading(elements.loadingIndicator, elements.loadingText, "Unlocking and withdrawing funds...");
  
  const result = await unlockAndWithdraw({
    transferId,
    userAddress: appState.wallet.address
  });
  
  hideLoading(elements.loadingIndicator);
  
  if (result.success) {
    showToast(elements.toast, "Transfer unlocked and funds withdrawn!", 5000);
    
    // Refresh transfers
    await handleLoadPendingTransfers();
  } else {
    showToast(elements.toast, result.message || "Failed to unlock and withdraw", 5000);
  }
}

/**
 * Reverse and withdraw a transfer
 * @param {string} transferId - ID of the transfer to reverse and withdraw
 */
async function handleReverseAndWithdraw(transferId) {
  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    await handleConnectWallet();
    if (!appState.wallet.connected) return;
  }
  
  showLoading(elements.loadingIndicator, elements.loadingText, "Reversing transfer...");
  
  const result = await reverseAndWithdraw({
    transferId,
    userAddress: appState.wallet.address
  });
  
  hideLoading(elements.loadingIndicator);
  
  if (result.success) {
    showToast(elements.toast, "Transfer reversed and funds returned!", 5000);
    
    // Refresh transfers
    await handleLoadPendingTransfers();
  } else {
    showToast(elements.toast, result.message || "Failed to reverse and withdraw", 5000);
  }
}

/**
 * Deposit funds to the SLOW contract
 */
async function handleDepositFunds() {
  try {
    if (!appState.wallet.connected) {
      showToast(elements.toast, "Please connect your wallet first.", 3000);
      await handleConnectWallet();
      if (!appState.wallet.connected) return;
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

    showLoading(elements.loadingIndicator, elements.loadingText, "Creating time-locked transfer...");
    
    const result = await depositFunds({
      tokenAddress: selectedCryptoAddress,
      recipient: resolvedAddress,
      amount: selectedAmount,
      delay: selectedTime
    });

    if (result.success) {
      showLoading(elements.loadingIndicator, elements.loadingText, "Transaction confirmed! Loading updated transfers...");
      showToast(elements.toast, "Transaction confirmed! Funds sent to SLOW contract.", 5000);
      
      // Refresh transfers and reset app state
      await handleLoadPendingTransfers();
      resetApp();
    } else {
      showToast(elements.toast, result.message || "Transaction failed. Please try again.", 5000);
    }
    
    hideLoading(elements.loadingIndicator);
  } catch (error) {
    console.error("Error depositing funds:", error);
    hideLoading(elements.loadingIndicator);
    showToast(elements.toast, "Transaction failed. Please try again.", 5000);
  }
}

// ==========================================
// UI Control Functions
// ==========================================

/**
 * Handle background clicks and modal dismissals
 */
elements.body.addEventListener("click", function (event) {
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
  ];

  // Check if clicked on action menu
  if (
    uiController.actionMenu &&
    (uiController.actionMenu.contains(event.target) || uiController.actionMenu === event.target)
  ) {
    return;
  }

  const isInteractive = interactiveElements.some(
    (el) => el && el.contains(event.target),
  );

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
});

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
elements.backButton.addEventListener("click", function (event) {
  event.stopPropagation();

  // Handle modals first
  if (elements.confirmationModal.style.display === "flex") {
    elements.confirmationModal.style.display = "none";
    elements.recipientInput.value = "";
    elements.ensStatus.textContent = "";
    elements.ensStatus.className = "ens-status";
    appState.currentState.screen = "timeShown";
    return;
  }

  if (elements.approveModal.style.display === "flex") {
    elements.approveModal.style.display = "none";
    return;
  }

  if (elements.customTimeModal.style.display === "flex") {
    elements.customTimeModal.style.display = "none";
    return;
  }

  if (elements.customAmountModal.style.display === "flex") {
    elements.customAmountModal.style.display = "none";
    return;
  }

  // Handle state history
  if (appState.goBack()) {
    const currentState = appState.currentState;
    const previousState = { ...currentState };

    // Handle background color
    if (
      previousState.invertedBackground !==
      currentState.invertedBackground
    ) {
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
});

/**
 * Handle send box click
 */
elements.sendBox.addEventListener("click", function (event) {
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
});

/**
 * Handle take box click
 */
elements.takeBox.addEventListener("click", function (event) {
  event.stopPropagation();

  if (!appState.wallet.connected) {
    showToast(elements.toast, "Please connect your wallet first", 3000);
    handleConnectWallet().then((connected) => {
      if (connected) {
        handleTakeBoxClick();
      }
    });
    return;
  }

  handleTakeBoxClick();
});

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
    handleLoadPendingTransfers();
  } else {
    uiController.updateScreenVisibility("initial");
    appState.currentState.screen = "initial";
  }

  elements.backButton.style.display = "block";
}

/**
 * Handle wallet button click
 */
elements.walletButton.addEventListener("click", async function (event) {
  event.stopPropagation();
  console.log("Wallet button clicked");
  
  if (appState.wallet.connected) {
    handleDisconnectWallet();
  } else {
    try {
      await handleConnectWallet();
    } catch (error) {
      console.error("Wallet button connection error:", error);
      showToast(elements.toast, "Failed to connect wallet", 3000);
    }
  }
});

/**
 * Handle connect button click
 */
elements.$connect.addEventListener("click", async (event) => {
  event.stopPropagation();
  console.log("Connect button clicked");
  try {
    await handleConnectWallet();
  } catch (error) {
    console.error("Connect button error:", error);
    showToast(elements.toast, "Failed to connect wallet", 3000);
  }
});

/**
 * Handle disconnect button click
 */
elements.$disconnect.addEventListener("click", (event) => {
  event.stopPropagation();
  handleDisconnectWallet();
});

/**
 * Handle outbound tab click
 */
elements.outboundTab.addEventListener("click", function (event) {
  event.stopPropagation();

  elements.outboundTab.classList.add("active");
  elements.inboundTab.classList.remove("active");

  appState.currentState.transferTab = "outbound";
  uiController.updateTransferView(
    appState,
    handleReverseAndWithdraw,
    handleUnlockAndWithdraw
  );
});

/**
 * Handle inbound tab click
 */
elements.inboundTab.addEventListener("click", function (event) {
  event.stopPropagation();

  elements.inboundTab.classList.add("active");
  elements.outboundTab.classList.remove("active");

  appState.currentState.transferTab = "inbound";
  uiController.updateTransferView(
    appState,
    handleReverseAndWithdraw,
    handleUnlockAndWithdraw
  );
});

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
elements.recipientInput.addEventListener("input", async function () {
  const input = this.value.trim();
  appState.currentState.recipient = input;

  if (input.length > 0) {
    if (this.ensTimeout) {
      clearTimeout(this.ensTimeout);
    }

    this.ensTimeout = setTimeout(async () => {
      const result = await resolveAddressOrENS(input);
      uiController.updateAfterENSResolution(result, input);
    }, 500);
  } else {
    elements.ensStatus.textContent = "";
    elements.ensStatus.className = "ens-status";
    appState.currentState.resolvedAddress = null;
  }
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

  // Handle window blur/focus events
  window.addEventListener("blur", () => {
    // Clear only UI update intervals, not transaction timeouts
    if (appState.timeoutIds.progressBarUpdate) {
      clearInterval(appState.timeoutIds.progressBarUpdate);
      delete appState.timeoutIds.progressBarUpdate;
    }
  });

  window.addEventListener("focus", () => {
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
          appState.timeoutIds.progressBarUpdate = setInterval(
            () => uiController.updateProgressBars(),
            5000
          );
        }
      }
    }
  });

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

  window.addEventListener("online", () => {
    showToast(elements.toast, "You're back online!", 3000);

    if (
      appState.currentState.screen === "takeLinesShown" &&
      appState.wallet.connected
    ) {
      handleLoadPendingTransfers();
    }
  });

  window.addEventListener("offline", () => {
    showToast(elements.toast, "You're offline. Please check your connection.", 5000);
  });

  // Check for Ethereum wallet
  if (!window.ethereum) {
    elements.walletButton.textContent = "Install MetaMask";
    elements.walletButton.addEventListener("click", () => {
      window.open("https://metamask.io/download.html", "_blank");
    });
  }

  checkConnection();
}

// Initialize the application
init();