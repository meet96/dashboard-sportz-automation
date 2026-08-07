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
  // server.ts now constructs an Agenda instance at import time, which opens its own MongoDB
  // connection independent of the HTTP server. Nothing in this script starts/stops Agenda,
  // so that connection is left open and keeps the process alive after the test passes.
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL: smoke-health", e);
  process.exit(1);
});
