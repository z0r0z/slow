import { onchainTable } from "ponder";

// Table for tracking users and their guardians
export const users = onchainTable("users", (t) => ({
  id: t.hex().primaryKey(), // user address
  guardian: t.hex(),
  lastGuardianChange: t.timestamp(),
  nonce: t.integer(),
}));

// Table for tracking token IDs
export const tokens = onchainTable("tokens", (t) => ({
  id: t.text().primaryKey(), // tokenId as string (encoded id)
  tokenAddress: t.hex(),
  delaySeconds: t.integer(),
  tokenName: t.text(),
  tokenSymbol: t.text(),
}));

// Table for tracking user balances
export const balances = onchainTable("balances", (t) => ({
  id: t.text().primaryKey(), // composite key: userAddress-tokenId
  userAddress: t.hex(),
  tokenId: t.text(),
  totalBalance: t.integer(),
  unlockedBalance: t.integer(),
}));

// Table for tracking pending transfers
export const pendingTransfers = onchainTable("pending_transfers", (t) => ({
  id: t.hex().primaryKey(), // transferId
  timestamp: t.timestamp(),
  fromAddress: t.hex(),
  toAddress: t.hex(),
  tokenId: t.text(),
  amount: t.integer(),
  guardianApproved: t.boolean(),
  unlocked: t.boolean(),
  reversed: t.boolean(),
  expiresAt: t.timestamp(),
}));

// Table for tracking transfer events
export const transferEvents = onchainTable("transfer_events", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index
  blockNumber: t.integer(),
  transactionHash: t.hex(),
  timestamp: t.timestamp(),
  fromAddress: t.hex(),
  toAddress: t.hex(),
  tokenId: t.text(),
  amount: t.integer(),
  isPending: t.boolean(),
  isUnlocked: t.boolean(),
}));

// Table for tracking guardian events
export const guardianEvents = onchainTable("guardian_events", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index
  blockNumber: t.integer(),
  transactionHash: t.hex(),
  timestamp: t.timestamp(),
  userAddress: t.hex(),
  guardianAddress: t.hex(),
  eventType: t.text(), // "SET" or "APPROVE"
  transferId: t.hex(), // Only for APPROVE events
}));

// Table for tracking unlock events
export const unlockEvents = onchainTable("unlock_events", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index
  blockNumber: t.integer(),
  transactionHash: t.hex(),
  timestamp: t.timestamp(),
  userAddress: t.hex(),
  tokenId: t.text(),
  amount: t.integer(),
  transferId: t.hex(), // Reference to the pending transfer
}));
