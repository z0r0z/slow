import { onchainEnum, onchainTable, primaryKey, relations } from "ponder";

export const transferStatus = onchainEnum("status", [
  "PENDING",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "REVERSED",
  "UNLOCKED",
]);

// Table for tracking users and their guardians
export const user = onchainTable("user", (t) => ({
  id: t.hex().primaryKey(), // user address
  guardian: t.hex(),
  lastGuardianChange: t.bigint(), // block.timestamp
  nonce: t.bigint(),
}));

export const userRelation = relations(user, ({ many }) => ({
  transfers: many(transfer),
  balances: many(balance),
}));

// Table for tracking token IDs
export const token = onchainTable("token", (t) => ({
  id: t.bigint().primaryKey(), // tokenId (encoded id)
  address: t.hex(),
  decimals: t.integer(),
  delaySeconds: t.bigint(),
  name: t.text(),
  symbol: t.text(),
  uri: t.text(),
}));

export const tokenRelation = relations(token, ({ many }) => ({
  balance: many(balance),
  transfers: many(transfer),
}));

// Table for tracking user balances
export const balance = onchainTable(
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

export const balanceRelation = relations(balance, ({ one }) => ({
  user: one(user, {
    fields: [balance.userAddress],
    references: [user.id],
  }),
  token: one(token, {
    fields: [balance.tokenId],
    references: [token.id],
  }),
}));

export const transfer = onchainTable("transfer", (t) => ({
  id: t.bigint().primaryKey(), // transaction hash + log index

  fromAddress: t.hex().notNull(),
  toAddress: t.hex().notNull(),
  tokenId: t.bigint().notNull(),
  amount: t.bigint().notNull(),
  expiryTimestamp: t.bigint(),

  status: transferStatus("status").notNull(),

  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(),
}));

export const transferRelation = relations(transfer, ({ one }) => ({
  user: one(user, {
    fields: [transfer.fromAddress],
    references: [user.id],
  }),
  token: one(token, {
    fields: [transfer.tokenId],
    references: [token.id],
  }),
}));

// Table for tracking guardian events
export const guardianSetEvent = onchainTable("guardian_set_event", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index

  userAddress: t.hex(),
  guardianAddress: t.hex(),

  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(),
}));

export const transferApprovedEvent = onchainTable(
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
export const unlockEvent = onchainTable("unlock_event", (t) => ({
  id: t.text().primaryKey(), // transaction hash + log index
  blockNumber: t.bigint(),
  transactionHash: t.hex(),
  timestamp: t.bigint(), // block.timestamp
  userAddress: t.hex(),
  tokenId: t.bigint(),
  amount: t.bigint(),
  transferId: t.bigint(),
}));

export const unlockEventRelation = relations(unlockEvent, ({ one }) => ({
  user: one(user, {
    fields: [unlockEvent.userAddress],
    references: [user.id],
  }),
  token: one(token, {
    fields: [unlockEvent.tokenId],
    references: [token.id],
  }),
}));
