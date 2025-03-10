import { formatAddress } from '../services/wallet/walletService';
import { formatTimeDiff, formatNumber } from '../services/utils';

/**
 * Class for controlling UI elements
 */
export default class UIController {
  constructor(elements) {
    this.elements = elements;
    this.actionMenu = null;
  }

  /**
   * Update UI visibility based on current screen
   * @param {string} screen - Screen to show
   */
  updateScreenVisibility(screen) {
    // Hide all screens first
    this.elements.cryptoGrid.style.display = "none";
    this.elements.amountSelector.style.display = "none";
    this.elements.timeSelector.style.display = "none";
    this.elements.confirmationModal.style.display = "none";
    this.elements.takeLinesContainer.style.display = "none";
    this.elements.transferTabs.style.display = "none";
    this.elements.customTimeModal.style.display = "none";
    this.elements.customAmountModal.style.display = "none";
    this.elements.buttonContainer.style.display = "flex";

    // Show specific screen
    switch (screen) {
      case "cryptoShown":
        this.elements.cryptoGrid.style.display = "grid";
        break;

      case "amountShown":
        this.elements.cryptoGrid.style.display = "grid";
        this.elements.amountSelector.style.display = "block";
        break;

      case "timeShown":
        this.elements.cryptoGrid.style.display = "grid";
        this.elements.amountSelector.style.display = "block";
        this.elements.timeSelector.style.display = "block";
        break;

      case "confirmationShown":
        this.elements.cryptoGrid.style.display = "grid";
        this.elements.amountSelector.style.display = "block";
        this.elements.timeSelector.style.display = "block";
        this.elements.confirmationModal.style.display = "flex";
        break;

      case "takeLinesShown":
        this.elements.takeLinesContainer.style.display = "flex";
        this.elements.transferTabs.style.display = "block";
        this.elements.buttonContainer.style.display = "none";
        break;
    }
  }

  /**
   * Toggle between light and dark mode
   */
  toggleColors() {
    this.elements.body.classList.toggle("inverted");
  }

  /**
   * Clear all selections in the UI
   */
  clearSelections() {
    // Clear crypto box selections
    Object.values(this.elements.cryptoBoxes).forEach((box) =>
      box.classList.remove("selected")
    );

    // Clear all option selections
    document
      .querySelectorAll(".amount-option, .time-option")
      .forEach((option) => option.classList.remove("selected"));

    // Reset custom option displays
    this.elements.customAmountOption.querySelector(
      ".custom-input-display"
    ).textContent = "???";
    this.elements.customTimeOption.querySelector(".custom-input-display").textContent =
      "CUSTOM";
  }

  /**
   * Restore UI selections based on state
   * @param {Object} state - State containing selections to restore
   */
  restoreSelections(state) {
    this.clearSelections();

    // Restore crypto selection
    if (state.selectedCrypto && this.elements.cryptoBoxes[state.selectedCrypto]) {
      this.elements.cryptoBoxes[state.selectedCrypto].classList.add("selected");
    }

    // Restore amount selection
    if (state.selectedAmount) {
      const standardOption = document.querySelector(
        `.amount-option[data-value="${state.selectedAmount}"]:not(.custom-input-option)`
      );

      if (standardOption) {
        standardOption.classList.add("selected");
      } else {
        // Custom amount was selected
        this.elements.customAmountOption.classList.add("selected");
        this.elements.customAmountOption.querySelector(
          ".custom-input-display"
        ).textContent = state.selectedAmount;
      }
    }

    // Restore time selection
    if (state.selectedTime) {
      const standardOption = document.querySelector(
        `.time-option[data-value="${state.selectedTime}"]:not(.custom-input-option)`
      );

      if (standardOption) {
        standardOption.classList.add("selected");
      } else if (state.selectedTimeDisplay) {
        // Custom time was selected
        this.elements.customTimeOption.classList.add("selected");
        this.elements.customTimeOption.querySelector(
          ".custom-input-display"
        ).textContent = state.selectedTimeDisplay;
      }
    }

    // Restore recipient field and status
    this.elements.recipientInput.value = state.recipient || "";
    this.elements.ensStatus.textContent = "";
    this.elements.ensStatus.className = "ens-status";
  }

  /**
   * Update wallet display
   * @param {Object} wallet - Wallet state
   */
  updateWalletDisplay(wallet) {
    if (wallet.connected) {
      if (wallet.ensName) {
        this.elements.walletButton.textContent = wallet.ensName;
      } else {
        this.elements.walletButton.textContent = formatAddress(wallet.address);
      }
    } else {
      this.elements.walletButton.textContent = "Connect Wallet";
    }
  }

  /**
   * Update the transfer view UI
   * @param {Object} appState - Application state
   * @param {Function} handleReverseAndWithdraw - Handler for reverse and withdraw
   * @param {Function} handleUnlockAndWithdraw - Handler for unlock and withdraw
   */
  updateTransferView(appState, handleReverseAndWithdraw, handleUnlockAndWithdraw) {
    const container = this.elements.takeLinesContainer;
    const transfers = appState.pendingTransfers[appState.currentState.transferTab];

    container.innerHTML = "";

    // Handle loading state
    if (appState.pendingTransfers.loading) {
      const loadingMsg = document.createElement("div");
      loadingMsg.className = "take-loading";
      loadingMsg.innerHTML = `
        <div class="spinner"></div>
        <div>Loading transfers...</div>
      `;
      container.appendChild(loadingMsg);
      return;
    }

    // Handle empty state
    if (transfers.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.textAlign = "center";
      emptyMsg.style.padding = "50px";
      emptyMsg.style.color = "#888";
      emptyMsg.textContent = `No ${appState.currentState.transferTab} transfers found.`;
      container.appendChild(emptyMsg);
      return;
    }

    // Check if we already have an action menu open and remove it
    if (this.actionMenu) {
      this.actionMenu.remove();
      this.actionMenu = null;
    }

    // Group transfers by token
    const transfersByToken = {};
    for (const transfer of transfers) {
      if (!transfersByToken[transfer.token]) {
        transfersByToken[transfer.token] = [];
      }
      transfersByToken[transfer.token].push(transfer);
    }

    // Create UI for each token group
    for (const token in transfersByToken) {
      let colorClass = "take-line-eth";
      for (const box of document.querySelectorAll(".crypto-box")) {
        if (box.dataset.token.toLowerCase() === token.toLowerCase()) {
          colorClass = `take-line-${box.id.replace("Box", "").toLowerCase()}`;
          break;
        }
      }

      const tokenTransfers = transfersByToken[token];
      const symbol = tokenTransfers[0].symbol;

      const tokenInfo = document.createElement("div");
      tokenInfo.classList.add("token-info");
      tokenInfo.innerHTML = `<span>${symbol} Transfers</span>`;
      container.appendChild(tokenInfo);

      const line = document.createElement("div");
      line.classList.add("take-line", colorClass);

      for (const transfer of tokenTransfers) {
        // Create a progress bar for better visual feedback
        const progressBar = document.createElement("div");
        progressBar.classList.add("progress-bar");

        const now = Math.floor(Date.now() / 1000);
        const elapsed = now - transfer.timestamp;
        const total = transfer.delay;
        const progress = Math.min(100, (elapsed / total) * 100);

        progressBar.style.width = `${progress}%`;
        line.appendChild(progressBar);

        const arrow = document.createElement("div");
        arrow.classList.add("progress-arrow");
        arrow.textContent = "➤";
        arrow.dataset.transferId = transfer.id;
        arrow.style.left = `${progress}%`;

        if (now >= transfer.unlockTime) {
          arrow.classList.add("completed");
        }

        const tooltip = document.createElement("div");
        tooltip.classList.add("transfer-tooltip");

        const direction =
          appState.currentState.transferTab === "outbound" ? "To" : "From";
        const counterparty =
          appState.currentState.transferTab === "outbound"
            ? transfer.to
            : transfer.from;

        let timeStatus;
        if (now >= transfer.unlockTime) {
          if (appState.currentState.transferTab === "inbound") {
            timeStatus = '<span style="color: #4CAF50">Ready to claim!</span>';
          } else {
            timeStatus = '<span style="color: #4CAF50">Ready to unlock</span>';
          }
        } else {
          const remaining = transfer.unlockTime - now;
          timeStatus = formatTimeDiff(remaining) + " remaining";
        }

        tooltip.innerHTML = `
          <div class="tooltip-row">
            <span class="tooltip-label">Amount:</span>
            <span>${formatNumber(transfer.amount)} ${symbol}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">${direction}:</span>
            <span>${formatAddress(counterparty)}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">Status:</span>
            <span>${timeStatus}</span>
          </div>
          <div class="tooltip-row">
            <span class="tooltip-label">Delay:</span>
            <span>${transfer.delay} seconds</span>
          </div>
          <div class="tooltip-row" style="margin-top: 5px; font-size: 11px; color: #888;">
            Click for actions
          </div>
        `;

        arrow.appendChild(tooltip);

        arrow.addEventListener("click", (e) => {
          e.stopPropagation();

          if (
            appState.currentState.transferTab === "inbound" &&
            now >= transfer.unlockTime
          ) {
            if (confirm(`Claim this transfer of ${transfer.amount} ${symbol}?`)) {
              handleUnlockAndWithdraw(transfer.id);
            }
          } else if (
            appState.currentState.transferTab === "outbound" &&
            now < transfer.unlockTime
          ) {
            if (
              confirm(
                `Reverse and reclaim this transfer of ${transfer.amount} ${symbol}?`
              )
            ) {
              handleReverseAndWithdraw(transfer.id);
            }
          } else {
            this.showTransferActions(transfer, arrow, appState, handleReverseAndWithdraw, handleUnlockAndWithdraw);
          }
        });

        line.appendChild(arrow);
      }

      container.appendChild(line);
    }

    // Update progress bars in real-time
    this.updateProgressBars();
  }

  /**
   * Update progress bars in real-time
   */
  updateProgressBars() {
    const now = Math.floor(Date.now() / 1000);
    const arrows = document.querySelectorAll(".progress-arrow");

    arrows.forEach((arrow) => {
      const transferId = arrow.dataset.transferId;
      const progressBar = arrow.parentElement.querySelector(".progress-bar");
      
      if (!transferId || !progressBar) return;

      // Try to find the matching transfer data
      const transferElem = document.querySelector(`.transfer-tooltip[data-id="${transferId}"]`);
      if (!transferElem) return;

      const timestamp = parseInt(transferElem.dataset.timestamp);
      const delay = parseInt(transferElem.dataset.delay);
      const unlockTime = timestamp + delay;

      if (isNaN(timestamp) || isNaN(delay)) return;

      const elapsed = now - timestamp;
      const total = delay;
      let progress = Math.min(100, (elapsed / total) * 100);

      // Cap completed arrows at 95% to keep them visible
      if (progress >= 100) {
        arrow.style.left = `95%`;
      } else {
        arrow.style.left = `${progress}%`;
      }

      // Update progress bar - allow this to go to 100%
      progressBar.style.width = `${Math.min(100, progress)}%`;

      // Check if it just completed
      if (!arrow.classList.contains("completed") && now >= unlockTime) {
        arrow.classList.add("completed");
        arrow.innerHTML = "★"; // Change to star symbol for better visibility

        // Make sure the completed arrow is very visible
        arrow.style.fontSize = "24px";
        arrow.style.lineHeight = "20px";
      }
    });
  }

  /**
   * Show transfer action menu
   * @param {Object} transfer - Transfer data
   * @param {HTMLElement} arrowElement - Arrow element that was clicked
   * @param {Object} appState - Application state
   * @param {Function} handleReverseAndWithdraw - Handler for reverse and withdraw
   * @param {Function} handleUnlockAndWithdraw - Handler for unlock and withdraw
   */
  showTransferActions(transfer, arrowElement, appState, handleReverseAndWithdraw, handleUnlockAndWithdraw) {
    // Remove any existing action menu
    if (this.actionMenu) {
      this.actionMenu.remove();
    }

    // Create new action menu
    this.actionMenu = document.createElement("div");
    this.actionMenu.className = "action-menu";

    const now = Math.floor(Date.now() / 1000);

    // Add the action menu to the document body
    document.body.appendChild(this.actionMenu);

    const remainingTime =
      transfer.unlockTime - now > 0
        ? formatTimeDiff(transfer.unlockTime - now)
        : "Timelock expired";

    const unlockDate = new Date(transfer.unlockTime * 1000).toLocaleString();

    // Create menu content
    this.actionMenu.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 8px;">
        ${formatNumber(transfer.amount)} ${transfer.symbol}
      </div>
      <div style="font-size: 12px; margin-bottom: 5px;">
        ${
          appState.currentState.transferTab === "outbound"
            ? `To: ${formatAddress(transfer.to)}`
            : `From: ${formatAddress(transfer.from)}`
        }
      </div>
      <div style="font-size: 13px; margin: 10px 0; ${
          now >= transfer.unlockTime ? "color: #4CAF50;" : ""
        }">
        ${
          now >= transfer.unlockTime
            ? "Ready to unlock!"
            : `Unlocks in: ${remainingTime}`
        }
      </div>
      <div style="font-size: 11px; color: #888; margin-bottom: 10px;">
        Unlock date: ${unlockDate}
      </div>
    `;

    // Add buttons
    const buttonsContainer = document.createElement("div");
    buttonsContainer.style.display = "flex";
    buttonsContainer.style.flexDirection = "column";
    buttonsContainer.style.gap = "8px";

    if (
      appState.currentState.transferTab === "outbound" &&
      now < transfer.unlockTime
    ) {
      const reverseBtn = document.createElement("button");
      reverseBtn.className = "action-btn reverse";
      reverseBtn.textContent = "Reverse & Claim";
      reverseBtn.addEventListener("click", () => {
        this.actionMenu.remove();
        this.actionMenu = null;
        handleReverseAndWithdraw(transfer.id);
      });
      buttonsContainer.appendChild(reverseBtn);
    }

    if (now >= transfer.unlockTime) {
      const unlockBtn = document.createElement("button");
      unlockBtn.className = "action-btn unlock";
      unlockBtn.textContent =
        appState.currentState.transferTab === "inbound"
          ? "Claim Transfer"
          : "Unlock Transfer";

      unlockBtn.addEventListener("click", () => {
        this.actionMenu.remove();
        this.actionMenu = null;

        if (appState.currentState.transferTab === "inbound") {
          handleUnlockAndWithdraw(transfer.id);
        } else {
          // Just unlock but don't withdraw for outbound transfers
          handleUnlockAndWithdraw(transfer.id);
        }
      });

      buttonsContainer.appendChild(unlockBtn);
    }

    this.actionMenu.appendChild(buttonsContainer);

    // Position the menu
    const arrowRect = arrowElement.getBoundingClientRect();
    const menuRect = this.actionMenu.getBoundingClientRect();
    let top = arrowRect.bottom + 10;
    let left = arrowRect.left - menuRect.width / 2 + 10;

    // Prevent going off screen
    if (left < 10) left = 10;
    if (left + menuRect.width > window.innerWidth - 10) {
      left = window.innerWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > window.innerHeight - 10) {
      top = arrowRect.top - menuRect.height - 10;
    }

    this.actionMenu.style.position = "fixed";
    this.actionMenu.style.left = `${left}px`;
    this.actionMenu.style.top = `${top}px`;

    // Close on click outside
    setTimeout(() => {
      document.addEventListener("click", this.closeActionMenu);
    }, 100);
  }

  /**
   * Close the action menu
   * @param {Event} e - Click event
   */
  closeActionMenu = (e) => {
    if (this.actionMenu && !this.actionMenu.contains(e.target)) {
      this.actionMenu.remove();
      this.actionMenu = null;
      document.removeEventListener("click", this.closeActionMenu);
    }
  }

  /**
   * Update UI elements after ENS resolution
   * @param {Object} result - ENS resolution result
   * @param {string} input - Input that was resolved
   */
  updateAfterENSResolution(result, input) {
    if (result.success) {
      if (result.isAddress) {
        // Input was an address, show ENS name if found
        if (result.name) {
          this.elements.ensStatus.textContent = `Resolved to ENS: ${result.name}`;
          this.elements.ensStatus.className = "ens-status ens-found";
        } else {
          this.elements.ensStatus.textContent = "Valid address";
          this.elements.ensStatus.className = "ens-status ens-found";
        }
      } else {
        // Input was an ENS name, show resolved address
        this.elements.ensStatus.textContent = `Resolved to: ${formatAddress(result.address)}`;
        this.elements.ensStatus.className = "ens-status ens-found";
      }
    } else {
      this.elements.ensStatus.textContent = result.message || "Invalid address or ENS name";
      this.elements.ensStatus.className = "ens-status ens-error";
    }
  }
}