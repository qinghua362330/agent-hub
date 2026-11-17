#!/usr/bin/env node
// Presence and member-status integration checks against an isolated Hub.
"use strict";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-presence-test-"));
const copy = path.join(tmp, "server.js");
fs.copyFileSync(path.join(import.meta.dirname, "server.js"), copy);
const configPath = path.join(tmp, "config.json");
const tokens = Object.fromEntries(["ui", "muse", "grok", "echo", "relay", "admin", "mac"].map((role) => [role, `presence-${role}`]));
const baseConfig = { tokens };
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
const port = probe.address().port;
await new Promise((resolve, reject) => { probe.close((error) => error ? reject(error) : resolve()); });
const hub = `http://127.0.0.1:${port}`;
let child;
let childError;

function writeConfig(extra = {}) {
  fs.writeFileSync(configPath, JSON.stringify({ ...baseConfig, ...extra }), { mode: 0o600 });
}
async function start(extra) {
  writeConfig(extra);
  child = spawn(process.execPath, [copy], { cwd: tmp, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HUB_HEARTBEAT_TIMEOUT_MS: "120" }, stdio: ["ignore", "pipe", "pipe"] });
  childError = undefined;
  child.once("error", (error) => { childError = error; });
  child.once("exit", (code, signal) => { if (code !== 0) childError ||= new Error(`Hub exited before readiness (code=${code}, signal=${signal || "none"})`); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (childError || child.exitCode !== null) {
      const error = childError || new Error(`Hub exited before readiness (code=${child.exitCode})`);
      await stop();
      throw error;
    }
    try {
      const response = await fetch(`${hub}/api/agents`, { headers: { authorization: `Bearer ${tokens.admin}` } });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const error = childError || new Error("Hub did not start");
  await stop();
  throw error;
}
async function stop() {
  if (!child) return;
  const current = child;
  child = undefined;
  if (current.exitCode === null) {
    current.kill();
    await new Promise((resolve) => current.once("exit", resolve));
  }
}
async function call(method, route, role, body, extraHeaders = {}) {
  const response = await fetch(hub + route, {
    method,
    headers: { authorization: `Bearer ${tokens[role]}`, "content-type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}
async function roster() {
  return (await call("GET", "/api/agents", "admin")).body.agents;
}
async function heartbeat(agentId, role, body = {}) {
  return call("POST", "/bridge/heartbeat", role, { agentId, ...body });
}
async function mcp(role, name, args, headers = {}) {
  const result = await call("POST", "/mcp", role, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
  return result.body;
}
const member = (agents, id) => agents.find((agent) => agent.id === id);

test.after(async () => {
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("heartbeat presence is truthful and bot-readable", async () => {
  await start();
  try {
    let agents = await roster();
    assert.equal(member(agents, "muse").presence.alive, false);
    assert.equal(member(agents, "muse").presence.state, "offline");
    assert.equal(member(agents, "grok").presence.state, "offline");
    assert.equal(member(agents, "grok").presence.reason, "未配置 Grok webhook");

    let result = await mcp("muse", "get_member_status", { agentId: "codex" });
    assert.equal(result.result.structuredContent.member.id, "codex");
    assert.equal(result.result.structuredContent.member.presence.alive, false);
    result = await mcp("muse", "get_member_status", { agentId: "missing" });
    assert.match(JSON.stringify(result), /unknown agent/);

    assert.equal((await heartbeat("muse", "muse", { ready: true })).status, 200);
    agents = await roster();
    assert.equal(member(agents, "muse").presence.state, "online");
    assert.equal(member(agents, "muse").presence.alive, true);
    assert.equal(member(agents, "muse").presence.ready, true);
    assert.equal(member(agents, "chief").presence.alive, true);
    assert.equal(member(agents, "chief").presence.lastSeen, member(agents, "muse").presence.lastSeen);

    assert.equal((await heartbeat("muse", "muse", { ready: false, reason: "模型正在启动" })).status, 200);
    const unready = member(await roster(), "muse").presence;
    assert.equal(unready.state, "online");
    assert.equal(unready.alive, true);
    assert.equal(unready.ready, false);
    assert.equal(unready.reason, "模型正在启动");
    assert.equal((await heartbeat("muse", "muse")).status, 200);
    assert.equal(member(await roster(), "muse").presence.ready, null);

    assert.equal((await heartbeat("codex", "muse", { ready: true })).status, 403);

    const sent = await mcp("ui", "send_to_bot", { agentId: "codex", text: "presence lease check", newConversation: true });
    assert.equal(sent.error, undefined);
    const polled = await call("POST", "/bridge/poll", "mac", { agentId: "codex", limit: 1 });
    assert.equal(polled.status, 200);
    const working = member(await roster(), "codex").presence;
    assert.equal(working.state, "busy");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const expired = member(await roster(), "codex").presence;
    assert.equal(expired.state, "offline");
    assert.equal(expired.alive, false);
    assert.equal(expired.reason, "心跳已过期");
    assert.equal(typeof expired.checkedAt, "number");
    assert.equal(expired.heartbeatTimeoutMs, 120);

    result = await mcp("mac", "get_member_status", { agentId: "muse" }, { "x-agent-hub-agent": "codex" });
    assert.equal(result.result.structuredContent.member.id, "muse");
  } finally {
    await stop();
  }
});

test("configured Grok remains standby until its bridge is heard", async () => {
  await start({ grokWebhook: { url: "http://127.0.0.1:1/grok", key: "test" } });
  try {
    let grok = member(await roster(), "grok").presence;
    assert.equal(grok.state, "standby");
    assert.equal(grok.alive, false);
    assert.equal(grok.ready, null);
    assert.match(grok.reason, /webhook/);
    assert.equal((await heartbeat("grok", "grok", { ready: true })).status, 200);
    grok = member(await roster(), "grok").presence;
    assert.equal(grok.state, "online");
    assert.equal(grok.alive, true);
    assert.equal(grok.ready, true);
    await new Promise((resolve) => setTimeout(resolve, 180));
    grok = member(await roster(), "grok").presence;
    assert.equal(grok.state, "offline");
    assert.equal(grok.alive, false);
    assert.equal(grok.reason, "心跳已过期");
  } finally {
    await stop();
  }
});

test("invalid webhook and future heartbeat never look alive", async () => {
  fs.rmSync(path.join(tmp, "data", "heartbeats.json"), { force: true });
  await start({ grokWebhook: { url: "http://", key: "test" } });
  try {
    let grok = member(await roster(), "grok").presence;
    assert.equal(grok.state, "offline");
    assert.equal(grok.alive, false);
    assert.equal(grok.reason, "未配置 Grok webhook");
  } finally {
    await stop();
  }
  fs.writeFileSync(path.join(tmp, "data", "heartbeats.json"), JSON.stringify({ muse: { lastSeen: Date.now() + 60_000, lastActivity: Date.now() + 60_000, ready: true } }));
  await start();
  try {
    const muse = member(await roster(), "muse").presence;
    assert.equal(muse.state, "offline");
    assert.equal(muse.alive, false);
    assert.equal(muse.reason, "心跳时间在未来，等待校准");
  } finally {
    await stop();
  }
});
