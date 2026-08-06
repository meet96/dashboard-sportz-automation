import "dotenv/config";
import assert from "node:assert";
import { app } from "../src/server";

async function main() {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const res = await fetch(`http://localhost:${address.port}/health`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
  server.close();
  console.log("PASS: smoke-health");
}

main().catch((e) => {
  console.error("FAIL: smoke-health", e);
  process.exit(1);
});
