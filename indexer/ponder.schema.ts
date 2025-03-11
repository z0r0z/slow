import { onchainEnum, onchainTable, primaryKey, relations } from "ponder";

export const transferStatus = onchainEnum("status", [
  "PENDING",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "REVERSED",
  "UNLOCKED",
  "EXPIRED",
  "TRANSFERRED",
]);

// Table for tracking users and their guardians
export const users = onchainTable("user", (t) => ({
  id: t.hex().primaryKey(), // user address
  guardian: t.hex(),
  lastGuardianChange: t.bigint(), // block.timestamp
  nonce: t.bigint(),
}));

export const userRelations = relations(users, ({ many }) => ({
  transfers: many(transfers),
  balances: many(balances),
}));

// Table for tracking token IDs
export const tokens = onchainTable("token", (t) => ({
  id: t.text().primaryKey(), // tokenId as string (encoded id)
  tokenAddress: t.hex(),
  delaySeconds: t.integer(),
  tokenName: t.text(),
  tokenSymbol: t.text(),
  uri: t.text(),
}));

export const tokenRelations = relations(tokens, ({ many }) => ({
  balances: many(balances),
}));

// Table for tracking user balances
export const balances = onchainTable(
  "balance",
  (t) => ({
    userAddress: t.hex(),
    tokenId: t.bigint(),
    totalBalance: t.bigint(),
    unlockedBalance: t.bigint(),
  }),
  (table) => ({
    pk: primaryKey({
      columns: [table.userAddress, table.tokenId],
    }),
  }),
);

export const balanceRelations = relations(balances, ({ one }) => ({
  user: one(users, {
    fields: [balances.userAddress],
    references: [users.id],
  }),
  token: one(tokens, {
    fields: [balances.tokenId],
    references: [tokens.id],
  }),
}));

export const transfers = onchainTable("transfer", (t) => ({
  id: t.bigint().primaryKey(), // transaction hash + log index

  fromAddress: t.hex(),
  toAddress: t.hex(),
  tokenId: t.bigint(),
  amount: t.bigint(),

  status: transferStatus(),

  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(),
}));

export const transferRelations = relations(transfers, ({ one }) => ({
  user: one(users, {
    fields: [transfers.fromAddress],
    references: [users.id],
  }),
  token: one(tokens, {
    fields: [transfers.tokenId],
    references: [tokens.id],
  }),
}));

// Table for tracking guardian events
export const guardianSetEvents = onchainTable("guardian_set_event", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index

  userAddress: t.hex(),
  guardianAddress: t.hex(),

  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(),
}));

export const transferApprovedEvents = onchainTable(
  "transfer_approved_event",
  (t) => ({
    id: t.text().primaryKey(), // transaction hash + log index

    userAddress: t.hex(),
    guardianAddress: t.hex(),
    transferId: t.bigint(),

    blockNumber: t.bigint(),
    transactionHash: t.hex(),
    timestamp: t.bigint(),
  }),
);

// Table for tracking unlock events
export const unlockEvents = onchainTable("unlock_event", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index
  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(), // block.timestamp
  userAddress: t.hex(),
  tokenId: t.bigint(),
  amount: t.bigint(),
  transferId: t.bigint(),
}));

export const unlockEventsRelations = relations(unlockEvents, ({ one }) => ({
  user: one(users, {
    fields: [unlockEvents.userAddress],
    references: [users.id],
  }),
  token: one(tokens, {
    fields: [unlockEvents.tokenId],
    references: [tokens.id],
  }),
}));
