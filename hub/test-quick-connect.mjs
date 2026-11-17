import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("new installs expose only a public probe, fixed bridge download and real agent address", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-connect-"));
  for (const dir of ["hub", "client"]) mkdirSync(join(root, dir));
  copyFileSync(join(import.meta.dirname, "server.js"), join(root, "hub/server.js"));
  const bridge = readFileSync(join(import.meta.dirname, "../client/acp-bridge.py"));
  copyFileSync(join(import.meta.dirname, "../client/acp-bridge.py"), join(root, "client/acp-bridge.py"));
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const hub = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, "hub/server.js")], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HUB_PUBLIC_URL: "https://hub.example.test/team/" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const deadline = Date.now() + 10_000;
    let available = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("isolated Hub exited");
      try { if ((await fetch(hub + "/health")).ok) { available = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(available, true);
    const health = await (await fetch(hub + "/health")).json();
    assert.equal(health.service, "agent-hub");
    assert.deepEqual(Object.keys(health).sort(), ["service", "version"]);
    const result = await fetch(hub + "/downloads/acp-bridge.py");
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.headers.get("x-checksum-sha256"), createHash("sha256").update(bridge).digest("hex"));
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), bridge);
    const card = await (await fetch(hub + "/a2a/muse/.well-known/agent-card.json")).json();
    assert.equal(card.url, "https://hub.example.test/team/a2a/muse");
    assert.equal((await fetch(hub + "/api/agents")).status, 401);
    for (const path of ["/downloads/config.json", "/downloads/env", "/downloads/connection.json", "/hub/config.json", "/install.json"]) assert.equal((await fetch(hub + path)).status, 404);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    rmSync(root, { recursive: true, force: true });
  }
});
