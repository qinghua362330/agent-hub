#!/usr/bin/env node
// Agent Hub façade service — zero-dependency Node.js 24 (node: builtins only).
// Implements: roster/presence, conversations+messages, task engine with
// adapters (bridge / chief / relay / webhook / a2a), bridge poll/reply,
// MCP-over-JSON-RPC calling surface, and A2A v1.0 virtual servers.
// Persistence: JSON files under data/ with atomic writes.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(ROOT, "config.json");
const CLIENT_BRIDGE_PATH = path.join(ROOT, "..", "client", "acp-bridge.py");
const PORT = Number(process.env.PORT || 8930);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.HUB_PUBLIC_URL || `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`).replace(/\/+$/, "");

// ---------------------------------------------------------------- config
function loadConfig() {
  const gen = () => crypto.randomBytes(24).toString("hex");
  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    // migrate: add tokens for roles introduced after first boot
    let changed = false;
    for (const role of ["mac"]) {
      if (!cfg.tokens[role]) { cfg.tokens[role] = gen(); changed = true; }
    }
    if (changed) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(CONFIG_PATH, 0o600);
    }
    return cfg;
  }
  const cfg = {
    tokens: {
      ui: gen(), muse: gen(), grok: gen(),
      echo: gen(), relay: gen(), admin: gen(), mac: gen(),
    },
    // grokWebhook: { url: "https://...", key: "..." }  // fill to enable grok dispatch
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  return cfg;
}
const config = loadConfig();
// token -> role ("ui" | "muse" | "grok" | "echo" | "relay" | "admin")
const tokenRole = new Map(Object.entries(config.tokens).map(([role, tok]) => [tok, role]));
// role -> caller identity used as fromAgent in messages/tasks
const roleIdentity = { ui: "user", admin: "admin", muse: "muse", grok: "grok", echo: "echo", relay: "relay", mac: "user" };
// which agents a role may claim via /bridge/poll and answer via /bridge/reply
const claimRights = {
  muse: ["muse", "chief"],
  relay: ["codex", "claude-code"],
  mac: ["codex", "claude-code"],
  grok: ["grok"],
  echo: ["echo"],
  admin: ["muse", "chief", "grok", "codex", "claude-code", "echo"],
  ui: [],
};
const RESERVED_AGENT_IDS = new Set(["user", "admin", "relay", "mac", "scheduler"]);

// ---------------------------------------------------------------- seed data
const SEED_AGENTS = [
  { id: "muse", name: "Muse", description: "Meta Muse personal agent (remote, sandbox bridge). Research, orchestration, tools and memory.", skills: ["research", "writing", "orchestration", "tool-use"], kind: "remote", adapter: "bridge" },
  { id: "chief", name: "Chief", description: "Workbench chief-of-staff dispatcher. Decomposes goals, delegates to members, chases results, summarises. Executed by the Muse bridge with role=chief.", skills: ["planning", "delegation", "summarisation"], kind: "virtual", adapter: "chief", role: "chief" },
  { id: "grok", name: "Grok Bot", description: "xAI Grok Bot cloud teammate (remote). Woken via routine webhook; replies through its Hub connector.", skills: ["reasoning", "web-research"], kind: "remote", adapter: "webhook" },
  { id: "codex", name: "Codex", description: "OpenAI Codex on an owner's OpenMausBot host, reached through its local relay.", skills: ["coding", "code-review"], kind: "local", adapter: "relay" },
  { id: "claude-code", name: "Claude Code", description: "Claude Code on an owner's OpenMausBot host, reached through its local relay.", skills: ["coding", "refactoring"], kind: "local", adapter: "relay" },
  { id: "echo", name: "Echo", description: "Reference A2A-native bot. Proves the zero-code onboarding path: register a card, get called.", skills: ["echo", "smoke-test"], kind: "reference", adapter: "a2a", endpoint: "http://127.0.0.1:8941/a2a" },
];

// ---------------------------------------------------------------- store
function atomicWrite(file, obj) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = {
  agents: loadJson(path.join(DATA_DIR, "agents.json"), null),
  conversations: loadJson(path.join(DATA_DIR, "conversations.json"), []),
  messages: loadJson(path.join(DATA_DIR, "messages.json"), []),
  tasks: loadJson(path.join(DATA_DIR, "tasks.json"), []),
  heartbeats: loadJson(path.join(DATA_DIR, "heartbeats.json"), {}), // agentId -> {lastSeen, lastActivity}
  schedules: loadJson(path.join(DATA_DIR, "schedules.json"), []),
  grokTriggers: loadJson(path.join(DATA_DIR, "grok-triggers.json"), []), // epoch ms of webhook POSTs to grok, last hour
};
if (!Array.isArray(db.agents) || db.agents.length === 0) db.agents = SEED_AGENTS;
if (!Array.isArray(db.schedules)) db.schedules = [];
if (!Array.isArray(db.grokTriggers)) db.grokTriggers = [];
for (const conv of db.conversations) {
  conv.members = [...new Set((conv.members || []).map((member) => member === "mac" ? "user" : member))];
  conv.maxTurns = Math.min(Math.max(Number(conv.maxTurns) || 30, 1), 30);
  if (!Number.isInteger(conv.turnCount) || conv.turnCount < 0) {
    conv.turnCount = new Set(db.messages.filter((message) => message.conversationId === conv.id && message.taskId && db.agents.some((agent) => agent.id === message.from)).map((message) => message.taskId)).size;
  }
  conv.phase ||= conv.turnCount >= conv.maxTurns ? "limit-reached" : "active";
}
function save(name) { atomicWrite(path.join(DATA_DIR, name + ".json"), db[name]); }
save("agents"); save("conversations"); save("messages"); save("tasks"); save("heartbeats"); save("schedules"); save("grokTriggers");

function audit(event, fields) {
  const line = JSON.stringify({ ts: Date.now(), event, ...fields }) + "\n";
  fs.appendFileSync(path.join(DATA_DIR, "audit.jsonl"), line);
}
const newId = (p) => p + "_" + crypto.randomBytes(8).toString("hex");
const now = () => Date.now();
const TASK_LEASE_MS = Math.max(Number(process.env.HUB_TASK_LEASE_MS) || 10 * 60_000, 20);
const MAX_DISCUSSION_TURNS = 30;
const HEARTBEAT_TIMEOUT_MS = Math.max(Number(process.env.HUB_HEARTBEAT_TIMEOUT_MS) || 60_000, 20);
for (const task of db.tasks) {
  if (task.state === "WORKING" && !task.leaseExpiresAt) {
    task.claimToken ||= newId("claim"); task.claimGeneration ||= 1;
    task.leaseExpiresAt = now() + TASK_LEASE_MS;
  }
}
save("tasks");

// ---------------------------------------------------------------- presence
function touchActivity(agentId, seen = false) {
  const h = db.heartbeats[agentId] || {};
  h.lastActivity = now();
  if (seen) h.lastSeen = now();
  db.heartbeats[agentId] = h;
  save("heartbeats");
}
function recordHeartbeat(agentId, ready, reason) {
  touchActivity(agentId, true);
  const h = db.heartbeats[agentId];
  // A legacy heartbeat intentionally clears an old readiness assertion.
  h.ready = typeof ready === "boolean" ? ready : null;
  h.reason = typeof reason === "string" && reason ? reason.slice(0, 240) : undefined;
  save("heartbeats");
}
function presenceOf(agent) {
  // chief is executed by the muse bridge: its liveness mirrors muse's.
  const srcId = agent.id === "chief" ? "muse" : agent.id;
  const h = db.heartbeats[srcId] || {};
  const lastSeen = h.lastSeen || null;
  const lastActivityAt = h.lastActivity || null;
  const checkedAt = now();
  const expiresAt = lastSeen ? lastSeen + HEARTBEAT_TIMEOUT_MS : null;
  const alive = Boolean(lastSeen && lastSeen <= checkedAt && checkedAt - lastSeen < HEARTBEAT_TIMEOUT_MS);
  const busy = db.tasks.some((t) => t.targetAgent === agent.id && t.state === "WORKING");
  let configuredGrok = false;
  if (agent.id === "grok" && typeof config.grokWebhook?.url === "string") {
    try {
      const url = new URL(config.grokWebhook.url);
      configuredGrok = url.protocol === "http:" || url.protocol === "https:";
    } catch { configuredGrok = false; }
  }
  let state;
  let reason;
  if (agent.id === "grok" && !alive && !lastSeen) {
    state = configuredGrok ? "standby" : "offline";
    reason = configuredGrok ? "等待 Grok webhook 心跳" : "未配置 Grok webhook";
  } else if (!alive) {
    state = "offline";
    reason = lastSeen > checkedAt ? "心跳时间在未来，等待校准" : lastSeen ? "心跳已过期" : "尚未收到心跳";
  } else if (h.ready === false) {
    state = "online";
    reason = h.reason || "桥接在线，但执行器未就绪";
  } else if (busy) {
    state = "busy";
  } else {
    state = "online";
  }
  return { state, lastSeen, lastActivityAt, checkedAt, heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS, expiresAt, alive,
    ready: typeof h.ready === "boolean" ? h.ready : null, ...(reason ? { reason } : {}) };
}
function roster() {
  return db.agents.map((a) => ({ ...a, presence: presenceOf(a) }));
}
const getAgent = (id) => db.agents.find((a) => a.id === id);
const getConversation = (id) => db.conversations.find((c) => c.id === id);
const getTask = (id) => db.tasks.find((t) => t.id === id);

function canClaimAgent(role, agentId) {
  if ((claimRights[role] || []).includes(agentId)) return true;
  if (role !== "mac" && role !== "admin") return false;
  const agent = getAgent(agentId);
  return Boolean(agent && agent.adapter === "relay" && agent.kind === "local");
}

function validateLocalAgentRegistration(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) throw new Error("registration body must be an object");
  if (body.id !== undefined && typeof body.id !== "string") throw new Error("id must be a string");
  if (body.name !== undefined && typeof body.name !== "string") throw new Error("name must be a string");
  if (body.description !== undefined && typeof body.description !== "string") throw new Error("description must be a string");
  if (body.adapter !== undefined && body.adapter !== "relay") throw new Error("adapter must be relay");
  if (body.kind !== undefined && body.kind !== "local") throw new Error("kind must be local");
  const id = (body.id || "").trim();
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) || id.length > 64) {
    throw new Error("id must be a lowercase kebab-case value up to 64 characters");
  }
  if (RESERVED_AGENT_IDS.has(id) || id === "muse" || id === "chief" || id === "grok" || id === "echo") {
    throw new Error("agent id is reserved");
  }
  if (!name || name.length > 120) throw new Error("name is required and must be at most 120 characters");
  if (description.length > 500) throw new Error("description must be at most 500 characters");
  const existing = getAgent(id);
  if (existing) {
    if (existing.adapter !== "relay" || existing.kind !== "local") throw new Error("agent id belongs to a non-relay member");
    if (existing.name !== name || (body.description !== undefined && (existing.description || "") !== description)) throw new Error("agent already exists with different details");
    return existing;
  }
  const agent = { id, name, description, skills: [], kind: "local", adapter: "relay" };
  db.agents.push(agent);
  save("agents");
  audit("agent.register", { agentId: id, adapter: "relay" });
  return agent;
}

function apiRegisterLocalAgent(req, res, body, auth) {
  if (auth.role !== "admin" && auth.role !== "mac") return sendJson(res, 403, { error: "owner or admin registration required" });
  try {
    const existing = getAgent(String(body?.id || "").trim());
    const agent = validateLocalAgentRegistration(body);
    sendJson(res, existing ? 200 : 201, { agent });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

// ---------------------------------------------------------------- tasks
const TERMINAL = ["COMPLETED", "FAILED", "CANCELED"];
function appendMessage(conversationId, from, text, taskId) {
  const conv = getConversation(conversationId);
  if (conv && (from === "user" || from === "admin" || from === "mac" || from === "scheduler") && (conv.phase === "needs-user" || conv.phase === "proposed")) conv.phase = "active";
  // Only a task reply consumes an Agent discussion turn. Delegation messages
  // sent by an Agent are transcript entries, but must not exhaust the cap.
  const countsAsAgentTurn = Boolean(taskId && getAgent(from) && !db.messages.some((message) => message.taskId === taskId && getAgent(message.from)));
  if (conv && countsAsAgentTurn && conv.turnCount >= (conv.maxTurns || MAX_DISCUSSION_TURNS)) return null;
  const msg = { id: newId("msg"), conversationId, from, text, ts: now() };
  if (taskId) msg.taskId = taskId;
  db.messages.push(msg);
  if (conv && countsAsAgentTurn) conv.turnCount = (conv.turnCount || 0) + 1;
  if (conv && countsAsAgentTurn && conv.turnCount >= (conv.maxTurns || MAX_DISCUSSION_TURNS)) conv.phase = "limit-reached";
  save("messages");
  if (conv) save("conversations");
  return msg;
}
function createTask({ contextId, targetAgent, fromAgent, text, requestKey, parentTaskId }, opts) {
  const task = {
    id: newId("task"), contextId, targetAgent, fromAgent,
    state: "SUBMITTED", text, requestKey: requestKey || null,
    createdAt: now(), updatedAt: now(),
  };
  if (parentTaskId) task.parentTaskId = parentTaskId;
  const conv = getConversation(contextId);
  if (conv) { try { assertConversationOpen(conv, fromAgent); } catch (error) { task.state = "FAILED"; task.note = error.message; } }
  const agent = getAgent(targetAgent);
  if (agent && agent.role) task.role = agent.role;
  db.tasks.push(task);
  save("tasks");
  audit("task.create", { taskId: task.id, targetAgent, fromAgent, contextId });
  if (opts && opts.skipDispatch) return task; // caller sets the state itself (e.g. approval-gated schedule)
  if (TERMINAL.includes(task.state)) return task;
  dispatch(task).catch((e) => {
    task.note = "dispatch_error: " + (e && e.message || e);
    task.updatedAt = now(); save("tasks");
  });
  return task;
}
function finishTask(task, state, text, note) {
  if (TERMINAL.includes(task.state)) return task;
  task.state = state;
  task.updatedAt = now();
  if (text != null) task.result = text;
  if (note) task.note = note;
  save("tasks");
  audit(state === "COMPLETED" ? "task.complete" : state === "FAILED" ? "task.fail" : "task." + state.toLowerCase(),
    { taskId: task.id, targetAgent: task.targetAgent });
  touchActivity(task.targetAgent);
}
function claimTask(task) {
  task.state = "WORKING";
  task.claimToken = newId("claim");
  task.claimGeneration = (task.claimGeneration || 0) + 1;
  task.leaseExpiresAt = now() + TASK_LEASE_MS;
  task.replyAccepted = false;
  task.updatedAt = now();
}
function expireClaim(task) {
  if (task.state !== "WORKING" || !task.leaseExpiresAt || task.leaseExpiresAt > now()) return false;
  finishTask(task, "FAILED", null, "claim lease expired; retry explicitly to avoid replaying side effects");
  return true;
}
function taskSnapshot(task) {
  return { ...task, messages: db.messages.filter((message) => message.conversationId === task.contextId).slice(-200),
    ...(task.targetAgent === "chief" ? { role: "chief", instructions: "You are Chief, executed by Muse. Break the user's goal into bounded tasks, delegate with send_to_bot in this conversation, wait only for your own dispatched work, then summarize the results. Keep parentTaskId provenance. Ask the user with NEED_USER when blocked, propose with PROPOSE when a decision is required, and end the final summary with a standalone DONE. Respect the conversation turn budget. For wb.py commands set WB_TASK_ID=" + task.id + " so calls carry this active Chief claim." } : {}) };
}
function recordAgentReply(task, text, outcome) {
  const conv = getConversation(task.contextId);
  if (conv && (conv.phase === "done" || conv.phase === "limit-reached" || conv.turnCount >= conv.maxTurns)) return false;
  if (text) appendMessage(task.contextId, task.targetAgent, text, task.id);
  const lastLine = String(text || "").trim().split(/\r?\n/).at(-1);
  const marker = /^(DONE|NEED_USER|PROPOSE)(?:\s*[:：].*)?$/i.exec(lastLine || "");
  const value = String(outcome || (marker && marker[1]) || "").toUpperCase();
  const phases = { DONE: "done", NEED_USER: "needs-user", PROPOSE: "proposed" };
  if (conv && phases[value]) { conv.phase = phases[value]; save("conversations"); }
  return true;
}
async function dispatch(task) {
  if (TERMINAL.includes(task.state)) return;
  const conv = getConversation(task.contextId);
  try { if (conv) assertConversationOpen(conv, task.fromAgent); }
  catch (error) { finishTask(task, "FAILED", null, error.message); return; }
  const agent = getAgent(task.targetAgent);
  if (!agent) { finishTask(task, "FAILED", null, "unknown agent"); return; }
  if (agent.adapter === "bridge" || agent.adapter === "chief" || agent.adapter === "relay") {
    return; // stays SUBMITTED until claimed via /bridge/poll
  }
  if (agent.adapter === "webhook") {
    const gw = config.grokWebhook;
    if (!gw || !gw.url) { task.note = "awaiting_grok_config"; task.updatedAt = now(); save("tasks"); return; }
    try {
      claimTask(task); save("tasks");
      recordGrokTrigger();
      const res = await fetch(gw.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + (gw.key || "") },
        body: JSON.stringify({ taskId: task.id, conversationId: task.contextId, text: task.text, claimToken: task.claimToken, messages: taskSnapshot(task).messages }),
        signal: AbortSignal.timeout(15_000),
      });
      if (task.state !== "WORKING") return;
      if (res.ok) {
        task.note = "awaiting callback"; task.updatedAt = now(); save("tasks");
        touchActivity(task.targetAgent);
      } else {
        finishTask(task, "FAILED", null, "webhook_error: HTTP " + res.status);
      }
    } catch (e) {
      finishTask(task, "FAILED", null, "webhook_error: " + e.message);
    }
    return;
  }
  if (agent.adapter === "a2a") { void runA2a(task, agent); return; }
}
function normalizeA2aState(s) {
  if (!s) return null;
  const v = String(s).replace(/^TASK_STATE_/, "").toUpperCase();
  if (["SUBMITTED", "WORKING", "COMPLETED", "FAILED", "CANCELED"].includes(v)) return v;
  if (v === "INPUT-REQUIRED" || v === "INPUT_REQUIRED") return "INPUT_REQUIRED";
  if (v === "REJECTED" || v === "AUTH_REQUIRED" || v === "AUTH-REQUIRED") return "FAILED";
  return "WORKING";
}
function extractA2aText(taskObj) {
  if (!taskObj || typeof taskObj !== "object") return null;
  const fromParts = (parts) => (parts || []).map((p) => p.text || "").filter(Boolean).join("\n") || null;
  if (Array.isArray(taskObj.artifacts)) {
    for (const a of taskObj.artifacts) { const t = fromParts(a.parts); if (t) return t; }
  }
  if (taskObj.status && taskObj.status.message) { const t = fromParts(taskObj.status.message.parts); if (t) return t; }
  if (Array.isArray(taskObj.history)) {
    for (let i = taskObj.history.length - 1; i >= 0; i--) {
      if (taskObj.history[i].role === "ROLE_AGENT" || taskObj.history[i].role === "agent") {
        const t = fromParts(taskObj.history[i].parts); if (t) return t;
      }
    }
  }
  if (typeof taskObj.text === "string") return taskObj.text;
  return null;
}
async function a2aCall(agent, method, params) {
  const res = await fetch(agent.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: newId("rpc"), method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error("a2a HTTP " + res.status);
  const body = await res.json();
  if (body.error) throw new Error("a2a error: " + JSON.stringify(body.error));
  touchActivity(agent.id, true); // a live A2A contact doubles as its heartbeat
  return body.result;
}
async function runA2a(task, agent) {
  try {
    claimTask(task); save("tasks");
    let result = await a2aCall(agent, "SendMessage", {
      message: {
        messageId: newId("msg"), role: "ROLE_USER", contextId: task.contextId,
        parts: [{ kind: "text", text: task.text }],
        metadata: { request_key: task.requestKey, taskId: task.id },
      },
    });
    let remote = result && result.task ? result.task : result;
    if (TERMINAL.includes(task.state) || expireClaim(task)) return;
    let state = normalizeA2aState(remote && remote.status && remote.status.state) || (result && result.parts ? "COMPLETED" : "WORKING");
    const remoteId = remote && remote.id;
    if (remoteId) task.remoteTaskId = remoteId;
    const deadline = now() + 10 * 60_000;
    while (!TERMINAL.includes(state) && state !== "INPUT_REQUIRED" && now() < deadline) {
      if (TERMINAL.includes(task.state) || expireClaim(task)) return;
      task.state = "WORKING"; task.updatedAt = now(); save("tasks");
      await new Promise((r) => setTimeout(r, 3000));
      if (!remoteId) break;
      remote = await a2aCall(agent, "GetTask", { id: remoteId });
      if (TERMINAL.includes(task.state) || expireClaim(task)) return;
      task.leaseExpiresAt = now() + TASK_LEASE_MS;
      state = normalizeA2aState(remote && remote.status && remote.status.state) || "WORKING";
    }
    if (TERMINAL.includes(task.state) || expireClaim(task)) return;
    if (state === "COMPLETED") {
      const text = extractA2aText(remote) || "(completed, no text)";
      if (!recordAgentReply(task, text)) { finishTask(task, "FAILED", null, "discussion is closed"); return; }
      finishTask(task, "COMPLETED", text);
    } else if (state === "INPUT_REQUIRED") {
      if (!recordAgentReply(task, extractA2aText(remote), "NEED_USER")) { finishTask(task, "FAILED", null, "discussion is closed"); return; }
      finishTask(task, "INPUT_REQUIRED", extractA2aText(remote), "remote agent needs input");
    } else if (TERMINAL.includes(state)) {
      finishTask(task, state, extractA2aText(remote));
    } else {
      finishTask(task, "FAILED", null, "a2a poll timeout after 10 min");
    }
  } catch (e) {
    if (task.state !== "CANCELED") finishTask(task, "FAILED", null, "a2a_error: " + e.message);
  }
}
function cancelTask(task) {
  if (TERMINAL.includes(task.state)) return task;
  task.state = "CANCELED"; task.updatedAt = now(); save("tasks");
  audit("task.cancel", { taskId: task.id, targetAgent: task.targetAgent });
  const agent = getAgent(task.targetAgent);
  if (agent && agent.adapter === "a2a" && task.remoteTaskId) {
    a2aCall(agent, "CancelTask", { id: task.remoteTaskId }).catch(() => {});
  }
  return task;
}

// ---------------------------------------------------------------- schedules + approvals
// Cron expressions are evaluated in Asia/Shanghai wall time. Shanghai is
// fixed UTC+8 with no daylight saving, so wall time is UTC + 8h exactly.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const GROK_HOURLY_TOTAL_CAP = 270; // headroom under the 300/hour account cap
const GROK_PER_ROUTINE_CAP = 180;  // headroom under the 200/hour single-routine cap
const SCHEDULER_TICK_MS = Number(process.env.HUB_SCHEDULER_TICK_MS || 30_000);
const SCHEDULE_AGENTS = ["muse", "grok", "chief", "codex", "claude-code", "echo"];

function parseCronField(field, min, max) {
  if (field === "*") return null; // unrestricted
  const values = new Set();
  for (const part of String(field).split(",")) {
    let range = part, step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) { range = part.slice(0, slash); step = Number(part.slice(slash + 1)); }
    if (!Number.isInteger(step) || step < 1) throw new Error("bad cron step: " + field);
    let lo = min, hi = max;
    if (range !== "" && range !== "*") {
      const dash = range.indexOf("-");
      if (dash >= 0) { lo = Number(range.slice(0, dash)); hi = Number(range.slice(dash + 1)); }
      else { lo = hi = Number(range); }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error("bad cron field: " + field);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}
function parseCron(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression needs 5 fields: minute hour day month weekday");
  const [minute, hour, dom, month, dowRaw] = fields;
  const dow = parseCronField(dowRaw, 0, 7);
  if (dow) { if (dow.has(7)) { dow.delete(7); dow.add(0); } } // 7 == Sunday
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dom: parseCronField(dom, 1, 31),
    month: parseCronField(month, 1, 12),
    dow,
  };
}
function nextCronRun(expr, fromMs) {
  const c = parseCron(expr);
  // Step minute by minute in Shanghai wall time (kept as ms since epoch +8h).
  let t = Math.floor((fromMs + SHANGHAI_OFFSET_MS) / 60_000) * 60_000 + 60_000;
  const deadline = t + 366 * 24 * 60 * 60_000;
  while (t <= deadline) {
    const d = new Date(t);
    const dayMatch = c.dom && c.dow
      ? (c.dom.has(d.getUTCDate()) || c.dow.has(d.getUTCDay()))
      : c.dom ? c.dom.has(d.getUTCDate())
      : c.dow ? c.dow.has(d.getUTCDay())
      : true;
    if ((!c.minute || c.minute.has(d.getUTCMinutes()))
      && (!c.hour || c.hour.has(d.getUTCHours()))
      && (!c.month || c.month.has(d.getUTCMonth() + 1))
      && dayMatch) {
      return t - SHANGHAI_OFFSET_MS;
    }
    t += 60_000;
  }
  throw new Error("no cron run within a year: " + expr);
}
function runsPerHour(schedule, fromMs) {
  if (schedule.intervalMinutes) return 60 / schedule.intervalMinutes;
  let count = 0;
  let next = nextCronRun(schedule.cron, fromMs);
  const end = fromMs + 3_600_000;
  while (next <= end && count < 60) { count += 1; next = nextCronRun(schedule.cron, next); }
  return count;
}
function nextRunFor(schedule, fromMs) {
  if (schedule.intervalMinutes) return fromMs + schedule.intervalMinutes * 60_000;
  return nextCronRun(schedule.cron, fromMs);
}
function formatEnvelopeText(envelope) {
  const lines = [];
  if (envelope.goal) lines.push("目标：" + envelope.goal);
  if (envelope.background) lines.push("背景：" + envelope.background);
  if (envelope.deliverable) lines.push("交付：" + envelope.deliverable);
  if (envelope.constraints) lines.push("约束：" + envelope.constraints);
  return lines.join("\n");
}
function pruneGrokTriggers() {
  const cutoff = now() - 3_600_000;
  const kept = db.grokTriggers.filter((ts) => ts > cutoff);
  if (kept.length !== db.grokTriggers.length) { db.grokTriggers = kept; save("grokTriggers"); }
  return kept;
}
function grokTriggersThisHour() { return pruneGrokTriggers().length; }
function recordGrokTrigger() {
  db.grokTriggers.push(now());
  pruneGrokTriggers();
  save("grokTriggers");
}
function projectedGrokPerHour(excludeScheduleId) {
  let projected = grokTriggersThisHour();
  for (const s of db.schedules) {
    if (!s.enabled || s.agentId !== "grok" || s.id === excludeScheduleId) continue;
    projected += runsPerHour(s, now());
  }
  return projected;
}
// Returns an error string when the schedule would breach a Grok quota cap, else null.
function grokQuotaError(candidate, excludeScheduleId) {
  if (candidate.agentId !== "grok" || candidate.enabled === false) return null;
  const projected = projectedGrokPerHour(excludeScheduleId) + runsPerHour(candidate, now());
  if (projected > GROK_PER_ROUTINE_CAP) {
    return `grok quota guard: this schedule would push Grok routine triggers to ~${Math.ceil(projected)}/hour, over the ${GROK_PER_ROUTINE_CAP}/hour guard (per-routine cap 200/hour)`;
  }
  if (projected > GROK_HOURLY_TOTAL_CAP) {
    return `grok quota guard: this schedule would push Grok routine triggers to ~${Math.ceil(projected)}/hour, over the ${GROK_HOURLY_TOTAL_CAP}/hour guard (account cap 300/hour)`;
  }
  return null;
}
function validateScheduleInput(body, existing) {
  const agentId = String(body.agentId || (existing && existing.agentId) || "");
  if (!SCHEDULE_AGENTS.includes(agentId)) throw new Error("agentId must be one of: " + SCHEDULE_AGENTS.join(", "));
  const name = String(body.name != null ? body.name : (existing && existing.name) || "").trim();
  if (!name) throw new Error("name required");
  if (name.length > 120) throw new Error("name too long (max 120 chars)");
  const hasCron = body.cron != null && String(body.cron).trim() !== "";
  const hasInterval = body.intervalMinutes != null;
  if (hasCron && hasInterval) throw new Error("use either cron or intervalMinutes, not both");
  if (!hasCron && !hasInterval && !existing) throw new Error("cron or intervalMinutes required");
  let cron = existing ? existing.cron || null : null;
  let intervalMinutes = existing ? existing.intervalMinutes || null : null;
  if (hasCron) { parseCron(body.cron); cron = String(body.cron).trim(); intervalMinutes = null; }
  if (hasInterval) {
    intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) {
      throw new Error("intervalMinutes must be an integer 1..10080");
    }
    cron = null;
  }
  const envIn = body.envelope || (existing && existing.envelope) || {};
  const envelope = {
    goal: String(envIn.goal || "").trim(),
    background: String(envIn.background || "").trim(),
    deliverable: String(envIn.deliverable || "").trim(),
    constraints: String(envIn.constraints || "").trim(),
  };
  if (!envelope.goal) throw new Error("envelope.goal required");
  const requireApproval = body.requireApproval != null ? body.requireApproval === true
    : existing ? existing.requireApproval : false;
  const enabled = body.enabled != null ? body.enabled === true
    : existing ? existing.enabled : true;
  return { agentId, name, cron, intervalMinutes, envelope, requireApproval, enabled };
}
function sanitizeApproval(input) {
  if (!input || typeof input !== "object") throw new Error("approval {action, reason} required");
  const action = String(input.action || "").trim();
  if (!action) throw new Error("approval.action required");
  return {
    action: action.slice(0, 500),
    reason: String(input.reason || "").slice(0, 1000),
    consequence: String(input.consequence || "").slice(0, 1000),
    options: Array.isArray(input.options) && input.options.length
      ? input.options.map((o) => String(o)).slice(0, 4) : ["approve", "reject"],
    requestedAt: now(),
    decidedAt: null, decision: null, decidedBy: null,
  };
}
function requestApproval(task, approval) {
  task.state = "INPUT_REQUIRED";
  task.leaseExpiresAt = null;
  task.approval = approval;
  task.updatedAt = now();
  save("tasks");
  audit("approval.request", { taskId: task.id, targetAgent: task.targetAgent, action: approval.action });
}
async function postToGrokWebhook(payload) {
  const gw = config.grokWebhook;
  if (!gw || !gw.url) throw new Error("grok webhook not configured");
  recordGrokTrigger();
  const res = await fetch(gw.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (gw.key || "") },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error("webhook HTTP " + res.status);
}
async function resumeTask(task, decidedBy) {
  const agent = getAgent(task.targetAgent);
  task.approval.decidedAt = now();
  task.approval.decision = "approved";
  task.approval.decidedBy = decidedBy;
  task.updatedAt = now();
  audit("approval.approve", { taskId: task.id, targetAgent: task.targetAgent, decidedBy });
  appendMessage(task.contextId, "user", "已批准：" + task.approval.action, task.id);
  if (agent && agent.adapter === "webhook") {
    task.state = "WORKING";
    if (!task.claimToken) claimTask(task);
    task.leaseExpiresAt = now() + TASK_LEASE_MS;
    task.replyAccepted = false;
    task.note = "resumed after approval";
    save("tasks");
    try {
      await postToGrokWebhook({
        taskId: task.id, conversationId: task.contextId, text: task.text,
        claimToken: task.claimToken,
        kind: "approval-resume",
        approval: { decision: "approved", action: task.approval.action, originalTaskId: task.id },
      });
    } catch (e) {
      finishTask(task, "FAILED", null, "approval resume webhook failed: " + e.message);
    }
    return task;
  }
  task.state = "SUBMITTED"; // bridge/relay agents claim it on next poll; a2a re-dispatches below
  task.note = "resumed after approval";
  save("tasks");
  if (agent && agent.adapter === "a2a") dispatch(task).catch(() => {});
  return task;
}
async function rejectTask(task, decidedBy) {
  const agent = getAgent(task.targetAgent);
  task.approval.decidedAt = now();
  task.approval.decision = "rejected";
  task.approval.decidedBy = decidedBy;
  audit("approval.reject", { taskId: task.id, targetAgent: task.targetAgent, decidedBy });
  appendMessage(task.contextId, "user", "已拒绝：" + task.approval.action, task.id);
  cancelTask(task);
  if (agent && agent.adapter === "webhook") {
    // Best-effort cancel notice so Grok stops work it may have started.
    postToGrokWebhook({
      taskId: task.id, conversationId: task.contextId, text: task.text,
      kind: "approval-cancel",
      approval: { decision: "rejected", action: task.approval.action, originalTaskId: task.id },
    }).catch(() => {});
  }
  return task;
}
function scheduledConversationFor(agentId) {
  let conv = db.conversations.find((c) => c.kind === "dm" && c.members.length === 2
    && c.members.includes("user") && c.members.includes(agentId));
  if (!conv) {
    conv = { id: newId("conv"), kind: "dm", title: "", members: ["user", agentId], createdAt: now() };
    db.conversations.push(conv); save("conversations");
  }
  return conv;
}
function fireSchedule(schedule) {
  const agent = getAgent(schedule.agentId);
  if (!agent) { schedule.lastError = "unknown agent: " + schedule.agentId; save("schedules"); return; }
  if (schedule.agentId === "grok" && grokTriggersThisHour() >= GROK_PER_ROUTINE_CAP) {
    schedule.lastError = "skipped: grok quota guard (" + GROK_PER_ROUTINE_CAP + "/hour)";
    schedule.lastRunAt = now();
    schedule.nextRunAt = nextRunFor(schedule, now());
    save("schedules");
    audit("schedule.skip_quota", { scheduleId: schedule.id, agentId: "grok" });
    return;
  }
  const conv = scheduledConversationFor(schedule.agentId);
  const text = formatEnvelopeText(schedule.envelope);
  const task = createTask({
    contextId: conv.id, targetAgent: schedule.agentId, fromAgent: "scheduler", text, requestKey: null,
  }, { skipDispatch: true });
  task.scheduleId = schedule.id;
  if (TERMINAL.includes(task.state)) {
    schedule.lastError = task.note;
  } else if (schedule.requireApproval) {
    requestApproval(task, {
      action: "执行定时任务「" + schedule.name + "」",
      reason: "该日程要求每次执行前审批",
      consequence: "批准后任务立即派给 " + agent.name + " 执行；拒绝则取消本次执行",
      options: ["approve", "reject"],
      requestedAt: now(), decidedAt: null, decision: null, decidedBy: null,
    });
    task.note = "scheduled_run_awaiting_approval";
    save("tasks");
  } else {
    task.state = "SUBMITTED";
    save("tasks");
    dispatch(task).catch((e) => {
      task.note = "dispatch_error: " + (e && e.message || e);
      task.updatedAt = now(); save("tasks");
    });
  }
  schedule.lastRunAt = now();
  schedule.lastError = null;
  try { schedule.nextRunAt = nextRunFor(schedule, now()); }
  catch (e) { schedule.lastError = e.message; schedule.enabled = false; }
  save("schedules");
  audit("schedule.fire", { scheduleId: schedule.id, agentId: schedule.agentId, taskId: task.id, requireApproval: schedule.requireApproval });
}
function runDueSchedules() {
  for (const schedule of db.schedules) {
    if (!schedule.enabled || !schedule.nextRunAt) continue;
    if (schedule.nextRunAt <= now()) {
      try { fireSchedule(schedule); }
      catch (e) {
        schedule.lastError = e.message; save("schedules");
        audit("schedule.fire_error", { scheduleId: schedule.id, error: e.message });
      }
    }
  }
}

// ---------------------------------------------------------------- http utils
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}
function authOf(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return null;
  const role = tokenRole.get(m[1].trim());
  return role ? { role, identity: roleIdentity[role] } : null;
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function serveStatic(req, res, urlPath) {
  let p = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { "content-type": "text/plain" }); return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
}

// ---------------------------------------------------------------- api handlers
function apiAgents(req, res) { sendJson(res, 200, { agents: roster() }); }
function apiListConversations(req, res) { sendJson(res, 200, { conversations: db.conversations }); }
function apiCreateConversation(req, res, body) {
  const conv = {
    id: newId("conv"), kind: body.kind === "channel" ? "channel" : "dm",
    title: body.title || "", members: Array.isArray(body.members) ? body.members : [],
    createdAt: now(), maxTurns: Math.min(Math.max(Number(body.maxTurns) || MAX_DISCUSSION_TURNS, 1), MAX_DISCUSSION_TURNS),
    turnCount: 0, phase: "active",
  };
  db.conversations.push(conv); save("conversations");
  sendJson(res, 201, { conversation: conv });
}
function apiListMessages(req, res, id) {
  if (!getConversation(id)) return sendJson(res, 404, { error: "conversation not found" });
  const url = new URL(req.url, "http://localhost");
  try { sendJson(res, 200, historyPage(id, Object.fromEntries(url.searchParams))); }
  catch (error) { sendJson(res, 400, { error: error.message }); }
}
function historyPage(id, args) {
  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 50), 1), 200);
  const all = db.messages.filter((message) => message.conversationId === id);
  let cutoff = all.length;
  if (args.beforeId) {
    cutoff = all.findIndex((message) => message.id === args.beforeId);
    if (cutoff < 0) throw new Error("unknown history cursor");
  } else {
    const before = args.beforeTs ?? args.before;
    if (before !== undefined && before !== null && before !== "") {
      if (!Number.isFinite(Number(before))) throw new Error("invalid history timestamp");
      cutoff = all.findIndex((message) => message.ts >= Number(before));
      if (cutoff < 0) cutoff = all.length;
    }
  }
  const messages = all.slice(Math.max(0, cutoff - limit), cutoff);
  const hasMore = cutoff > messages.length;
  return { conversation: getConversation(id), messages, hasMore,
    nextBefore: hasMore && messages.length ? messages[0].ts : null,
    nextBeforeId: hasMore && messages.length ? messages[0].id : null };
}
function apiConversationControl(req, res, id, action, auth) {
  const conv = getConversation(id);
  if (!conv) return sendJson(res, 404, { error: "conversation not found" });
  if (!["user", "admin"].includes(auth.identity)) return sendJson(res, 403, { error: "conversation control requires owner" });
  if (action === "resume" && conv.turnCount >= conv.maxTurns) return sendJson(res, 409, { error: "turn budget exhausted; reset the discussion first" });
  conv.phase = "active";
  if (action === "reset") conv.turnCount = 0;
  conv.updatedAt = now(); save("conversations");
  sendJson(res, 200, { conversation: conv });
}
function apiRetryTask(req, res, id, auth) {
  const previous = getTask(id);
  if (!previous) return sendJson(res, 404, { error: "task not found" });
  if (!isHumanCaller(auth.identity)) return sendJson(res, 403, { error: "retry requires owner" });
  if (!["FAILED", "CANCELED"].includes(previous.state)) return sendJson(res, 409, { error: "only failed or canceled tasks may be retried" });
  try { assertConversationOpen(getConversation(previous.contextId), auth.identity); }
  catch (error) { return sendJson(res, 409, { error: error.message }); }
  appendMessage(previous.contextId, auth.identity, "Retry requested for task " + previous.id);
  const task = createTask({ contextId: previous.contextId, targetAgent: previous.targetAgent, fromAgent: auth.identity, text: previous.text, requestKey: null, parentTaskId: previous.parentTaskId });
  task.retryOf = previous.id;
  save("tasks");
  sendJson(res, 201, { task });
}
function apiPostMessage(req, res, id, body, auth) {
  const conv = getConversation(id);
  if (!conv) return sendJson(res, 404, { error: "conversation not found" });
  if (!conv.members.includes(auth.identity) && !isHumanCaller(auth.identity) && auth.identity !== "admin") return sendJson(res, 403, { error: "caller is not a conversation member" });
  try { assertConversationOpen(conv, auth.identity); }
  catch (error) { return sendJson(res, 409, { error: error.message }); }
  const text = String(body.text || "");
  if (!text) return sendJson(res, 400, { error: "text required" });
  const msg = appendMessage(id, auth.identity, text);
  const tasks = [];
  let targets = [];
  if (Array.isArray(body.mentions) && body.mentions.length) targets = body.mentions;
  else if (body.targetAgent) targets = [body.targetAgent];
  else if (conv.kind === "dm") targets = conv.members.filter((m) => m !== "user");
  for (const targetAgent of targets) {
    if (!getAgent(targetAgent)) continue;
    if (conv.kind === "channel" && !conv.members.includes(targetAgent)) continue;
    const t = createTask({ contextId: id, targetAgent, fromAgent: auth.identity, text, requestKey: body.requestKey || null });
    msg.taskId = msg.taskId || t.id;
    tasks.push(t);
  }
  if (tasks.length) save("messages");
  sendJson(res, 201, { message: msg, tasks });
}
function apiCancelTask(req, res, id) {
  const task = getTask(id);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  sendJson(res, 200, { task: cancelTask(task) });
}

// ---------------------------------------------------------------- schedules api
function apiListSchedules(req, res) {
  sendJson(res, 200, { schedules: [...db.schedules].sort((a, b) => a.createdAt - b.createdAt) });
}
function apiCreateSchedule(req, res, body, auth) {
  let input;
  try { input = validateScheduleInput(body, null); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }
  const schedule = {
    id: newId("sched"), ...input,
    nextRunAt: null, lastRunAt: null, lastError: null,
    createdBy: auth.identity, createdAt: now(), updatedAt: now(),
  };
  const quotaErr = grokQuotaError(schedule, null);
  if (quotaErr) return sendJson(res, 400, { error: quotaErr });
  if (body.nextRunAt != null) {
    const t = Number(body.nextRunAt);
    if (!Number.isFinite(t) || t < 0) return sendJson(res, 400, { error: "nextRunAt must be an epoch-ms timestamp" });
    schedule.nextRunAt = t;
  } else {
    try { schedule.nextRunAt = nextRunFor(schedule, now()); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  db.schedules.push(schedule); save("schedules");
  audit("schedule.create", { scheduleId: schedule.id, agentId: schedule.agentId, createdBy: auth.identity });
  sendJson(res, 201, { schedule });
}
function apiUpdateSchedule(req, res, id, body) {
  const schedule = db.schedules.find((s) => s.id === id);
  if (!schedule) return sendJson(res, 404, { error: "schedule not found" });
  let input;
  try { input = validateScheduleInput(body, schedule); }
  catch (e) { return sendJson(res, 400, { error: e.message }); }
  const cadenceChanged = input.cron !== schedule.cron || input.intervalMinutes !== schedule.intervalMinutes;
  const quotaErr = grokQuotaError({ ...schedule, ...input }, schedule.id);
  if (quotaErr) return sendJson(res, 400, { error: quotaErr });
  Object.assign(schedule, input, { updatedAt: now() });
  if (cadenceChanged && schedule.enabled) {
    try { schedule.nextRunAt = nextRunFor(schedule, now()); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (body.nextRunAt != null) {
    const t = Number(body.nextRunAt);
    if (!Number.isFinite(t) || t < 0) return sendJson(res, 400, { error: "nextRunAt must be an epoch-ms timestamp" });
    schedule.nextRunAt = t;
  }
  save("schedules");
  audit("schedule.update", { scheduleId: schedule.id, agentId: schedule.agentId });
  sendJson(res, 200, { schedule });
}
function apiDeleteSchedule(req, res, id) {
  const idx = db.schedules.findIndex((s) => s.id === id);
  if (idx < 0) return sendJson(res, 404, { error: "schedule not found" });
  const [removed] = db.schedules.splice(idx, 1);
  save("schedules");
  audit("schedule.delete", { scheduleId: removed.id, agentId: removed.agentId });
  sendJson(res, 200, { deleted: removed.id });
}

// ---------------------------------------------------------------- approvals api
function approvalView(task) {
  return {
    taskId: task.id, targetAgent: task.targetAgent, fromAgent: task.fromAgent,
    conversationId: task.contextId, text: task.text, approval: task.approval,
    scheduleId: task.scheduleId || null, createdAt: task.createdAt, updatedAt: task.updatedAt,
  };
}
function apiListApprovals(req, res) {
  const pending = db.tasks
    .filter((t) => t.state === "INPUT_REQUIRED" && t.approval)
    .sort((a, b) => a.approval.requestedAt - b.approval.requestedAt)
    .map(approvalView);
  sendJson(res, 200, { approvals: pending });
}
async function apiApproveTask(req, res, id, auth) {
  const task = getTask(id);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  if (task.state !== "INPUT_REQUIRED" || !task.approval) {
    return sendJson(res, 409, { error: "task is not awaiting approval (state " + task.state + ")" });
  }
  if (task.approval.decision) return sendJson(res, 409, { error: "approval already decided: " + task.approval.decision });
  await resumeTask(task, auth.identity);
  sendJson(res, 200, { task });
}
async function apiRejectTask(req, res, id, auth) {
  const task = getTask(id);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  if (task.state !== "INPUT_REQUIRED" || !task.approval) {
    return sendJson(res, 409, { error: "task is not awaiting approval (state " + task.state + ")" });
  }
  if (task.approval.decision) return sendJson(res, 409, { error: "approval already decided: " + task.approval.decision });
  await rejectTask(task, auth.identity);
  sendJson(res, 200, { task });
}

// ---------------------------------------------------------------- bridge
function bridgePoll(req, res, body, auth) {
  const agentId = body.agentId;
  if (!canClaimAgent(auth.role, agentId)) return sendJson(res, 403, { error: "token may not claim agent " + agentId });
  const limit = body.limit === undefined ? 5 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1) return sendJson(res, 400, { error: "limit must be a positive integer" });
  for (const task of db.tasks.filter((item) => item.targetAgent === agentId)) expireClaim(task);
  const pending = [];
  for (const task of db.tasks.filter((item) => item.targetAgent === agentId && item.state === "SUBMITTED")) {
    try { assertConversationOpen(getConversation(task.contextId), task.fromAgent); }
    catch (error) { finishTask(task, "FAILED", null, error.message); continue; }
    claimTask(task); pending.push(task);
    if (pending.length >= Math.min(limit, 20)) break;
  }
  if (pending.length) save("tasks");
  if (pending.length) touchActivity(agentId, true);
  sendJson(res, 200, { tasks: pending.map(taskSnapshot) });
}
function bridgeRenew(req, res, body, auth) {
  const task = getTask(body.taskId);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  if (!canClaimAgent(auth.role, task.targetAgent)) return sendJson(res, 403, { error: "token may not renew this agent" });
  if (expireClaim(task) || task.state !== "WORKING" || !task.claimToken || body.claimToken !== task.claimToken) return sendJson(res, 409, { error: "claim is no longer active", task });
  task.leaseExpiresAt = now() + TASK_LEASE_MS; task.updatedAt = now(); save("tasks");
  sendJson(res, 200, { task });
}
function bridgeReply(req, res, body, auth) {
  const task = getTask(body.taskId);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  if (!canClaimAgent(auth.role, task.targetAgent)) return sendJson(res, 403, { error: "token may not answer for " + task.targetAgent });
  const legacyReply = !body.claimToken && !task.retryOf && (task.claimGeneration || 1) === 1;
  const matches = Boolean(task.claimToken && (body.claimToken === task.claimToken || legacyReply));
  if (TERMINAL.includes(task.state) || task.state === "INPUT_REQUIRED") {
    if (task.state !== "CANCELED" && task.replyAccepted && matches) return sendJson(res, 200, { task, idempotent: true });
    return sendJson(res, 409, { error: "claim is no longer active", task });
  }
  if (expireClaim(task) || task.state !== "WORKING" || !matches) return sendJson(res, 409, { error: "claim is no longer active", task });
  const stateMap = { completed: "COMPLETED", complete: "COMPLETED", done: "COMPLETED", "input-required": "INPUT_REQUIRED", input_required: "INPUT_REQUIRED", needs_user: "INPUT_REQUIRED", "needs-user": "INPUT_REQUIRED", failed: "FAILED", error: "FAILED" };
  const state = stateMap[String(body.state || "").toLowerCase()] || body.state;
  if (!["COMPLETED", "INPUT_REQUIRED", "FAILED"].includes(state)) {
    return sendJson(res, 400, { error: "state must be COMPLETED|INPUT_REQUIRED|FAILED" });
  }
  const text = body.text != null ? String(body.text) : null;
  let approval;
  if (state === "INPUT_REQUIRED" && body.approval) {
    try { approval = sanitizeApproval(body.approval); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (!recordAgentReply(task, text, body.outcome || (state === "INPUT_REQUIRED" ? "NEED_USER" : undefined))) {
    finishTask(task, "FAILED", null, "discussion is closed; resume or reset it first");
    return sendJson(res, 409, { error: "discussion is closed", task });
  }
  // A valid, accepted reply proves the executor is reachable, but without an
  // explicit readiness heartbeat it must not claim that its model is ready.
  touchActivity(task.targetAgent, true);
  task.replyAccepted = true;
  if (approval) {
    if (text != null) task.result = text;
    requestApproval(task, approval);
    return sendJson(res, 200, { task });
  }
  finishTask(task, state, text, body.note || undefined);
  sendJson(res, 200, { task });
}
function bridgeHeartbeat(req, res, body, auth) {
  const agentId = body.agentId;
  if (!getAgent(agentId)) return sendJson(res, 404, { error: "unknown agent" });
  if (!canClaimAgent(auth.role, agentId)) return sendJson(res, 403, { error: "token may not heartbeat this agent" });
  if (body.ready !== undefined && typeof body.ready !== "boolean") return sendJson(res, 400, { error: "ready must be a boolean" });
  if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 240)) {
    return sendJson(res, 400, { error: "reason must be a string of at most 240 characters" });
  }
  recordHeartbeat(agentId, body.ready, body.reason);
  sendJson(res, 200, { ok: true, agentId, lastSeen: db.heartbeats[agentId].lastSeen, ready: db.heartbeats[agentId].ready,
    ...(body.reason ? { reason: body.reason.slice(0, 240) } : {}) });
}
function bridgeGrokReply(req, res, body, auth) {
  if (auth.role !== "grok" && auth.role !== "admin") return sendJson(res, 403, { error: "grok token required" });
  const task = getTask(body.taskId);
  if (!task) return sendJson(res, 404, { error: "task not found" });
  if (task.targetAgent !== "grok") return sendJson(res, 400, { error: "task is not for grok" });
  const text = body.text != null ? String(body.text) : "";
  // Grok asks for approval through the Hub, never its own card (which
  // expires after ~30 min): state "input-required" + approval metadata.
  const state = String(body.state || "completed").toLowerCase();
  if (state === "input-required" || state === "input_required" || state === "needs-user" || body.approval) {
    return bridgeReply(req, res, { ...body, state: "INPUT_REQUIRED", approval: body.approval || { action: text.slice(0, 500) || "Grok 请求审批", reason: text } }, auth);
  }
  return bridgeReply(req, res, { ...body, state: body.state || "COMPLETED" }, auth);
}

// ---------------------------------------------------------------- mcp surface
const MCP_TOOLS = [
  { name: "list_members", description: "List workbench members with presence, kind, skills.", inputSchema: { type: "object", properties: {} } },
  { name: "get_member_status", description: "Read one teammate's current heartbeat and execution readiness without creating work.", inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] } },
  { name: "send_to_bot", description: "Send a message to one bot in an explicit conversation or caller DM. requestKey dedupes retries.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, text: { type: "string" }, requestKey: { type: "string" }, conversationId: { type: "string" }, newConversation: { type: "boolean" }, parentTaskId: { type: "string" } }, required: ["agentId", "text"] } },
  { name: "send_to_channel", description: "Post a message to a channel; mentions[] fans out one task per mentioned agent. requestKey dedupes retries.", inputSchema: { type: "object", properties: { channelId: { type: "string" }, text: { type: "string" }, mentions: { type: "array", items: { type: "string" } }, requestKey: { type: "string" }, parentTaskId: { type: "string" } }, required: ["channelId", "text"] } },
  { name: "wait_for_conversation", description: "Long-poll until a conversation has no pending tasks or timeout. Returns status settled|needs-user|failed|working.", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, timeoutMs: { type: "number" } }, required: ["conversationId"] } },
  { name: "read_conversation", description: "Read recent messages of a conversation; use beforeId for older pages without timestamp loss.", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, limit: { type: "number" }, beforeTs: { type: "number" }, beforeId: { type: "string" } }, required: ["conversationId"] } },
  { name: "resume_conversation", description: "Resume a user-paused discussion.", inputSchema: { type: "object", properties: { conversationId: { type: "string" } }, required: ["conversationId"] } },
  { name: "reset_conversation", description: "Reset discussion turn count and resume it.", inputSchema: { type: "object", properties: { conversationId: { type: "string" } }, required: ["conversationId"] } },
  { name: "interrupt", description: "Cancel a running task.", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
];
function findDm(a, b) {
  return db.conversations.find((c) => c.kind === "dm" && c.members.length === 2 &&
    c.members.includes(a) && c.members.includes(b));
}
function isHumanCaller(caller) { return caller === "user" || caller === "admin" || caller === "mac"; }
function assertConversationParticipant(conv, caller, target) {
  if ((!isHumanCaller(caller) && caller !== "admin" && !conv.members.includes(caller)) || (target && !conv.members.includes(target))) {
    throw new Error("conversation does not include caller and target");
  }
}
function assertConversationOpen(conv, caller) {
  if (!conv) throw new Error("unknown conversation");
  if (conv.phase === "limit-reached" || conv.phase === "done" || (conv.turnCount || 0) >= (conv.maxTurns || MAX_DISCUSSION_TURNS)) throw new Error("discussion is closed; resume or reset it first");
  if ((conv.phase === "needs-user" || conv.phase === "proposed") && !isHumanCaller(caller)) {
    throw new Error("discussion is waiting for the user");
  }
}
async function mcpCall(name, args, caller) {
  audit("mcp.call", { tool: name, caller });
  switch (name) {
    case "list_members":
      return { members: roster() };
    case "get_member_status": {
      const member = getAgent(String(args.agentId || ""));
      if (!member) throw new Error("unknown agent: " + args.agentId);
      return { member: { ...member, presence: presenceOf(member) } };
    }
    case "send_to_bot": {
      const target = getAgent(args.agentId);
      if (!target) throw new Error("unknown agent: " + args.agentId);
      if (args.requestKey) {
        const dup = db.tasks.find((t) => t.fromAgent === caller && t.requestKey === args.requestKey && (!args.conversationId || t.contextId === args.conversationId));
        if (dup) return { task: dup, conversationId: dup.contextId, deduplicated: true };
      }
      let conv;
      if (args.conversationId) {
        conv = getConversation(String(args.conversationId));
        if (!conv) throw new Error("unknown conversation: " + args.conversationId);
        assertConversationParticipant(conv, caller);
      }
      const forceNew = !args.conversationId && args.newConversation === true;
      if (forceNew) conv = null;
      if (!conv && !forceNew) conv = findDm(caller, args.agentId);
      if (!conv) {
        conv = { id: newId("conv"), kind: "dm", title: "", members: [caller, args.agentId], createdAt: now(), maxTurns: MAX_DISCUSSION_TURNS, turnCount: 0, phase: "active" };
        db.conversations.push(conv); save("conversations");
      }
      assertConversationOpen(conv, caller);
      if (!conv.members.includes(args.agentId)) { conv.members.push(args.agentId); save("conversations"); }
      appendMessage(conv.id, caller, String(args.text || ""));
      const task = createTask({ contextId: conv.id, targetAgent: args.agentId, fromAgent: caller, text: String(args.text || ""), requestKey: args.requestKey || null, parentTaskId: args.parentTaskId || null });
      return { task, conversationId: conv.id };
    }
    case "send_to_channel": {
      const conv = getConversation(args.channelId);
      if (!conv) throw new Error("unknown channel: " + args.channelId);
      if (conv.kind !== "channel") throw new Error("conversation is not a channel");
      assertConversationParticipant(conv, caller);
      assertConversationOpen(conv, caller);
      const mentions = Array.isArray(args.mentions) ? [...new Set(args.mentions)] : [];
      for (const targetAgent of mentions) {
        if (!getAgent(targetAgent)) throw new Error("unknown channel member: " + targetAgent);
        if (!conv.members.includes(targetAgent)) throw new Error("target is not a channel member: " + targetAgent);
      }
      if (args.requestKey) {
        const duplicate = db.tasks.find((t) => t.fromAgent === caller && t.contextId === conv.id && t.requestKey === args.requestKey);
        if (duplicate) return { conversationId: conv.id, tasks: db.tasks.filter((t) => t.fromAgent === caller && t.contextId === conv.id && t.requestKey === args.requestKey), deduplicated: true };
      }
      appendMessage(conv.id, caller, String(args.text || ""));
      const tasks = [];
      for (const targetAgent of mentions) {
        tasks.push(createTask({ contextId: conv.id, targetAgent, fromAgent: caller, text: String(args.text || ""), requestKey: args.requestKey || null, parentTaskId: args.parentTaskId || null }));
      }
      return { conversationId: conv.id, tasks };
    }
    case "wait_for_conversation": {
      const conv = getConversation(args.conversationId);
      if (!conv) throw new Error("unknown conversation: " + args.conversationId);
      assertConversationParticipant(conv, caller);
      const timeout = Math.min(Math.max(Number(args.timeoutMs) || 25_000, 0), 55_000);
      const deadline = now() + timeout;
      for (;;) {
        // Wait only on work the caller itself dispatched in this conversation.
        // Counting the caller's own inbound tasks would self-deadlock mutual
        // calls (A asks B; B asks A back inside the same shared DM).
        const tasks = db.tasks.filter((t) => t.contextId === conv.id && (t.fromAgent === caller || (caller === "user" && t.fromAgent === "mac")));
        const pending = tasks.filter((t) => t.state === "SUBMITTED" || t.state === "WORKING");
        if (!pending.length || now() >= deadline) {
          let status = "settled";
          if (pending.length) status = "working";
          else if (tasks.some((t) => t.state === "INPUT_REQUIRED")) status = "needs-user";
          else if (tasks.some((t) => t.state === "FAILED")) status = "failed";
          return {
            status, tasks,
            recentMessages: db.messages.filter((m) => m.conversationId === conv.id).slice(-10),
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    case "read_conversation": {
      const conv = getConversation(args.conversationId);
      if (!conv) throw new Error("unknown conversation: " + args.conversationId);
      assertConversationParticipant(conv, caller);
      return historyPage(conv.id, args);
    }
    case "resume_conversation":
    case "reset_conversation": {
      const conv = getConversation(args.conversationId);
      if (!conv) throw new Error("unknown conversation: " + args.conversationId);
      if (caller !== "user" && caller !== "admin") throw new Error("conversation control requires owner");
      assertConversationParticipant(conv, caller);
      if (name === "resume_conversation" && conv.turnCount >= conv.maxTurns) throw new Error("turn budget exhausted; reset the discussion first");
      conv.phase = "active";
      if (name === "reset_conversation") conv.turnCount = 0;
      conv.updatedAt = now(); save("conversations");
      return { conversation: conv };
    }
    case "interrupt": {
      const task = getTask(args.taskId);
      if (!task) throw new Error("unknown task: " + args.taskId);
      return { task: cancelTask(task) };
    }
    default:
      throw new Error("unknown tool: " + name);
  }
}
async function handleMcp(req, res, body, auth) {
  const { id, method, params } = body || {};
  try {
    const scopedTaskId = req.headers["x-agent-hub-task"];
    const scopedClaim = req.headers["x-agent-hub-claim"];
    const requestedAgent = req.headers["x-agent-hub-agent"];
    const hasTaskHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-agent-hub-task");
    const hasClaimHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-agent-hub-claim");
    const hasAgentHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-agent-hub-agent");
    let scopedTask = null;
    let callerAgent = null;
    if (hasAgentHeader && (hasTaskHeader || hasClaimHeader)) {
      return sendJson(res, 403, { error: "agent identity cannot be combined with a scoped task claim" });
    }
    if (hasAgentHeader) {
      const agent = getAgent(String(requestedAgent));
      if (!agent || !["mac", "admin"].includes(auth.role) || agent.kind !== "local" || agent.adapter !== "relay") {
        return sendJson(res, 403, { error: "invalid local agent identity" });
      }
      callerAgent = agent.id;
    }
    if (hasTaskHeader || hasClaimHeader) {
      if (!hasTaskHeader || !hasClaimHeader || !scopedTaskId || !scopedClaim) {
        return sendJson(res, 403, { error: "invalid scoped MCP credentials" });
      }
      scopedTask = getTask(String(scopedTaskId));
      if (!scopedTask || !canClaimAgent(auth.role, scopedTask.targetAgent) || scopedTask.state !== "WORKING" ||
        !scopedTask.claimToken || scopedTask.claimToken !== String(scopedClaim) ||
        (scopedTask.leaseExpiresAt && scopedTask.leaseExpiresAt <= now())) {
        return sendJson(res, 403, { error: "scoped task claim is no longer active" });
      }
    }
    // MCP lifecycle: notifications carry no id and expect no response body.
    if (typeof method === "string" && method.startsWith("notifications/")) {
      res.writeHead(202); return res.end();
    }
    if (method === "initialize") {
      const want = params && params.protocolVersion;
      return sendJson(res, 200, { jsonrpc: "2.0", id, result: {
        protocolVersion: want || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-hub", version: "1.0.0" },
      } });
    }
    if (method === "ping") return sendJson(res, 200, { jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    if (method === "tools/call") {
      const name = params && params.name;
      const args = { ...((params && params.arguments) || {}) };
      let caller = callerAgent || auth.identity;
      if (scopedTask) {
        caller = scopedTask.targetAgent;
        if (name === "send_to_bot") {
          if (args.newConversation) throw new Error("scoped task cannot create a new conversation");
          if (args.conversationId && String(args.conversationId) !== scopedTask.contextId) throw new Error("scoped task cannot switch conversation");
          args.conversationId = scopedTask.contextId; args.newConversation = false; args.parentTaskId = scopedTask.id;
        } else if (name === "send_to_channel") {
          if (args.channelId && String(args.channelId) !== scopedTask.contextId) throw new Error("scoped task cannot switch conversation");
          args.channelId = scopedTask.contextId; args.parentTaskId = scopedTask.id;
        } else if (["read_conversation", "wait_for_conversation", "resume_conversation", "reset_conversation"].includes(name)) {
          if (args.conversationId && String(args.conversationId) !== scopedTask.contextId) throw new Error("scoped task cannot switch conversation");
          args.conversationId = scopedTask.contextId;
        } else if (name === "interrupt") {
          const target = getTask(args.taskId);
          if (!target || target.contextId !== scopedTask.contextId || target.fromAgent !== caller) throw new Error("scoped task may only interrupt its own delegated work");
        }
      } else if (callerAgent) {
        if (name === "send_to_bot" || name === "send_to_channel") args.parentTaskId = null;
        if (name === "interrupt") {
          const target = getTask(args.taskId);
          if (!target || target.fromAgent !== callerAgent) throw new Error("local agent may only interrupt its own delegated work");
        }
      }
      const result = await mcpCall(name, args, caller);
      return sendJson(res, 200, {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
      });
    }
    return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
  } catch (e) {
    return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
  }
}

// ---------------------------------------------------------------- a2a surface
const WAP_EXTENSIONS = ["urn:workbench:envelope:1", "urn:workbench:channel:1", "urn:workbench:presence:1"];
function agentCard(agent) {
  return {
    name: agent.name,
    description: agent.description,
    url: PUBLIC_URL + "/a2a/" + agent.id,
    version: "1.0.0",
    protocolVersion: "1.0",
    capabilities: {
      streaming: false, pushNotifications: true,
      extensions: WAP_EXTENSIONS.map((uri) => ({ uri, required: false })),
    },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: (agent.skills || []).map((s) => ({ id: s, name: s, description: s, tags: [s] })),
  };
}
function a2aTaskView(task) {
  return {
    id: task.id, contextId: task.contextId,
    status: { state: task.state, timestamp: new Date(task.updatedAt).toISOString() },
    kind: "task",
    metadata: { targetAgent: task.targetAgent, fromAgent: task.fromAgent, note: task.note || null },
    ...(task.result ? { artifacts: [{ artifactId: task.id + "-result", parts: [{ kind: "text", text: task.result }] }] } : {}),
  };
}
function handleA2a(req, res, agentId, body, auth) {
  const agent = getAgent(agentId);
  if (!agent) return sendJson(res, 404, { error: "unknown agent" });
  const { id, method, params } = body || {};
  const ok = (result) => sendJson(res, 200, { jsonrpc: "2.0", id, result });
  const err = (message, code = -32000) => sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  if (method === "SendMessage") {
    const msg = (params && params.message) || {};
    const text = (msg.parts || []).map((p) => p.text || "").filter(Boolean).join("\n");
    const requestKey = (msg.metadata && msg.metadata.request_key) || null;
    if (requestKey) {
      const dup = db.tasks.find((t) => t.fromAgent === auth.identity && t.requestKey === requestKey && (!msg.contextId || t.contextId === msg.contextId));
      if (dup) return ok(a2aTaskView(dup));
    }
    let conv = msg.contextId ? getConversation(msg.contextId) : null;
    if (msg.contextId && !conv) return err("unknown conversation");
    if (!conv) {
      conv = { id: newId("conv"), kind: "dm", title: "", members: [auth.identity, agentId], createdAt: now(), maxTurns: MAX_DISCUSSION_TURNS, turnCount: 0, phase: "active" };
      db.conversations.push(conv); save("conversations");
    }
    try { assertConversationParticipant(conv, auth.identity, agentId); assertConversationOpen(conv, auth.identity); }
    catch (error) { return err(error.message); }
    appendMessage(conv.id, auth.identity, text);
    const task = createTask({ contextId: conv.id, targetAgent: agentId, fromAgent: auth.identity, text, requestKey });
    return ok(a2aTaskView(task));
  }
  if (method === "GetTask") {
    const task = getTask(params && (params.id || params.taskId));
    return task ? ok(a2aTaskView(task)) : err("task not found", -32001);
  }
  if (method === "ListTasks") {
    let tasks = db.tasks.filter((t) => t.targetAgent === agentId);
    if (params && params.contextId) tasks = tasks.filter((t) => t.contextId === params.contextId);
    return ok({ tasks: tasks.map(a2aTaskView) });
  }
  if (method === "CancelTask") {
    const task = getTask(params && (params.id || params.taskId));
    return task ? ok(a2aTaskView(cancelTask(task))) : err("task not found", -32001);
  }
  return err("method not found: " + method, -32601);
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/health") return sendJson(res, 200, { service: "agent-hub", version: "1.3.1" });
    if (req.method === "GET" && p === "/downloads/acp-bridge.py") {
      if (!fs.existsSync(CLIENT_BRIDGE_PATH)) return sendJson(res, 404, { error: "client bridge is not installed" });
      const source = fs.readFileSync(CLIENT_BRIDGE_PATH);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="acp-bridge.py"',
        "x-content-type-options": "nosniff",
        "x-checksum-sha256": crypto.createHash("sha256").update(source).digest("hex"),
      });
      return res.end(source);
    }
    // A2A agent cards are public discovery documents.
    let m = /^\/a2a\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(p);
    if (req.method === "GET" && m) {
      const agent = getAgent(decodeURIComponent(m[1]));
      return agent ? sendJson(res, 200, agentCard(agent)) : sendJson(res, 404, { error: "unknown agent" });
    }
    // Static UI (no token; the JS prompts for and stores a token).
    if (req.method === "GET" && !p.startsWith("/api") && !p.startsWith("/bridge") && !p.startsWith("/mcp") && !p.startsWith("/a2a")) {
      return serveStatic(req, res, p);
    }
    const auth = authOf(req);
    if (!auth) return sendJson(res, 401, { error: "missing or invalid bearer token" });
    const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : {};

    if (req.method === "GET" && p === "/api/agents") return apiAgents(req, res);
    if (req.method === "POST" && p === "/api/agents") return apiRegisterLocalAgent(req, res, body, auth);
    if (req.method === "GET" && p === "/api/conversations") return apiListConversations(req, res);
    if (req.method === "POST" && p === "/api/conversations") return apiCreateConversation(req, res, body);
    m = /^\/api\/conversations\/([^/]+)\/messages$/.exec(p);
    if (m && req.method === "GET") return apiListMessages(req, res, decodeURIComponent(m[1]));
    if (m && req.method === "POST") return apiPostMessage(req, res, decodeURIComponent(m[1]), body, auth);
    m = /^\/api\/conversations\/([^/]+)\/(resume|reset)$/.exec(p);
    if (m && req.method === "POST") return apiConversationControl(req, res, decodeURIComponent(m[1]), m[2], auth);
    if (req.method === "GET" && p === "/api/tasks") {
      const conversationId = new URL(req.url, "http://localhost").searchParams.get("conversationId");
      const items = [...db.tasks].filter((t) => !conversationId || t.contextId === conversationId).sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJson(res, 200, { tasks: conversationId ? items : items.slice(0, 100) });
    }
    m = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(p);
    if (m && req.method === "POST") return apiCancelTask(req, res, decodeURIComponent(m[1]));
    m = /^\/api\/tasks\/([^/]+)\/retry$/.exec(p);
    if (m && req.method === "POST") return apiRetryTask(req, res, decodeURIComponent(m[1]), auth);

    if (req.method === "GET" && p === "/api/schedules") return apiListSchedules(req, res);
    if (req.method === "POST" && p === "/api/schedules") return apiCreateSchedule(req, res, body, auth);
    m = /^\/api\/schedules\/([^/]+)$/.exec(p);
    if (m && req.method === "PATCH") return apiUpdateSchedule(req, res, decodeURIComponent(m[1]), body);
    if (m && req.method === "DELETE") return apiDeleteSchedule(req, res, decodeURIComponent(m[1]));

    if (req.method === "GET" && p === "/api/approvals") return apiListApprovals(req, res);
    m = /^\/api\/approvals\/([^/]+)\/approve$/.exec(p);
    if (m && req.method === "POST") return await apiApproveTask(req, res, decodeURIComponent(m[1]), auth);
    m = /^\/api\/approvals\/([^/]+)\/reject$/.exec(p);
    if (m && req.method === "POST") return await apiRejectTask(req, res, decodeURIComponent(m[1]), auth);

    if (req.method === "POST" && p === "/bridge/poll") return bridgePoll(req, res, body, auth);
    if (req.method === "POST" && p === "/bridge/renew") return bridgeRenew(req, res, body, auth);
    if (req.method === "POST" && p === "/bridge/reply") return bridgeReply(req, res, body, auth);
    if (req.method === "POST" && p === "/bridge/heartbeat") return bridgeHeartbeat(req, res, body, auth);
    if (req.method === "POST" && p === "/bridge/grok/reply") return bridgeGrokReply(req, res, body, auth);

    if (req.method === "POST" && p === "/mcp") return await handleMcp(req, res, body, auth);
    m = /^\/a2a\/([^/]+)$/.exec(p);
    if (m && req.method === "POST") return handleA2a(req, res, decodeURIComponent(m[1]), body, auth);

    return sendJson(res, 404, { error: "not found: " + req.method + " " + p });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`agent-hub façade listening on http://${HOST}:${PORT}`);
});

// Scheduler tick: fire due schedules every 30s (HUB_SCHEDULER_TICK_MS in tests).
setInterval(() => {
  try {
    for (const task of db.tasks) expireClaim(task);
    runDueSchedules();
  } catch (e) { console.error("scheduler tick failed:", e.message); }
}, SCHEDULER_TICK_MS);

// Testability: pure schedule helpers are exported when required as a module;
// running `node server.js` is unaffected.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCron, nextCronRun, runsPerHour, formatEnvelopeText, validateScheduleInput, sanitizeApproval };
}
