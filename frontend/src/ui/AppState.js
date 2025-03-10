/**
 * Class for managing application state
 */
export default class AppState {
  constructor() {
    this.history = [];
    this.currentState = {
      screen: "initial",
      invertedBackground: false,
      sendBoxClicked: false,
      takeBoxClicked: false,
      selectedCrypto: null,
      selectedCryptoAddress: null,
      selectedCryptoSymbol: null,
      selectedAmount: null,
      selectedTime: null,
      selectedTimeDisplay: null,
      recipient: null,
      resolvedAddress: null,
      transferTab: "outbound",
      lookingUpENS: false,
    };
    this.timeoutIds = {};
    this.wallet = {
      connected: false,
      address: null,
      walletClient: null,
      publicClient: null,
      chainId: null,
      ensName: null,
      label: null,
    };
    this.pendingTransfers = {
      outbound: [],
      inbound: [],
      lastUpdated: 0,
      loading: false,
      unlockedTransferIds: new Set(),
    };
    this.ensCache = {};
    this.tokenDecimals = {};
    this.inputCache = {
      amount: null,
      time: {
        days: null,
        hours: null,
        minutes: null,
        seconds: null,
      },
    };
  }

  /**
   * Save current state to history
   */
  saveState() {
    this.history.push(JSON.parse(JSON.stringify(this.currentState)));
  }

  /**
   * Go back to previous state
   * @returns {boolean} True if able to go back
   */
  goBack() {
    if (this.history.length === 0) {
      return false;
    }

    this.currentState = this.history.pop();
    return true;
  }

  /**
   * Check if back is available
   * @returns {boolean} True if back is available
   */
  canGoBack() {
    return this.history.length > 0;
  }

  /**
   * Update wallet state
   * @param {Object} walletState - New wallet state
   */
  updateWallet(walletState) {
    this.wallet = {
      ...this.wallet,
      ...walletState
    };
  }

  /**
   * Update pending transfers
   * @param {Object} transfers - New transfers
   */
  updateTransfers(transfers) {
    this.pendingTransfers = {
      ...this.pendingTransfers,
      ...transfers
    };
  }

  /**
   * Reset app to initial state
   */
  resetApp() {
    // Clear all timeouts
    for (const key in this.timeoutIds) {
      if (typeof this.timeoutIds[key] === "number") {
        clearTimeout(this.timeoutIds[key]);
      } else if (typeof this.timeoutIds[key] === "function") {
        clearInterval(this.timeoutIds[key]);
      }
    }

    this.timeoutIds = {};
    this.history = [];

    // Reset to initial state
    this.currentState = {
      screen: "initial",
      invertedBackground: false,
      sendBoxClicked: false,
      takeBoxClicked: false,
      selectedCrypto: null,
      selectedCryptoAddress: null,
      selectedCryptoSymbol: null,
      selectedAmount: null,
      selectedTime: null,
      selectedTimeDisplay: null,
      recipient: null,
      resolvedAddress: null,
      transferTab: "outbound",
      lookingUpENS: false,
    };
  }
}