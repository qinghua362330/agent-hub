#!/usr/bin/env node
// Disposable Hub lifecycle regressions. No external agents or user data.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hub-discussion-test-"));
const copy = path.join(tmp, "server.js");
fs.copyFileSync(path.join(import.meta.dirname, "server.js"), copy);
const tokens = Object.fromEntries(["ui", "muse", "grok", "echo", "relay", "admin", "mac"].map((r) => [r, `test-${r}`]));
fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({ tokens }), { mode: 0o600 });
const portProbe = http.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
let log = "";

async function start(leaseMs = 500) {
  child = spawn(process.execPath, [copy], { cwd: tmp, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), HUB_TASK_LEASE_MS: String(leaseMs), HUB_SCHEDULER_TICK_MS: "20" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 100; i++) { try { if ((await call("GET", "/api/agents", undefined, "admin")).status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Hub did not start: ${log}`);
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) await new Promise((resolve) => { child.once("close", resolve); child.kill("SIGTERM"); }); }
async function call(method, url, body, role = "ui", extraHeaders = {}) {
  const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${tokens[role]}`, "content-type": "application/json", ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = {}; try { parsed = await res.json(); } catch {}
  return { status: res.status, body: parsed };
}
async function tool(name, args, role = "ui") {
  const r = await call("POST", "/mcp", { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, role);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  if (r.body.error) throw new Error(r.body.error.message);
  return r.body.result.structuredContent;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The lifecycle fixture intentionally keeps queueing tasks to prove history
// pagination. Claims are FIFO, so a later test must drain bounded batches until
// it reaches its own task instead of assuming the first poll is its claim.
async function claimTask(agentId, taskId, role) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tasks = (await call("POST", "/bridge/poll", { agentId, limit: 20 }, role)).body.tasks;
    const claim = tasks.find((item) => item.id === taskId);
    if (claim) return claim;
  }
  assert.fail(`task ${taskId} was not claimed by ${agentId} after draining 20 batches`);
}

await start();

test("new conversation is isolated and explicit conversation is reused", async () => {
  const a = await tool("send_to_bot", { agentId: "muse", text: "topic A", newConversation: true });
  const b = await tool("send_to_bot", { agentId: "muse", text: "topic B", newConversation: true });
  assert.notEqual(a.conversationId, b.conversationId);
  const c = await tool("send_to_bot", { agentId: "muse", text: "topic A follow-up", conversationId: a.conversationId });
  assert.equal(c.conversationId, a.conversationId);
  const missing = await tool("send_to_bot", { agentId: "muse", text: "must reject", conversationId: "conv_missing" }).catch((e) => e);
  assert.match(String(missing), /unknown conversation/);
});

test("human callers can answer a paused discussion and channel membership is enforced", async () => {
  const created = await call("POST", "/api/conversations", { kind: "dm", members: ["user", "muse"], maxTurns: 3 }, "admin");
  const id = created.body.conversation.id;
  const sent = await tool("send_to_bot", { agentId: "muse", text: "ask", conversationId: id }, "mac");
  const poll = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse");
  const claimed = poll.body.tasks.find((t) => t.id === sent.task.id);
  await call("POST", "/bridge/reply", { taskId: claimed.id, claimToken: claimed.claimToken, state: "input-required", text: "NEED_USER please clarify" }, "muse");
  const resumed = await tool("send_to_bot", { agentId: "muse", text: "clarification", conversationId: id }, "mac");
  assert.equal(resumed.conversationId, id);

  const channel = (await call("POST", "/api/conversations", { kind: "channel", members: ["user", "muse"] }, "ui")).body.conversation;
  const posted = await tool("send_to_channel", { channelId: channel.id, mentions: ["muse"], parentTaskId: "parent-1", text: "channel" });
  assert.equal(posted.tasks[0].parentTaskId, "parent-1");
  const outsider = await tool("send_to_channel", { channelId: channel.id, mentions: ["muse"], text: "bad" }, "echo").catch((e) => e);
  assert.match(String(outsider), /caller and target|member/);
  const badTarget = await tool("send_to_channel", { channelId: channel.id, mentions: ["codex"], text: "bad" }).catch((e) => e);
  assert.match(String(badTarget), /channel member/);
});

test("markers are terminal only and owner can resume/reset capped discussion", async () => {
  const created = await call("POST", "/api/conversations", { kind: "dm", members: ["user", "muse"], maxTurns: 2 }, "ui");
  assert.equal(created.status, 201); const id = created.body.conversation.id;
  const first = await tool("send_to_bot", { agentId: "muse", text: "plain DONE wording is not marker", conversationId: id });
  const p1 = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse");
  await call("POST", "/bridge/reply", { taskId: p1.body.tasks.find((t) => t.id === first.task.id).id, state: "completed", text: "plain DONE wording is not marker" }, "muse");
  let state = (await call("GET", "/api/conversations", undefined, "ui")).body.conversations.find((c) => c.id === id);
  assert.equal(state.phase, "active");
  const second = await tool("send_to_bot", { agentId: "muse", text: "DONE final", conversationId: id });
  const p2 = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse");
  await call("POST", "/bridge/reply", { taskId: p2.body.tasks.find((t) => t.id === second.task.id).id, state: "completed", text: "Final answer\nDONE" }, "muse");
  state = (await call("GET", "/api/conversations", undefined, "ui")).body.conversations.find((c) => c.id === id);
  assert.equal(state.phase, "done");
  const blocked = await tool("send_to_bot", { agentId: "muse", text: "third", conversationId: id }).catch((e) => e);
  assert.match(String(blocked), /closed|resume|reset/);
  const denied = await call("POST", `/api/conversations/${id}/reset`, {}, "muse"); assert.equal(denied.status, 403);
  assert.equal((await call("POST", `/api/conversations/${id}/reset`, {}, "ui")).status, 200);
});

test("cancelled late callback is rejected and terminal callback is idempotent", async () => {
  const sent = await tool("send_to_bot", { agentId: "muse", text: "cancel me", newConversation: true });
  const poll = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse"); const task = poll.body.tasks.find((t) => t.id === sent.task.id);
  assert.equal((await tool("interrupt", { taskId: task.id })).task.state, "CANCELED");
  const late = await call("POST", "/bridge/reply", { taskId: task.id, claimToken: task.claimToken, state: "completed", text: "late" }, "muse");
  assert.equal(late.status, 409);
  const doneSent = await tool("send_to_bot", { agentId: "muse", text: "finish me", newConversation: true });
  const donePoll = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse"); const done = donePoll.body.tasks.find((t) => t.id === doneSent.task.id);
  assert.equal((await call("POST", "/bridge/reply", { taskId: done.id, claimToken: done.claimToken, state: "completed", text: "ok" }, "muse")).status, 200);
  const duplicate = await call("POST", "/bridge/reply", { taskId: done.id, claimToken: done.claimToken, state: "completed", text: "different" }, "muse");
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.idempotent, true);
});

test("expired lease fails, explicit retry gets a new claim, stale token is rejected", async () => {
  const sent = await tool("send_to_bot", { agentId: "muse", text: "lease me", newConversation: true });
  const first = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse"); const claim = first.body.tasks.find((t) => t.id === sent.task.id);
  await sleep(600); await call("POST", "/bridge/poll", { agentId: "muse" }, "muse");
  const failed = (await call("GET", "/api/tasks", undefined, "ui")).body.tasks.find((t) => t.id === sent.task.id);
  assert.equal(failed.state, "FAILED"); assert.match(failed.note, /retry explicitly/);
  const retried = await call("POST", `/api/tasks/${failed.id}/retry`, {}, "ui"); assert.equal(retried.status, 201);
  const next = await call("POST", "/bridge/poll", { agentId: "muse" }, "muse"); const newClaim = next.body.tasks.find((t) => t.id === retried.body.task.id);
  assert.notEqual(newClaim.claimToken, claim.claimToken);
  const stale = await call("POST", "/bridge/reply", { taskId: newClaim.id, claimToken: claim.claimToken, state: "completed", text: "stale" }, "muse");
  assert.equal(stale.status, 409);
});

test("state survives restart and message pagination has an id cursor", async () => {
  const conv = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "muse"] }, "ui")).body.conversation;
  await call("POST", `/api/conversations/${conv.id}/messages`, { text: "one" }, "ui");
  await call("POST", `/api/conversations/${conv.id}/messages`, { text: "two" }, "ui");
  const page = await call("GET", `/api/conversations/${conv.id}/messages?limit=1`, undefined, "ui");
  assert.equal(page.body.messages.length, 1); assert.ok(page.body.nextBeforeId);
  const older = await call("GET", `/api/conversations/${conv.id}/messages?limit=10&beforeId=${encodeURIComponent(page.body.nextBeforeId)}`, undefined, "ui");
  assert.equal(older.body.messages.length, 1); assert.equal(older.body.messages[0].text, "one");
  await stop(); await start();
  const after = (await call("GET", "/api/conversations", undefined, "ui")).body.conversations.find((c) => c.id === conv.id);
  assert.equal(after.id, conv.id);
});

test("channel requestKey is idempotent and Muse cannot impersonate local heartbeat", async () => {
  const conv = (await call("POST", "/api/conversations", { kind: "channel", members: ["user", "muse", "codex"] }, "ui")).body.conversation;
  const a = await tool("send_to_channel", { channelId: conv.id, mentions: ["muse", "codex"], text: "same", requestKey: "once" });
  const b = await tool("send_to_channel", { channelId: conv.id, mentions: ["muse", "codex"], text: "same", requestKey: "once" });
  assert.equal(b.deduplicated, true); assert.equal(b.tasks.length, a.tasks.length);
  assert.equal((await call("POST", "/bridge/heartbeat", { agentId: "codex" }, "muse")).status, 403);
});

test("scoped local MCP is bound to the claimed task conversation", async () => {
  const conv = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "codex", "muse"] }, "ui")).body.conversation;
  const sent = (await call("POST", `/api/conversations/${conv.id}/messages`, { text: "local work", targetAgent: "codex" }, "ui")).body.tasks[0];
  const claimed = (await call("POST", "/bridge/poll", { agentId: "codex" }, "mac")).body.tasks.find((t) => t.id === sent.id);
  const scoped = await call("POST", "/mcp", { jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "follow-up" } } }, "mac", { "x-agent-hub-task": claimed.id, "x-agent-hub-claim": claimed.claimToken });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.result.structuredContent.conversationId, conv.id);
  assert.equal(scoped.body.result.structuredContent.task.parentTaskId, claimed.id);
  assert.equal(scoped.body.result.structuredContent.task.fromAgent, "codex");
  const escaped = await call("POST", "/mcp", { jsonrpc: "2.0", id: 78, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "escape", conversationId: "other" } } }, "mac", { "x-agent-hub-task": claimed.id, "x-agent-hub-claim": claimed.claimToken });
  assert.equal(escaped.status, 200); assert.match(escaped.body.error.message, /switch conversation/);
});

test("renewal requires the claiming role and cannot resurrect an expired lease", async () => {
  const sent = await tool("send_to_bot", { agentId: "muse", text: "renew me", newConversation: true });
  const claim = (await call("POST", "/bridge/poll", { agentId: "muse", limit: 20 }, "muse")).body.tasks.find((task) => task.id === sent.task.id);
  assert.ok(claim.messages.some((message) => message.text === "renew me"));
  assert.equal((await call("POST", "/bridge/renew", { taskId: claim.id, claimToken: claim.claimToken }, "mac")).status, 403);
  assert.equal((await call("POST", "/bridge/renew", { taskId: claim.id, claimToken: claim.claimToken }, "muse")).status, 200);
  await sleep(600);
  assert.equal((await call("POST", "/bridge/renew", { taskId: claim.id, claimToken: claim.claimToken }, "muse")).status, 409);
  assert.equal((await call("POST", "/bridge/reply", { taskId: claim.id, claimToken: claim.claimToken, state: "completed", text: "too late" }, "muse")).status, 409);
});

test("terminal idempotency rejects the wrong claim and poll validates its limit", async () => {
  assert.equal((await call("POST", "/bridge/poll", { agentId: "muse", limit: -1 }, "muse")).status, 400);
  const sent = await tool("send_to_bot", { agentId: "muse", text: "complete", newConversation: true });
  const claim = (await call("POST", "/bridge/poll", { agentId: "muse", limit: 20 }, "muse")).body.tasks.find((task) => task.id === sent.task.id);
  assert.equal((await call("POST", "/bridge/reply", { taskId: claim.id, claimToken: claim.claimToken, state: "completed", text: "ok" }, "muse")).status, 200);
  assert.equal((await call("POST", "/bridge/reply", { taskId: claim.id, claimToken: "wrong", state: "completed", text: "overwrite" }, "muse")).status, 409);
  assert.equal((await tool("read_conversation", { conversationId: sent.conversationId })).messages.filter((message) => message.taskId === claim.id).length, 1);
});

test("hard cap rejects late parallel replies and resume cannot bypass its budget", async () => {
  const conv = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "muse"], maxTurns: 1 })).body.conversation;
  const first = await tool("send_to_bot", { agentId: "muse", text: "one", conversationId: conv.id });
  const second = await tool("send_to_bot", { agentId: "muse", text: "two", conversationId: conv.id });
  const claims = (await call("POST", "/bridge/poll", { agentId: "muse", limit: 20 }, "muse")).body.tasks;
  for (const [index, sent] of [first, second].entries()) {
    const claim = claims.find((task) => task.id === sent.task.id);
    assert.equal((await call("POST", "/bridge/reply", { taskId: claim.id, claimToken: claim.claimToken, state: "completed", text: `answer ${index}` }, "muse")).status, index ? 409 : 200);
  }
  const page = await tool("read_conversation", { conversationId: conv.id });
  assert.equal(page.conversation.turnCount, 1); assert.equal(page.conversation.phase, "limit-reached");
  assert.ok(!page.messages.some((message) => message.text === "answer 1"));
  assert.equal((await call("POST", `/api/conversations/${conv.id}/resume`, {})).status, 409);
  assert.equal((await call("POST", `/api/tasks/${second.task.id}/retry`, {})).status, 409);
  assert.equal((await call("POST", `/api/conversations/${conv.id}/reset`, {})).body.conversation.turnCount, 0);
});

test("Chief receives role and history, and scoped Muse delegates under Chief identity", async (t) => {
  // The test also exercises three Python subprocesses (CLI + outbox flush).
  // Give this one fixture enough lease time for that real path; the dedicated
  // expiry test below continues to run against the 500ms lease.
  await stop(); await start(5_000);
  t.after(async () => { await stop(); await start(); });
  const sent = await tool("send_to_bot", { agentId: "chief", text: "coordinate these agents", newConversation: true });
  const claim = await claimTask("chief", sent.task.id, "muse");
  assert.equal(claim.role, "chief"); assert.match(claim.instructions, /delegate|delegat/i);
  assert.ok(claim.messages.some((message) => message.text === "coordinate these agents"));
  const headers = { "x-agent-hub-task": claim.id, "x-agent-hub-claim": claim.claimToken };
  const scopedTool = (name, args) => call("POST", "/mcp", { jsonrpc: "2.0", id: 88, method: "tools/call", params: { name, arguments: args } }, "muse", headers);
  const delegated = (await scopedTool("send_to_bot", { agentId: "codex", text: "do a bounded part" })).body.result.structuredContent;
  assert.equal(delegated.task.fromAgent, "chief"); assert.equal(delegated.task.parentTaskId, claim.id);
  assert.equal(delegated.conversationId, sent.conversationId);
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true }); fs.mkdirSync(path.join(tmp, "bridge/inbox"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "../tools/wb.py"), path.join(tmp, "tools/wb.py"));
  fs.writeFileSync(path.join(tmp, `bridge/inbox/${claim.id}.json`), JSON.stringify(claim));
  const cli = spawnSync("python3", [path.join(tmp, "tools/wb.py"), "send", "muse", "a CLI delegation"], { env: { ...process.env, WB_HUB: base, WB_HUB_CONFIG: path.join(tmp, "config.json"), WB_TASK_ID: claim.id }, encoding: "utf8", timeout: 10_000 });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const fromCli = JSON.parse(cli.stdout);
  assert.equal(fromCli.task.fromAgent, "chief"); assert.equal(fromCli.task.parentTaskId, claim.id); assert.equal(fromCli.conversationId, sent.conversationId);
  const escaped = await scopedTool("read_conversation", { conversationId: "another" }); assert.match(escaped.body.error.message, /switch conversation/);
  const fresh = await scopedTool("send_to_bot", { agentId: "muse", text: "escape", newConversation: true }); assert.match(fresh.body.error.message, /new conversation/);
  const env = { ...process.env, WB_HUB: base, WB_HUB_CONFIG: path.join(tmp, "config.json"), WB_TASK_ID: claim.id };
  const queued = spawnSync("python3", [path.join(tmp, "tools/wb.py"), "reply", claim.id, "Chief final summary\nDONE"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(queued.status, 0, queued.stderr || queued.stdout);
  const outbox = JSON.parse(fs.readFileSync(path.join(tmp, `bridge/outbox/${claim.id}.json`)));
  assert.equal(outbox.claimToken, claim.claimToken);
  fs.copyFileSync(path.join(import.meta.dirname, "../bridge/muse-bridge.py"), path.join(tmp, "bridge/muse-bridge.py"));
  fs.mkdirSync(path.join(tmp, "bridge/done"), { recursive: true });
  const flushed = spawnSync("python3", ["-c", "import runpy,sys; runpy.run_path(sys.argv[1])['flush_outbox']()", path.join(tmp, "bridge/muse-bridge.py")], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(flushed.status, 0, flushed.stderr || flushed.stdout);
  const finished = (await call("GET", `/api/tasks?conversationId=${sent.conversationId}`)).body.tasks.find((task) => task.id === claim.id);
  assert.equal(finished.state, "COMPLETED");
  assert.ok(fs.existsSync(path.join(tmp, `bridge/done/${claim.id}.json`)));
  assert.equal((await scopedTool("send_to_bot", { agentId: "muse", text: "stale" })).status, 403);
});

test("legacy mac conversations migrate membership while preserving their transcript", async () => {
  await stop();
  const conversationsFile = path.join(tmp, "data/conversations.json"), messagesFile = path.join(tmp, "data/messages.json");
  const conversations = JSON.parse(fs.readFileSync(conversationsFile, "utf8"));
  const messages = JSON.parse(fs.readFileSync(messagesFile, "utf8"));
  conversations.push({ id: "conv_legacy", kind: "dm", members: ["mac", "muse"], createdAt: 1 });
  messages.push({ id: "msg_legacy", conversationId: "conv_legacy", from: "mac", text: "old transcript", ts: 1 });
  fs.writeFileSync(conversationsFile, JSON.stringify(conversations)); fs.writeFileSync(messagesFile, JSON.stringify(messages));
  await start();
  const continued = await tool("send_to_bot", { agentId: "muse", conversationId: "conv_legacy", newConversation: true, text: "continue legacy" }, "mac");
  assert.equal(continued.conversationId, "conv_legacy");
  const page = await tool("read_conversation", { conversationId: "conv_legacy" }, "mac");
  assert.ok(page.messages.some((message) => message.id === "msg_legacy" && message.from === "mac" && message.text === "old transcript"));
  assert.equal(page.conversation.maxTurns, 30);
});

test("webhook and A2A responses cannot resurrect canceled tasks", async () => {
  const held = new Map();
  const transport = http.createServer((req, res) => {
    let text = ""; req.on("data", (chunk) => { text += chunk; });
    req.on("end", () => { const body = JSON.parse(text); held.set(req.url, { res, body }); });
  });
  await new Promise((resolve) => transport.listen(0, "127.0.0.1", resolve));
  try {
    await stop();
    const configFile = path.join(tmp, "config.json"), agentsFile = path.join(tmp, "data/agents.json");
    const config = JSON.parse(fs.readFileSync(configFile));
    const transportBase = `http://127.0.0.1:${transport.address().port}`;
    config.grokWebhook = { url: transportBase + "/hook", key: "fixture" }; fs.writeFileSync(configFile, JSON.stringify(config));
    const agents = JSON.parse(fs.readFileSync(agentsFile)); agents.find((agent) => agent.id === "echo").endpoint = transportBase + "/a2a"; fs.writeFileSync(agentsFile, JSON.stringify(agents));
    await start();
    for (const [agentId, endpoint] of [["grok", "/hook"], ["echo", "/a2a"]]) {
      const sent = await tool("send_to_bot", { agentId, text: "held transport", newConversation: true });
      for (let attempt = 0; !held.has(endpoint) && attempt < 50; attempt++) await sleep(10);
      assert.ok(held.has(endpoint));
      await tool("interrupt", { taskId: sent.task.id });
      const { res } = held.get(endpoint);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(endpoint === "/hook" ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "remote", status: { state: "COMPLETED" }, artifacts: [{ parts: [{ text: "late transport answer" }] }] } }));
      await sleep(25);
      const task = (await call("GET", `/api/tasks?conversationId=${sent.conversationId}`)).body.tasks.find((item) => item.id === sent.task.id);
      assert.equal(task.state, "CANCELED");
      const page = await tool("read_conversation", { conversationId: sent.conversationId });
      assert.ok(!page.messages.some((message) => message.from === agentId));
    }
  } finally { for (const { res } of held.values()) if (!res.writableEnded) res.end("{}"); await new Promise((resolve) => transport.close(resolve)); }
});

test("conversation task listing retains more than 100 tasks", async () => {
  const conv = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "codex"] })).body.conversation;
  for (let i = 0; i < 102; i++) await tool("send_to_bot", { agentId: "codex", conversationId: conv.id, text: `queued ${i}` });
  const tasks = (await call("GET", `/api/tasks?conversationId=${conv.id}`)).body.tasks;
  assert.equal(tasks.length, 102);
});

test("owner registers a local relay bot and its scoped turn can delegate in the same conversation", async () => {
  const denied = await call("POST", "/api/agents", { id: "local-research", name: "Research Bot", adapter: "relay", kind: "local" }, "ui");
  assert.equal(denied.status, 403);
  const created = await call("POST", "/api/agents", { id: "local-research", name: "Research Bot", description: "Local research helper", adapter: "relay", kind: "local" }, "mac");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.agent.adapter, "relay");
  const duplicate = await call("POST", "/api/agents", { id: "local-research", name: "Research Bot", description: "Local research helper", adapter: "relay", kind: "local" }, "admin");
  assert.equal(duplicate.status, 200);
  const restored = await call("POST", "/api/agents", { id: "local-research", name: "Research Bot" }, "mac");
  assert.equal(restored.status, 200);
  assert.equal(restored.body.agent.description, "Local research helper");
  assert.equal((await call("POST", "/api/agents", { id: "local-research", name: "Research Bot", description: "" }, "mac")).status, 400);
  const bad = await call("POST", "/api/agents", { id: "muse", name: "Fake Muse", adapter: "relay", kind: "local" }, "mac");
  assert.equal(bad.status, 400);
  const conv = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "local-research", "muse"] }, "ui")).body.conversation;
  const sent = await tool("send_to_bot", { agentId: "local-research", conversationId: conv.id, text: "research this" });
  const claim = (await call("POST", "/bridge/poll", { agentId: "local-research" }, "mac")).body.tasks.find((item) => item.id === sent.task.id);
  assert.ok(claim);
  const delegated = await call("POST", "/mcp", { jsonrpc: "2.0", id: 901, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "find supporting evidence" } } }, "mac", { "x-agent-hub-task": claim.id, "x-agent-hub-claim": claim.claimToken });
  assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
  assert.equal(delegated.body.result.structuredContent.conversationId, conv.id);
  assert.equal(delegated.body.result.structuredContent.task.fromAgent, "local-research");
  assert.equal(delegated.body.result.structuredContent.task.parentTaskId, claim.id);
  assert.equal((await call("POST", "/bridge/heartbeat", { agentId: "local-research" }, "muse")).status, 403);
});

test("ordinary local Codex starts Muse to Grok to custom collaboration", async (t) => {
  // Grok is a webhook adapter: dispatch claims it immediately and waits for
  // the callback; it is not discoverable through /bridge/poll. Install an
  // isolated receiver for this test so an earlier transport test cannot leave
  // a closed webhook URL in the fixture config.
  await stop();
  const grokRequests = [];
  const grokTransport = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      grokRequests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => grokTransport.listen(0, "127.0.0.1", resolve));
  const configFile = path.join(tmp, "config.json");
  const originalConfig = fs.readFileSync(configFile);
  t.after(async () => {
    await stop();
    await new Promise((resolve) => grokTransport.close(resolve));
    fs.writeFileSync(configFile, originalConfig);
  });
  const chainConfig = JSON.parse(fs.readFileSync(configFile));
  chainConfig.grokWebhook = { url: `http://127.0.0.1:${grokTransport.address().port}/hook`, key: "fixture-grok" };
  fs.writeFileSync(configFile, JSON.stringify(chainConfig));
  await start(5_000);

  const registered = await call("POST", "/api/agents", { id: "chain-bot", name: "Chain Bot", adapter: "relay", kind: "local" }, "mac");
  assert.equal(registered.status, 201);
  for (const [body, expected] of [
    [{ id: "bad-types", name: "Bad", adapter: "bridge", kind: "local" }, /adapter must be relay/],
    [{ id: "bad-kind", name: "Bad", adapter: "relay", kind: "remote" }, /kind must be local/],
    [{ id: "bad-description", name: "Bad", description: 7 }, /description must be a string/],
  ]) {
    const response = await call("POST", "/api/agents", body, "mac");
    assert.equal(response.status, 400);
    assert.match(response.body.error, expected);
  }
  const conv = (await call("POST", "/api/conversations", { kind: "channel", members: ["user", "codex", "muse", "grok", "chain-bot"] }, "ui")).body.conversation;
  const ordinaryDm = await call("POST", "/mcp", { jsonrpc: "2.0", id: 909, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "ordinary DM" } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(ordinaryDm.status, 200);
  const ordinaryConversationId = ordinaryDm.body.result.structuredContent.conversationId;
  const userRead = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9091, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId: ordinaryConversationId } } }, "ui");
  assert.equal(userRead.status, 200);
  assert.equal(userRead.body.result.structuredContent.conversation.id, ordinaryConversationId);
  const userSend = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9092, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", conversationId: ordinaryConversationId, text: "owner follow-up" } } }, "ui");
  assert.equal(userSend.status, 200);
  const uiPost = await call("POST", `/api/conversations/${ordinaryConversationId}/messages`, { text: "owner UI follow-up", targetAgent: "muse" }, "ui");
  assert.equal(uiPost.status, 201, JSON.stringify(uiPost.body));
  assert.equal((await call("POST", `/api/conversations/${ordinaryConversationId}/reset`, {}, "ui")).status, 200);
  assert.equal((await call("POST", `/api/conversations/${ordinaryConversationId}/resume`, {}, "ui")).status, 200);
  const echoRead = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9093, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId: ordinaryConversationId } } }, "echo");
  assert.equal(echoRead.status, 200);
  assert.match(echoRead.body.error?.message || "", /caller and target/);
  assert.equal((await call("POST", `/api/conversations/${ordinaryConversationId}/messages`, { text: "intrude" }, "echo")).status, 403);
  const toMuse = await call("POST", "/mcp", { jsonrpc: "2.0", id: 910, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "ask Muse for research", conversationId: conv.id, parentTaskId: "forged-parent" } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(toMuse.status, 200, JSON.stringify(toMuse.body));
  const codexTask = toMuse.body.result.structuredContent.task;
  assert.equal(codexTask.fromAgent, "codex");
  assert.equal(codexTask.parentTaskId ?? null, null);
  assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 911, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, "ui", { "x-agent-hub-agent": "codex" })).status, 403);
  assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 912, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, "mac", { "x-agent-hub-agent": "muse" })).status, 403);
  assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 913, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, "mac", { "x-agent-hub-agent": "missing-agent" })).status, 403);
  assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 914, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, "mac", { "x-agent-hub-agent": "codex", "x-agent-hub-task": "missing", "x-agent-hub-claim": "missing" })).status, 403);
  assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 9141, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, "mac", { "x-agent-hub-agent": "", "x-agent-hub-task": "", "x-agent-hub-claim": "" })).status, 403);
  for (const role of ["ui", "muse", "grok", "echo", "relay"]) {
    assert.equal((await call("POST", "/mcp", { jsonrpc: "2.0", id: 9142, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "denied" } } }, role, { "x-agent-hub-agent": "codex" })).status, 403, role);
  }
  const customOrdinary = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9143, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "custom helper" } } }, "mac", { "x-agent-hub-agent": "chain-bot" });
  assert.equal(customOrdinary.status, 200);
  assert.equal(customOrdinary.body.result.structuredContent.task.fromAgent, "chain-bot");
  assert.equal(customOrdinary.body.result.structuredContent.task.parentTaskId ?? null, null);
  const adminOrdinary = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9144, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "admin helper" } } }, "admin", { "x-agent-hub-agent": "chain-bot" });
  assert.equal(adminOrdinary.status, 200);
  assert.equal(adminOrdinary.body.result.structuredContent.task.fromAgent, "chain-bot");
  const outside = (await call("POST", "/api/conversations", { kind: "dm", members: ["user", "muse"] }, "ui")).body.conversation;
  const readOutside = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9145, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId: outside.id } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(readOutside.status, 200);
  assert.match(readOutside.body.error?.message || "", /caller and target/);
  const ownInterrupt = await call("POST", "/mcp", { jsonrpc: "2.0", id: 9146, method: "tools/call", params: { name: "interrupt", arguments: { taskId: customOrdinary.body.result.structuredContent.task.id } } }, "mac", { "x-agent-hub-agent": "chain-bot" });
  assert.equal(ownInterrupt.status, 200);
  assert.equal(ownInterrupt.body.result.structuredContent.task.state, "CANCELED");
  const ownerOnly = await call("POST", "/mcp", { jsonrpc: "2.0", id: 915, method: "tools/call", params: { name: "reset_conversation", arguments: { conversationId: conv.id } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(ownerOnly.status, 200);
  assert.match(ownerOnly.body.error?.message || "", /conversation control requires owner/);
  const intruder = await call("POST", "/mcp", { jsonrpc: "2.0", id: 916, method: "tools/call", params: { name: "interrupt", arguments: { taskId: codexTask.id } } }, "mac", { "x-agent-hub-agent": "chain-bot" });
  assert.equal(intruder.status, 200);
  assert.match(intruder.body.error?.message || "", /only interrupt its own delegated work/);
  const muse = await claimTask("muse", codexTask.id, "muse");
  const toGrok = await call("POST", "/mcp", { jsonrpc: "2.0", id: 917, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "grok", text: "ask Grok for a web check" } } }, "muse", { "x-agent-hub-task": muse.id, "x-agent-hub-claim": muse.claimToken });
  const grokTask = toGrok.body.result.structuredContent.task;
  for (let attempt = 0; grokRequests.length === 0 && attempt < 50; attempt++) await sleep(10);
  assert.equal(grokRequests.length, 1, "Grok webhook was not dispatched");
  assert.equal(grokRequests[0].taskId, grokTask.id);
  const grok = (await call("GET", `/api/tasks?conversationId=${conv.id}`)).body.tasks.find((item) => item.id === grokTask.id);
  assert.equal(grok.state, "WORKING");
  assert.equal(grokRequests[0].claimToken, grok.claimToken);
  const toCustom = await call("POST", "/mcp", { jsonrpc: "2.0", id: 912, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "chain-bot", text: "return the checked result" } } }, "grok", { "x-agent-hub-task": grok.id, "x-agent-hub-claim": grok.claimToken });
  const customTask = toCustom.body.result.structuredContent.task;
  assert.equal(customTask.parentTaskId, grok.id);
  const custom = await claimTask("chain-bot", customTask.id, "mac");
  for (const [task, text, role, endpoint] of [[custom, "CHAIN RESULT", "mac", "/bridge/reply"], [grok, "CHAIN RESULT", "grok", "/bridge/grok/reply"], [muse, "CHAIN RESULT", "muse", "/bridge/reply"]]) {
    const response = await call("POST", endpoint, { taskId: task.id, claimToken: task.claimToken, state: "completed", text }, role);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  const page = await tool("read_conversation", { conversationId: conv.id }, "ui");
  assert.equal(page.conversationId ?? page.conversation.id, conv.id);
  assert.equal(page.messages.filter((message) => message.text === "CHAIN RESULT").length, 3);
  assert.deepEqual([grokTask.parentTaskId, customTask.parentTaskId], [muse.id, grok.id]);
  const codexWait = await call("POST", "/mcp", { jsonrpc: "2.0", id: 918, method: "tools/call", params: { name: "wait_for_conversation", arguments: { conversationId: conv.id, timeoutMs: 0 } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(codexWait.status, 200);
  assert.equal(codexWait.body.result.structuredContent.status, "settled");
  assert.ok(codexWait.body.result.structuredContent.tasks.some((task) => task.id === codexTask.id && task.state === "COMPLETED"));
  const codexRead = await call("POST", "/mcp", { jsonrpc: "2.0", id: 919, method: "tools/call", params: { name: "read_conversation", arguments: { conversationId: conv.id } } }, "mac", { "x-agent-hub-agent": "codex" });
  assert.equal(codexRead.status, 200);
  assert.ok(codexRead.body.result.structuredContent.messages.some((message) => message.from === "muse" && message.text === "CHAIN RESULT"));
});

test("user Codex claim to Muse to Grok to custom relay keeps four results", async (t) => {
  const grokRequests = [];
  const grokTransport = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { grokRequests.push(JSON.parse(raw)); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  await new Promise((resolve) => grokTransport.listen(0, "127.0.0.1", resolve));
  const configFile = path.join(tmp, "config.json"), originalConfig = fs.readFileSync(configFile);
  const chainConfig = JSON.parse(originalConfig);
  chainConfig.grokWebhook = { url: `http://127.0.0.1:${grokTransport.address().port}/hook`, key: "fixture-grok" };
  fs.writeFileSync(configFile, JSON.stringify(chainConfig));
  t.after(async () => { await stop(); await new Promise((resolve) => grokTransport.close(resolve)); fs.writeFileSync(configFile, originalConfig); });
  await start(5_000);
  const conv = (await call("POST", "/api/conversations", { kind: "channel", members: ["user", "codex", "muse", "grok", "chain-bot"] }, "ui")).body.conversation;
  const root = await tool("send_to_bot", { agentId: "codex", conversationId: conv.id, text: "coordinate the research" }, "ui");
  const codex = await claimTask("codex", root.task.id, "mac");
  const toMuse = await call("POST", "/mcp", { jsonrpc: "2.0", id: 920, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "muse", text: "ask Muse for research" } } }, "mac", { "x-agent-hub-task": codex.id, "x-agent-hub-claim": codex.claimToken });
  const museTask = toMuse.body.result.structuredContent.task, muse = await claimTask("muse", museTask.id, "muse");
  const toGrok = await call("POST", "/mcp", { jsonrpc: "2.0", id: 921, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "grok", text: "ask Grok for a web check" } } }, "muse", { "x-agent-hub-task": muse.id, "x-agent-hub-claim": muse.claimToken });
  const grokTask = toGrok.body.result.structuredContent.task;
  for (let attempt = 0; grokRequests.length === 0 && attempt < 50; attempt++) await sleep(10);
  assert.equal(grokRequests.length, 1);
  const grok = (await call("GET", `/api/tasks?conversationId=${conv.id}`)).body.tasks.find((item) => item.id === grokTask.id);
  const toCustom = await call("POST", "/mcp", { jsonrpc: "2.0", id: 922, method: "tools/call", params: { name: "send_to_bot", arguments: { agentId: "chain-bot", text: "return the checked result" } } }, "grok", { "x-agent-hub-task": grok.id, "x-agent-hub-claim": grok.claimToken });
  const customTask = toCustom.body.result.structuredContent.task, custom = await claimTask("chain-bot", customTask.id, "mac");
  for (const [task, role, endpoint] of [[custom, "mac", "/bridge/reply"], [grok, "grok", "/bridge/grok/reply"], [muse, "muse", "/bridge/reply"], [codex, "mac", "/bridge/reply"]]) {
    assert.equal((await call("POST", endpoint, { taskId: task.id, claimToken: task.claimToken, state: "completed", text: "CHAIN RESULT" }, role)).status, 200);
  }
  const page = await tool("read_conversation", { conversationId: conv.id }, "ui");
  assert.equal(page.messages.filter((message) => message.text === "CHAIN RESULT").length, 4);
  assert.deepEqual([museTask.parentTaskId, grokTask.parentTaskId, customTask.parentTaskId], [codex.id, muse.id, grok.id]);
});

test("teardown", async () => { await stop(); fs.rmSync(tmp, { recursive: true, force: true }); });
