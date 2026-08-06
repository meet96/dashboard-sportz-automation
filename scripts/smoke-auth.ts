import "dotenv/config";
import assert from "node:assert";
import express from "express";
import { requireApiKey } from "../src/middleware/apiKeyAuth";

async function main() {
  process.env.API_KEY_TESTCALLER = "test-secret-123";

  const app = express();
  app.get("/protected", requireApiKey, (req, res) => {
    res.json({ ok: true, caller: req.callerName });
  });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const base = `http://localhost:${address.port}`;

  const noAuth = await fetch(`${base}/protected`);
  assert.strictEqual(noAuth.status, 401);

  const wrongKey = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer nope" } });
  assert.strictEqual(wrongKey.status, 401);

  const rightKey = await fetch(`${base}/protected`, { headers: { Authorization: "Bearer test-secret-123" } });
  assert.strictEqual(rightKey.status, 200);
  const body = await rightKey.json();
  assert.strictEqual(body.caller, "testcaller");

  server.close();
  console.log("PASS: smoke-auth");
}

main().catch((e) => {
  console.error("FAIL: smoke-auth", e);
  process.exit(1);
});
