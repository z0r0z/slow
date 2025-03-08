import { ponder } from "ponder:registry";

ponder.on("SLOW:ApprovalForAll", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:GuardianSet", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:TransferApproved", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:TransferBatch", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:TransferPending", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:TransferSingle", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:URI", async ({ event, context }) => {
  console.log(event.args);
});

ponder.on("SLOW:Unlocked", async ({ event, context }) => {
  console.log(event.args);
});
