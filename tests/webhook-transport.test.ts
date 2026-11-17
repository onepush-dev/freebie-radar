import assert from "node:assert/strict";
import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { test } from "node:test";

process.env.SITE_MODE = "selfhost";
process.env.WEBHOOK_ALLOW_PRIVATE = "true";
const { postWebhook } = await import("../src/server/webhook.ts");

test("Webhook socket 固定已解析 IP，保留 Host；禁止重定向，不转发校验密钥", async () => {
  const requests: { path: string; host: string; secret: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      requests.push({ path: req.url!, host: req.headers.host!, secret: String(req.headers["x-radar-secret"]), body });
      if (req.url === "/redirect") {
        res.writeHead(307, { location: "/stolen-secret" }); res.end();
      } else { res.writeHead(204); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://rebinding.invalid:${address.port}`;
  const resolver = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as typeof lookup;
  try {
    await postWebhook(base + "/ok", "测试消息", "test-secret", resolver);
    assert.equal(requests[0]!.host, `rebinding.invalid:${address.port}`);
    assert.equal(requests[0]!.secret, "test-secret");
    assert.equal((JSON.parse(requests[0]!.body) as { text: string }).text, "测试消息");
    await assert.rejects(postWebhook(base + "/redirect", "测试消息", "test-secret", resolver), /不允许重定向/);
    assert.deepEqual(requests.map((r) => r.path), ["/ok", "/redirect"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
