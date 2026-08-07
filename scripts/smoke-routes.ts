import "dotenv/config";
import assert from "node:assert";
import { app } from "../src/server";

async function main() {
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://localhost:${address.port}`;

  const res = await fetch(`${base}/matches/000000000000000000000000/score/classic`, { method: "POST" });
  assert.strictEqual(res.status, 401, "should reject requests with no API key");

  server.close();
  console.log("PASS: smoke-routes");
}

main().catch((e) => {
  console.error("FAIL: smoke-routes", e);
  process.exit(1);
});
