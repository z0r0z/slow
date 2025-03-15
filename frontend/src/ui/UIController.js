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
        // We no longer show tabs since we display both inbound and outbound transfers
        this.elements.transferTabs.style.display = "none";
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
    // Batch DOM manipulations inside requestAnimationFrame for better performance
    requestAnimationFrame(() => {
      // Clear crypto box selections - use direct access for better performance
      const cryptoBoxes = this.elements.cryptoBoxes;
      for (const key in cryptoBoxes) {
        if (cryptoBoxes[key]) {
          cryptoBoxes[key].classList.remove("selected");
        }
      }

      // Clear all option selections
      // Use faster selectors and direct manipulation
      const amountOptions = document.querySelectorAll(".amount-option");
      const timeOptions = document.querySelectorAll(".time-option");
      
      for (let i = 0; i < amountOptions.length; i++) {
        amountOptions[i].classList.remove("selected");
      }
      
      for (let i = 0; i < timeOptions.length; i++) {
        timeOptions[i].classList.remove("selected");
      }

      // Reset custom option displays
      if (this.elements.customAmountOption) {
        const amountDisplay = this.elements.customAmountOption.querySelector(".custom-input-display");
        if (amountDisplay) amountDisplay.textContent = "???";
      }
      
      if (this.elements.customTimeOption) {
        const timeDisplay = this.elements.customTimeOption.querySelector(".custom-input-display");
        if (timeDisplay) timeDisplay.textContent = "CUSTOM";
      }
    });
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
    
    // If returning to the take view, hide the tabs as we now show both types
    if (state.screen === "takeLinesShown") {
      this.elements.transferTabs.style.display = "none";
    }
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
   * @param {Function} handleUnlockTransfer - Handler for just unlocking (for recipient)
   */
  updateTransferView(appState, handleReverseAndWithdraw, handleUnlockAndWithdraw, handleUnlockTransfer) {
    const container = this.elements.takeLinesContainer;
    
    // Add debug info for troubleshooting
    console.log("UpdateTransferView - wallet info:", {
      hasWallet: !!appState.wallet,
      walletAddress: appState.wallet?.address,
      connected: appState.wallet?.connected
    });
    
    // Create a document fragment to minimize DOM operations
    const fragment = document.createDocumentFragment();
    
    // Clear the container
    container.innerHTML = "";

    // Handle loading state
    if (appState.pendingTransfers.loading) {
      const loadingMsg = document.createElement("div");
      loadingMsg.className = "take-loading";
      loadingMsg.innerHTML = `
        <div class="spinner"></div>
        <div>Loading transfers...</div>
      `;
      fragment.appendChild(loadingMsg);
      container.appendChild(fragment);
      return;
    }

    // Check if we already have an action menu open and remove it
    if (this.actionMenu) {
      this.actionMenu.remove();
      this.actionMenu = null;
    }

    // Get both outbound and inbound transfers
    const outboundTransfers = appState.pendingTransfers.outbound || [];
    const inboundTransfers = appState.pendingTransfers.inbound || [];

    // Handle empty state for both types
    if (outboundTransfers.length === 0 && inboundTransfers.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.textAlign = "center";
      emptyMsg.style.padding = "50px";
      emptyMsg.style.color = "#888";
      emptyMsg.textContent = "No pending transfers found.";
      fragment.appendChild(emptyMsg);
      container.appendChild(fragment);
      return;
    }

    // Always create both sections, even if empty
    // This ensures the tracks are always shown
    this.createTransferSection(
      fragment, 
      "Outbound Transfers", 
      "➡️", 
      outboundTransfers, 
      "outbound",
      handleReverseAndWithdraw,
      handleUnlockAndWithdraw,
      handleUnlockTransfer
    );
    
    this.createTransferSection(
      fragment, 
      "Inbound Transfers", 
      "⬅️", 
      inboundTransfers, 
      "inbound",
      handleReverseAndWithdraw,
      handleUnlockAndWithdraw,
      handleUnlockTransfer
    );

    // Append the fragment to the container in a single DOM operation
    container.appendChild(fragment);
    
    // Update progress bars in real-time
    this.updateProgressBars();
  }

  /**
   * Create a transfer section (outbound or inbound)
   * @param {DocumentFragment} fragment - Document fragment to append to
   * @param {string} title - Section title (not used anymore)
   * @param {string} icon - Direction icon (not used anymore)
   * @param {Array} transfers - Array of transfers
   * @param {string} direction - Direction type (outbound or inbound)
   * @param {Function} handleReverseAndWithdraw - Handler for reverse and withdraw
   * @param {Function} handleUnlockAndWithdraw - Handler for unlock and withdraw
   * @param {Function} handleUnlockTransfer - Handler for just unlocking (for recipient)
   */
  createTransferSection(fragment, title, icon, transfers, direction, handleReverseAndWithdraw, handleUnlockAndWithdraw, handleUnlockTransfer) {
    // Create section container
    const section = document.createElement("div");
    section.classList.add("transfer-section");
    
    // Add a section title
    const sectionTitle = document.createElement("div");
    sectionTitle.classList.add("transfer-section-title");
    sectionTitle.textContent = direction === "outbound" ? "Outbound Transfers" : "Inbound Transfers";
    section.appendChild(sectionTitle);

    // Create track (line)
    const track = document.createElement("div");
    track.classList.add("transfer-track", `${direction}-track`);
    
    // Add animated direction arrows
    const directionArrows = document.createElement("div");
    directionArrows.classList.add("transfer-direction-arrows");
    
    // Create a very long pattern of arrows with subtle characters for a gentle crawling effect
    const arrowChar = direction === "outbound" ? "›" : "‹";
    // Use many small characters with spacing for a subtle continuous flow
    const arrowPattern = (arrowChar + " ").repeat(120);
    
    directionArrows.innerHTML = `<div class="arrow-flow">${arrowPattern}</div>`;
    
    track.appendChild(directionArrows);
    section.appendChild(track);

    // Process all transfers together
    for (const transfer of transfers) {
      // Get token details and color class based on token address
      let tokenIconClass = "token-icon-eth";
      let tokenSymbol = "ETH";
      
      // Use transfer.symbol if available, otherwise determine from token address
      if (transfer.symbol) {
        const symbol = transfer.symbol.toLowerCase();
        // Map symbol to token class
        if (symbol === "eth") {
          tokenIconClass = "token-icon-eth";
          tokenSymbol = "ETH";
        } else if (symbol === "usdc") {
          tokenIconClass = "token-icon-usdc";
          tokenSymbol = "USDC";
        } else if (symbol === "dai") {
          tokenIconClass = "token-icon-dai";
          tokenSymbol = "DAI";
        } else if (symbol === "usdt") {
          tokenIconClass = "token-icon-usdt";
          tokenSymbol = "USDT";
        }
      } else {
        // Fallback to looking up by token address if no symbol
        for (const box of document.querySelectorAll(".crypto-box")) {
          if (box.dataset.token && transfer.token && 
              box.dataset.token.toLowerCase() === transfer.token.toLowerCase()) {
            tokenSymbol = box.dataset.symbol;
            tokenIconClass = `token-icon-${box.id.replace("Box", "").toLowerCase()}`;
            break;
          }
        }
      }

      const symbol = transfer.symbol || tokenSymbol;
      
      // Calculate progress
      const now = Math.floor(Date.now() / 1000);
      const elapsed = now - transfer.timestamp;
      const total = transfer.delay;
      const progress = Math.min(100, (elapsed / total) * 100);

      // Create progress indicator
      const progressIndicator = document.createElement("div");
      progressIndicator.classList.add("progress-indicator");
      progressIndicator.style.width = direction === "outbound" ? `${progress}%` : `${100 - progress}%`;
      track.appendChild(progressIndicator);

      // Create token icon
      const tokenIcon = document.createElement("div");
      tokenIcon.classList.add("token-icon", tokenIconClass);
      // No text is needed as we're using SVG backgrounds
      tokenIcon.dataset.transferId = transfer.id;
      tokenIcon.dataset.timestamp = transfer.timestamp;
      tokenIcon.dataset.delay = transfer.delay;
      
      // Position based on progress (left for outbound, right for inbound)
      if (direction === "outbound") {
        // Outbound moves left to right
        tokenIcon.style.left = `${progress}%`;
      } else {
        // Inbound is right to left, so invert the progress
        tokenIcon.style.left = `${100 - progress}%`;
      }

      if (now >= transfer.unlockTime) {
        tokenIcon.classList.add("completed");
      }

      // Create tooltip
      const tooltip = document.createElement("div");
      tooltip.classList.add("transfer-tooltip");
      tooltip.dataset.id = transfer.id;
      
      // Position tooltip properly
      if (direction === "outbound") {
        tooltip.style.bottom = "30px"; // Position above for outbound
        tooltip.style.left = "50%";
        tooltip.style.transform = "translateX(-50%)";
      } else {
        tooltip.style.top = "30px"; // Position below for inbound
        tooltip.style.left = "50%";
        tooltip.style.transform = "translateX(-50%)";
      }

      const directionLabel = direction === "outbound" ? "To" : "From";
      const counterparty = direction === "outbound" ? transfer.to : transfer.from;

      let timeStatus;
      if (now >= transfer.unlockTime) {
        if (direction === "inbound") {
          timeStatus = '<span style="color: #4CAF50">Ready to claim!</span>';
        } else {
          timeStatus = '<span style="color: #4CAF50">Ready to unlock</span>';
        }
      } else {
        const remaining = transfer.unlockTime - now;
        timeStatus = formatTimeDiff(remaining) + " remaining";
      }

      // Add clear status indicator at the top of tooltip
      const isCompleted = now >= transfer.unlockTime;
      const statusClass = isCompleted ? 'tooltip-status-complete' : 'tooltip-status-pending';
      
      tooltip.innerHTML = `
        ${isCompleted ? 
          `<div class="${statusClass}" style="margin-bottom: 8px;">
            ✓ READY TO CLAIM
          </div>` : 
          `<div class="${statusClass}" style="margin-bottom: 8px;">
            ⏱ IN PROGRESS
          </div>`
        }
        <div class="tooltip-row">
          <span class="tooltip-label">Amount:</span>
          <span>${formatNumber(transfer.amount)} ${symbol}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">${directionLabel}:</span>
          <span>${formatAddress(counterparty)}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Status:</span>
          <span>${timeStatus}</span>
        </div>
        <div class="tooltip-row">
          <span class="tooltip-label">Delay:</span>
          <span>${formatTimeDiff(transfer.delay)}</span>
        </div>
        <div class="tooltip-row" style="margin-top: 8px; font-size: 11px; color: #888; text-align: center;">
          Click for actions
        </div>
      `;

      tokenIcon.appendChild(tooltip);

      // Set up click event handler - simplified for direct user flow
      tokenIcon.addEventListener("click", function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        console.log("TRANSFER CLICKED:", transfer.id, direction, transfer);
        
        // Check if this is an outbound, pending transfer
        const isOutbound = direction === 'outbound';
        const isPending = Math.floor(Date.now() / 1000) < transfer.unlockTime;
        const now = Math.floor(Date.now() / 1000);
        const isCompleted = now >= transfer.unlockTime;
        
        // Create a semi-transparent backdrop
        const backdrop = document.createElement('div');
        backdrop.style.position = 'fixed';
        backdrop.style.top = '0';
        backdrop.style.left = '0';
        backdrop.style.width = '100%';
        backdrop.style.height = '100%';
        backdrop.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        backdrop.style.zIndex = '9998';
        document.body.appendChild(backdrop);
        
        // Common function to remove backdrop and modal
        const closeModal = (modal) => {
          if (modal) modal.remove();
          backdrop.remove();
        };
        
        // For outbound pending transfers - show reverse & claim option
        if (isOutbound && isPending) {
          // Create a prominent action modal
          const actionModal = document.createElement('div');
          actionModal.style.position = 'fixed';
          actionModal.style.top = '50%';
          actionModal.style.left = '50%';
          actionModal.style.transform = 'translate(-50%, -50%)';
          actionModal.style.padding = '20px';
          actionModal.style.minWidth = '300px';
          actionModal.style.background = 'black';
          actionModal.style.color = 'white';
          actionModal.style.border = '3px solid #d4af37'; // Gold border for reverse action
          actionModal.style.zIndex = '9999';
          actionModal.style.borderRadius = '10px';
          actionModal.style.boxShadow = '0 0 25px rgba(255, 215, 0, 0.5)';
          
          // Add simple, clean content
          actionModal.innerHTML = `
            <h3 style="margin-top:0; text-align:center; color:#d4af37;">Reverse Transfer</h3>
            <div style="text-align:center; font-size:18px; font-weight:bold; margin:15px 0;">
              ${transfer.amount} ${transfer.symbol}
            </div>
            <p style="margin-bottom:20px; line-height:1.4; text-align:center;">
              This will cancel the pending transfer and return the funds to your wallet.
              <br><br>
              <strong>You will need to sign a transaction in your wallet.</strong>
            </p>
          `;
          
          // Button container
          const buttonContainer = document.createElement('div');
          buttonContainer.style.display = 'flex';
          buttonContainer.style.gap = '10px';
          
          // Create confirm button
          const confirmBtn = document.createElement('button');
          confirmBtn.innerText = 'Reverse Transfer';
          confirmBtn.style.flex = '1';
          confirmBtn.style.background = '#d4af37';
          confirmBtn.style.color = 'black';
          confirmBtn.style.fontWeight = 'bold';
          confirmBtn.style.padding = '12px';
          confirmBtn.style.border = 'none';
          confirmBtn.style.borderRadius = '5px';
          confirmBtn.style.cursor = 'pointer';
          
          confirmBtn.onclick = function() {
            // Show a simple loading message
            actionModal.innerHTML = `
              <h3 style="margin-top:0; text-align:center; color:#d4af37;">Processing Transaction...</h3>
              <p style="text-align:center; margin-bottom:20px;">Please confirm the transaction in your wallet.</p>
              
              <div style="display:flex; justify-content:center; margin:20px 0;">
                <div style="width:40px; height:40px; border:4px solid #d4af37; border-radius:50%; border-top-color:transparent; animation:spin 1s linear infinite;"></div>
              </div>
              <style>@keyframes spin { 100% { transform:rotate(360deg); }}</style>
            `;
            
            // Call the handler with a slight delay to allow the UI to update
            setTimeout(() => {
              handleReverseAndWithdraw(transfer.id)
                .then(() => {
                  // Close the modal on success - the toast will show the result
                  closeModal(actionModal);
                })
                .catch(error => {
                  // On error, update the modal to show a simplified error message
                  actionModal.innerHTML = `
                    <h3 style="margin-top:0; text-align:center; color:#d4af37;">Transaction Error</h3>
                    <p style="color:red; margin:15px 0; text-align:center;">${error.message || "Transaction failed"}</p>
                    <button id="errorCloseBtn" style="width:100%; background:#333; color:white; padding:10px; border:none; border-radius:5px; cursor:pointer;">Close</button>
                  `;
                  
                  document.getElementById('errorCloseBtn').onclick = function() {
                    closeModal(actionModal);
                  };
                });
            }, 100);
          };
          
          // Create cancel button
          const cancelBtn = document.createElement('button');
          cancelBtn.innerText = 'Cancel';
          cancelBtn.style.flex = '1';
          cancelBtn.style.background = '#333';
          cancelBtn.style.color = 'white';
          cancelBtn.style.padding = '12px';
          cancelBtn.style.border = 'none';
          cancelBtn.style.borderRadius = '5px';
          cancelBtn.style.cursor = 'pointer';
          
          cancelBtn.onclick = function() {
            closeModal(actionModal);
          };
          
          // Add buttons to container
          buttonContainer.appendChild(confirmBtn);
          buttonContainer.appendChild(cancelBtn);
          actionModal.appendChild(buttonContainer);
          
          // Add modal to page
          document.body.appendChild(actionModal);
        } 
        // For inbound completed transfers - show claim option
        else if (!isOutbound && isCompleted) {
          const claimModal = document.createElement('div');
          claimModal.style.position = 'fixed';
          claimModal.style.top = '50%';
          claimModal.style.left = '50%';
          claimModal.style.transform = 'translate(-50%, -50%)';
          claimModal.style.padding = '20px';
          claimModal.style.minWidth = '300px';
          claimModal.style.background = 'black';
          claimModal.style.color = 'white';
          claimModal.style.border = '3px solid #4CAF50'; // Green border for claim action
          claimModal.style.zIndex = '9999';
          claimModal.style.borderRadius = '10px';
          claimModal.style.boxShadow = '0 0 25px rgba(76, 175, 80, 0.5)';
          
          // Add content
          claimModal.innerHTML = `
            <h3 style="margin-top:0; text-align:center; color:#4CAF50;">Claim Transfer</h3>
            <div style="text-align:center; font-size:18px; font-weight:bold; margin:15px 0;">
              ${transfer.amount} ${transfer.symbol}
            </div>
            <p style="margin-bottom:20px; line-height:1.4;">
              This will claim the transfer and withdraw the funds to your wallet.
              <br><br>
              <strong>You will need to sign a transaction in your wallet.</strong>
            </p>
          `;
          
          // Button container
          const buttonContainer = document.createElement('div');
          buttonContainer.style.display = 'flex';
          buttonContainer.style.gap = '10px';
          
          // Create confirm button
          const confirmBtn = document.createElement('button');
          confirmBtn.innerText = 'Claim Funds';
          confirmBtn.style.flex = '1';
          confirmBtn.style.background = '#4CAF50';
          confirmBtn.style.color = 'white';
          confirmBtn.style.fontWeight = 'bold';
          confirmBtn.style.padding = '12px';
          confirmBtn.style.border = 'none';
          confirmBtn.style.borderRadius = '5px';
          confirmBtn.style.cursor = 'pointer';
          
          confirmBtn.onclick = function() {
            // Show a loading message in the modal
            claimModal.innerHTML = `
              <h3 style="margin-top:0; text-align:center; color:#4CAF50;">Processing...</h3>
              <p style="text-align:center;">Please confirm the transaction in your wallet.</p>
              <div style="display:flex; justify-content:center; margin:20px 0;">
                <div style="width:40px; height:40px; border:4px solid #4CAF50; border-radius:50%; border-top-color:transparent; animation:spin 1s linear infinite;"></div>
              </div>
              <style>@keyframes spin { 100% { transform:rotate(360deg); }}</style>
            `;
            
            // Call the handler with a slight delay to allow the UI to update
            setTimeout(() => {
              handleUnlockAndWithdraw(transfer.id)
                .then(() => {
                  // Close the modal on success - the toast will show the result
                  closeModal(claimModal);
                })
                .catch(error => {
                  // On error, update the modal to show the error
                  claimModal.innerHTML = `
                    <h3 style="margin-top:0; text-align:center; color:#4CAF50;">Error</h3>
                    <p style="color:red; margin:15px 0; text-align:center;">${error.message || "Transaction failed"}</p>
                    <button id="errorCloseBtn" style="width:100%; background:#333; color:white; padding:10px; border:none; border-radius:5px; cursor:pointer;">Close</button>
                  `;
                  
                  document.getElementById('errorCloseBtn').onclick = function() {
                    closeModal(claimModal);
                  };
                });
            }, 100);
          };
          
          // Create cancel button
          const cancelBtn = document.createElement('button');
          cancelBtn.innerText = 'Cancel';
          cancelBtn.style.flex = '1';
          cancelBtn.style.background = '#333';
          cancelBtn.style.color = 'white';
          cancelBtn.style.padding = '12px';
          cancelBtn.style.border = 'none';
          cancelBtn.style.borderRadius = '5px';
          cancelBtn.style.cursor = 'pointer';
          
          cancelBtn.onclick = function() {
            closeModal(claimModal);
          };
          
          // Add buttons to container
          buttonContainer.appendChild(confirmBtn);
          buttonContainer.appendChild(cancelBtn);
          claimModal.appendChild(buttonContainer);
          
          // Add modal to page
          document.body.appendChild(claimModal);
        }
        // For outbound completed transfers - show unlock option
        else if (isOutbound && isCompleted) {
          // We no longer allow senders to unlock their own transfers
          // Instead, we'll show an informational message
          const infoModal = document.createElement('div');
          infoModal.style.position = 'fixed';
          infoModal.style.top = '50%';
          infoModal.style.left = '50%';
          infoModal.style.transform = 'translate(-50%, -50%)';
          infoModal.style.padding = '20px';
          infoModal.style.minWidth = '300px';
          infoModal.style.background = 'black';
          infoModal.style.color = 'white';
          infoModal.style.border = '3px solid #2196F3'; // Blue border for info
          infoModal.style.zIndex = '9999';
          infoModal.style.borderRadius = '10px';
          infoModal.style.boxShadow = '0 0 25px rgba(33, 150, 243, 0.5)';
          
          // Add content with explanation
          infoModal.innerHTML = `
            <h3 style="margin-top:0; text-align:center; color:#2196F3;">Transfer Ready for Recipient</h3>
            <div style="text-align:center; font-size:18px; font-weight:bold; margin:15px 0;">
              ${transfer.amount} ${transfer.symbol}
            </div>
            <p style="margin-bottom:20px; line-height:1.4;">
              The timelock has expired. The recipient can now claim these funds.
              <br><br>
              <span style="font-style:italic; color:#aaa;">As the sender, you can't unlock this transfer.</span>
            </p>
          `;
          
          // Create close button
          const closeBtn = document.createElement('button');
          closeBtn.innerText = 'Close';
          closeBtn.style.width = '100%';
          closeBtn.style.background = '#333';
          closeBtn.style.color = 'white';
          closeBtn.style.padding = '12px';
          closeBtn.style.border = 'none';
          closeBtn.style.borderRadius = '5px';
          closeBtn.style.cursor = 'pointer';
          
          closeBtn.onclick = function() {
            closeModal(infoModal);
          };
          
          infoModal.appendChild(closeBtn);
          
          // Add modal to page
          document.body.appendChild(infoModal);
        }
        // For inbound pending transfers - show info modal
        else {
          // Simple info modal for pending inbound transfers
          const infoDiv = document.createElement('div');
          infoDiv.style.position = 'fixed';
          infoDiv.style.top = '50%';
          infoDiv.style.left = '50%';
          infoDiv.style.transform = 'translate(-50%, -50%)';
          infoDiv.style.padding = '20px';
          infoDiv.style.minWidth = '300px';
          infoDiv.style.background = 'black';
          infoDiv.style.color = 'white';
          infoDiv.style.border = '2px solid #FFC107'; // Yellow for pending
          infoDiv.style.zIndex = '9999';
          infoDiv.style.borderRadius = '10px';
          infoDiv.style.boxShadow = '0 0 20px rgba(255, 193, 7, 0.3)';
          
          // Calculate remaining time
          const remaining = transfer.unlockTime - now;
          const remainingFormatted = formatTimeDiff(remaining);
          
          // Simple content
          infoDiv.innerHTML = `
            <h3 style="margin-top:0; text-align:center; color:#FFC107;">Transfer Details</h3>
            <p style="margin-bottom:10px; text-align:center; font-weight:bold;">${transfer.amount} ${transfer.symbol}</p>
            <div style="margin-bottom:15px;">
              <div style="margin-bottom:8px;">Status: <span style="color:#FFC107">Pending</span></div>
              <div>This transfer is still locked. You'll be able to claim it in:</div>
              <div style="text-align:center; font-weight:bold; margin-top:8px; color:#FFC107">${remainingFormatted}</div>
            </div>
          `;
          
          // Add close button
          const closeBtn = document.createElement('button');
          closeBtn.innerText = 'Close';
          closeBtn.style.background = '#333';
          closeBtn.style.color = 'white';
          closeBtn.style.padding = '10px';
          closeBtn.style.border = 'none';
          closeBtn.style.borderRadius = '5px';
          closeBtn.style.width = '100%';
          closeBtn.style.marginTop = '15px';
          closeBtn.style.cursor = 'pointer';
          
          closeBtn.onclick = function() {
            closeModal(infoDiv);
          };
          
          infoDiv.appendChild(closeBtn);
          document.body.appendChild(infoDiv);
        }
      });

      track.appendChild(tokenIcon);
    }

    fragment.appendChild(section);
  }

  /**
   * Update progress bars in real-time with optimized performance
   */
  updateProgressBars() {
    const now = Math.floor(Date.now() / 1000);
    
    // Cache selectors and use requestAnimationFrame for smoother animations
    let animationFrame;
    let previousTimestamp = 0;
    
    // Store a reference to the animation frame for cleanup
    if (this._previousAnimationCleanup) {
      this._previousAnimationCleanup();
    }
    
    const updateProgress = (timestamp) => {
      // Throttle updates to once per second for better performance
      if (timestamp - previousTimestamp < 1000 && previousTimestamp !== 0) {
        animationFrame = requestAnimationFrame(updateProgress);
        return;
      }
      
      previousTimestamp = timestamp;
      
      // Get all token icons
      const tokenIcons = document.querySelectorAll(".token-icon");
      const iconCount = tokenIcons.length;
      
      // Early return if no icons to update
      if (iconCount === 0) {
        // Check again in a second
        setTimeout(() => {
          animationFrame = requestAnimationFrame(updateProgress);
        }, 1000);
        return;
      }
      
      // Track modification state
      let hasUpdates = false;
      
      // Cache tracks to avoid redundant DOM operations
      const tracksMap = new Map();
      
      // Use for loop instead of forEach for better performance
      for (let i = 0; i < iconCount; i++) {
        const icon = tokenIcons[i];
        const transferId = icon.dataset.transferId;
        if (!transferId) continue;

        const timestamp = parseInt(icon.dataset.timestamp);
        const delay = parseInt(icon.dataset.delay);
        
        if (isNaN(timestamp) || isNaN(delay)) continue;
        
        const unlockTime = timestamp + delay;
        const elapsed = now - timestamp;
        const total = delay;
        const progress = Math.min(100, (elapsed / total) * 100);
        
        // Find the parent track to determine if it's inbound or outbound
        const track = icon.closest(".transfer-track");
        if (!track) continue;
        
        // Get cached track or add to cache
        let trackData = tracksMap.get(track);
        if (!trackData) {
          trackData = {
            isOutbound: track.classList.contains("outbound-track"),
            isInbound: track.classList.contains("inbound-track"),
            progressIndicator: track.querySelector(".progress-indicator"),
            updated: false
          };
          tracksMap.set(track, trackData);
        }
        
        // Update progress indicator - only once per track
        if (!trackData.updated && trackData.progressIndicator) {
          trackData.progressIndicator.style.width = 
            `${trackData.isOutbound ? progress : 100 - progress}%`;
          trackData.updated = true;
          hasUpdates = true;
        }
        
        // Update icon position based on direction
        if (trackData.isOutbound) {
          // Move from left to right (cap at 95% to keep visible)
          icon.style.left = `${Math.min(95, progress)}%`;
        } else if (trackData.isInbound) {
          // Move from right to left (keep at least 5% from left edge)
          icon.style.left = `${Math.max(5, 100 - progress)}%`;
        }
        
        // Check if it just completed
        if (!icon.classList.contains("completed") && now >= unlockTime) {
          icon.classList.add("completed");
          hasUpdates = true;
        }
      }
      
      // Schedule next update with appropriate frequency
      const nextUpdateDelay = hasUpdates ? 0 : 1000;
      setTimeout(() => {
        animationFrame = requestAnimationFrame(updateProgress);
      }, nextUpdateDelay);
    };
    
    // Start the update cycle
    animationFrame = requestAnimationFrame(updateProgress);
    
    // Store cleanup function
    this._previousAnimationCleanup = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
    };
    
    return this._previousAnimationCleanup;
  }

  /**
   * Show transfer action menu
   * @param {Object} transfer - Transfer data
   * @param {HTMLElement} tokenIcon - Token icon element that was clicked
   * @param {Object} appState - Application state
   * @param {Function} handleReverseAndWithdraw - Handler for reverse and withdraw
   * @param {Function} handleUnlockAndWithdraw - Handler for unlock and withdraw
   * @param {Function} handleUnlockTransfer - Handler for just unlocking (for recipient)
   */
  showTransferActions(transfer, tokenIcon, appState, handleReverseAndWithdraw, handleUnlockAndWithdraw, handleUnlockTransfer) {
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
    
    // Use the direction that we now store directly on the transfer object
    // This direction was determined when creating the transfer UI element
    let direction = transfer.direction;
    
    // Fallback: Get direction from the parent track if not available on transfer
    if (!direction) {
      const track = tokenIcon.closest('.transfer-track');
      const isOutbound = track && track.classList.contains('outbound-track');
      const isInbound = track && track.classList.contains('inbound-track');
      
      if (isOutbound) {
        direction = "outbound";
      } else if (isInbound) {
        direction = "inbound";
      } else {
        // Fallback using the transfer data if track classes aren't found
        direction = transfer.to.toLowerCase() === appState.wallet.address.toLowerCase() ? "inbound" : "outbound";
      }
    }
    
    // Log info about action menu being shown
    console.log(`ACTION MENU: Transfer ${transfer.id}, direction=${direction}, isOutbound=${direction === "outbound"}, from=${transfer.from}`);
    console.log(`WALLET: ${appState.wallet?.address}, match=${transfer.from?.toLowerCase() === appState.wallet?.address?.toLowerCase()}`);

    // Create menu content
    this.actionMenu.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 8px;">
        ${formatNumber(transfer.amount)} ${transfer.symbol}
      </div>
      <div style="font-size: 12px; margin-bottom: 5px;">
        ${
          direction === "outbound"
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
    
    // Make sure we don't end up with an empty action menu
    let buttonsAdded = false;
    
    // SIMPLIFIED APPROACH: Use the properties we've already added to the transfer object
    // This removes any complex logic that might be failing
    
    // Check if the transfer is outbound (i.e., sent by the current user)
    const isOutbound = transfer.isOutbound || direction === "outbound";
    
    // Check if the transfer is still pending (i.e., unlock time not reached)
    const isPending = transfer.isPending || now < transfer.unlockTime;
    
    // Log critical information about the transfer and wallet
    // Log information about the transfer for debugging if needed
    console.log("Transfer info:", {
      transferId: transfer.id,
      direction,
      isOutbound,
      isPending,
      now,
      unlockTime: transfer.unlockTime,
      timeRemaining: transfer.unlockTime - now
    });
    
    // If this is a pending outbound transfer, show the reverse button
    const isPendingOutbound = isOutbound && isPending;
    
    // Determine if we should show the reverse button
    const showReverseButton = isPendingOutbound;
    
    // Only show reverse button if this is a pending outbound transfer
    if (isPendingOutbound) {
      // Create a button for reversing the transfer
      const reverseBtn = document.createElement("button");
      reverseBtn.className = "action-btn reverse";
      reverseBtn.textContent = "Reverse Transfer";
      
      // Use a clean onclick handler
      reverseBtn.addEventListener("click", () => {
        // Close the action menu
        this.actionMenu.remove();
        this.actionMenu = null;
        
        // Call the handler function
        handleReverseAndWithdraw(transfer.id);
      });
      
      buttonsContainer.appendChild(reverseBtn);
      buttonsAdded = true;
    }

    // For transfers that have reached unlock time
    if (now >= transfer.unlockTime) {
      // For inbound transfers, show claim option
      if (direction === "inbound") {
        const claimBtn = document.createElement("button");
        claimBtn.className = "action-btn unlock";
        claimBtn.textContent = "Claim Transfer";
        claimBtn.addEventListener("click", () => {
          this.actionMenu.remove();
          this.actionMenu = null;
          handleUnlockAndWithdraw(transfer.id);
        });
        buttonsContainer.appendChild(claimBtn);
        buttonsAdded = true;
      } 
      // For outbound transfers, we no longer show the option to claim
      // Sender cannot unlock their own transfers
      else if (direction === "outbound") {
        const infoDiv = document.createElement("div");
        infoDiv.className = "action-info";
        infoDiv.style.textAlign = "center";
        infoDiv.style.padding = "10px";
        infoDiv.style.color = "#888";
        infoDiv.textContent = "The recipient can now claim this transfer";
        buttonsContainer.appendChild(infoDiv);
        buttonsAdded = true;
      }
    }
    
    // If no buttons were added, show a message
    if (!buttonsAdded) {
      const messageDiv = document.createElement("div");
      messageDiv.style.textAlign = "center";
      messageDiv.style.padding = "10px";
      messageDiv.style.color = "#888";
      messageDiv.textContent = "No actions available for this transfer";
      buttonsContainer.appendChild(messageDiv);
    }

    this.actionMenu.appendChild(buttonsContainer);

    // Position the menu in a fixed centered position that's always visible
    // This ensures it's not off-screen or otherwise hidden
    
    this.actionMenu.style.position = "fixed";
    this.actionMenu.style.left = "50%";
    this.actionMenu.style.top = "50%";
    this.actionMenu.style.transform = "translate(-50%, -50%)";
    this.actionMenu.style.zIndex = "9999"; // Ensure it's on top of everything
    
    // Add a backdrop to make it stand out
    const backdrop = document.createElement("div");
    backdrop.style.position = "fixed";
    backdrop.style.top = "0";
    backdrop.style.left = "0";
    backdrop.style.width = "100%";
    backdrop.style.height = "100%";
    backdrop.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
    backdrop.style.zIndex = "9998";
    document.body.appendChild(backdrop);
    
    // Store the backdrop reference for removal later
    this.actionMenuBackdrop = backdrop;

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
      console.warn("CLOSING ACTION MENU");
      
      // Remove the action menu
      this.actionMenu.remove();
      this.actionMenu = null;
      
      // Remove the backdrop if it exists
      if (this.actionMenuBackdrop) {
        this.actionMenuBackdrop.remove();
        this.actionMenuBackdrop = null;
      }
      
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