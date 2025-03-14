/**
 * Format time display for user interface
 * @param {number} time - Time in seconds
 * @returns {string} - Formatted time display
 */
export function formatTimeDisplay(time, timeOptions = []) {
  // Check if time matches a predefined option
  for (const option of timeOptions) {
    if (option.value === time.toString()) {
      return option.display;
    }
  }

  const seconds = parseInt(time);
  if (isNaN(seconds)) return "Invalid time";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  let display = "";
  if (days > 0) display += `${days}D `;
  if (hours > 0) display += `${hours}H `;
  if (minutes > 0) display += `${minutes}M `;
  if (remainingSeconds > 0 || (days === 0 && hours === 0 && minutes === 0)) {
    display += `${remainingSeconds}S`;
  }

  return display.trim();
}

/**
 * Format custom time inputs and calculate total seconds
 * @param {Object} timeInputs - Object with days, hours, minutes, seconds properties
 * @returns {Object} - Object containing seconds and display values
 */
export function formatCustomTimeInputs(timeInputs) {
  const days = parseInt(timeInputs.days) || 0;
  const hours = parseInt(timeInputs.hours) || 0;
  const minutes = parseInt(timeInputs.minutes) || 0;
  const seconds = parseInt(timeInputs.seconds) || 0;

  const totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;

  if (totalSeconds <= 0) {
    return { seconds: 0, display: "0S" };
  }

  let display = "";
  if (days > 0) display += `${days}D `;
  if (hours > 0) display += `${hours}H `;
  if (minutes > 0) display += `${minutes}M `;
  if (seconds > 0 || (days === 0 && hours === 0 && minutes === 0)) {
    display += `${seconds}S`;
  }

  return { seconds: totalSeconds, display: display.trim() };
}

/**
 * Format a number for display
 * @param {string|number} value - Value to format
 * @returns {string} - Formatted number
 */
export function formatNumber(value) {
  const num = parseFloat(value);
  if (isNaN(num)) return value;

  // If it's a whole number, show no decimals
  if (num === Math.floor(num)) return num.toString();

  // Otherwise, show up to 6 decimal places
  return num.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 2,
  });
}

/**
 * Format time difference in a human-readable format
 * @param {number} seconds - Time difference in seconds
 * @returns {string} - Formatted time difference
 */
export function formatTimeDiff(seconds) {
  if (seconds <= 0) return "0 seconds";

  const days = Math.floor(seconds / 86400);
  const remainingSeconds = seconds % 86400;
  const hours = Math.floor(remainingSeconds / 3600);
  const remainingSecondsAfterHours = remainingSeconds % 3600;
  const minutes = Math.floor(remainingSecondsAfterHours / 60);
  const finalSeconds = remainingSecondsAfterHours % 60;

  let result = "";
  if (days > 0) {
    result += `${days}d `;
  }
  if (hours > 0 || days > 0) {
    result += `${hours}h `;
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    result += `${minutes}m `;
  }
  if (finalSeconds > 0 && days === 0 && hours === 0) {
    result += `${finalSeconds}s`;
  }

  return result.trim();
}

/**
 * Show toast notification
 * @param {HTMLElement} toastElement - Toast element
 * @param {string} message - Message to display
 * @param {number} duration - How long to show the toast (milliseconds)
 */
export function showToast(toastElement, message, duration = 3000) {
  if (!toastElement) return;
  
  toastElement.textContent = message;
  toastElement.classList.add("show");

  setTimeout(() => {
    toastElement.classList.remove("show");
  }, duration);
}

/**
 * Show loading indicator
 * @param {HTMLElement} loadingElement - Loading element
 * @param {HTMLElement} loadingTextElement - Loading text element
 * @param {string} message - Loading message
 */
export function showLoading(loadingElement, loadingTextElement, message = "Processing transaction...") {
  if (!loadingElement || !loadingTextElement) return;
  
  loadingTextElement.textContent = message;
  loadingElement.style.display = "flex";
}

/**
 * Hide loading indicator
 * @param {HTMLElement} loadingElement - Loading element
 */
export function hideLoading(loadingElement) {
  if (!loadingElement) return;
  
  loadingElement.style.display = "none";
}