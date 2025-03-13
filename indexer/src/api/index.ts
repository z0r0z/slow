import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { and, or, eq, graphql } from "ponder";
import { getAddress } from "viem";

const app = new Hono();

app.use("/", graphql({ db, schema }));
app.use("/graphql", graphql({ db, schema }));

app.get("/transfers/:user", async (c) => {
  const user = getAddress(c.req.param("user"));
  const type = c.req.query("type");
  const status = c.req.query("status")?.toUpperCase();

  // Validate status if provided
  let statusQuery = undefined;
  if (
    status &&
    [
      "PENDING",
      "APPROVAL_REQUIRED",
      "APPROVED",
      "REVERSED",
      "UNLOCKED",
    ].includes(status)
  ) {
    statusQuery = eq(
      schema.transfer.status,
      status as
        | "PENDING"
        | "APPROVAL_REQUIRED"
        | "APPROVED"
        | "REVERSED"
        | "UNLOCKED",
    );
  } else {
    return c.json({ error: "Invalid status parameter" }, 400);
  }

  let whereQuery = undefined;
  if (!type) {
    whereQuery = or(
      eq(schema.transfer.fromAddress, user),
      eq(schema.transfer.toAddress, user),
    );
  } else if (type === "outbound") {
    whereQuery = eq(schema.transfer.fromAddress, user);
  } else if (type === "inbound") {
    whereQuery = eq(schema.transfer.toAddress, user);
  } else {
    return c.json({ error: "Invalid type parameter" }, 400);
  }

  let query = db
    .select({
      transfer: schema.transfer,
      token: schema.token,
    })
    .from(schema.transfer)
    .innerJoin(schema.token, eq(schema.transfer.tokenId, schema.token.id))
    .where(statusQuery ? and(whereQuery, statusQuery) : whereQuery);

  const transfers = await query;

  return c.json(
    transfers.map((item) => ({
      id: item.transfer.id.toString(),
      fromAddress: item.transfer.fromAddress,
      toAddress: item.transfer.toAddress,
      amount: item.transfer.amount.toString(),
      expiryTimestamp: item.transfer.expiryTimestamp?.toString() || null,
      status: item.transfer.status,
      token: {
        id: item.token.id.toString(),
        address: item.token.address,
        decimals: item.token.decimals,
        delaySeconds: item.token.delaySeconds?.toString() || null,
        name: item.token.name,
        symbol: item.token.symbol,
      },
    })),
  );
});

export default app;
