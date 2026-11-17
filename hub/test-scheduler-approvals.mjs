#!/usr/bin/env node
// Scheduler + approvals integration test for the Agent Hub.
// Runs the hub from an isolated copy (own data dir + config) on PORT 8939
// with a 1s scheduler tick, plus a fake Grok webhook that records POSTs.
// Usage: node hub/test-scheduler-approvals.mjs
// Exit 0 = all checks pass. Uses only node: builtins.
"use strict";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const HUB_ROOT = path.resolve(import.meta.dirname);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hub-sched-test-"));
const HUB_COPY = path.join(TMP, "server.js");
fs.copyFileSync(path.join(HUB_ROOT, "server.js"), HUB_COPY);
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });

const PORT = 8939;
const HOOK_PORT = 8960;
const HUB = `http://127.0.0.1:${PORT}`;

// Fake Grok webhook: records every POST body, always 200.
const hookCalls = [];
const hookServer = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    try { hookCalls.push(JSON.parse(data)); } catch { hookCalls.push({ raw: data }); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => hookServer.listen(HOOK_PORT, "127.0.0.1", r));

// Pre-seed the copied hub's config with a Grok webhook pointing at the fake.
const cfgPath = path.join(TMP, "config.json");
const seedCfg = {
  tokens: {
    ui: "tok-ui", muse: "tok-muse", grok: "tok-grok", echo: "tok-echo",
    relay: "tok-relay", admin: "tok-admin", mac: "tok-mac",
  },
  grokWebhook: { url: `http://127.0.0.1:${HOOK_PORT}/hook`, key: "hook-key" },
};
fs.writeFileSync(cfgPath, JSON.stringify(seedCfg, null, 2), { mode: 0o600 });

const child = spawn(process.execPath, [HUB_COPY], {
  cwd: TMP,
  env: { ...process.env, PORT: String(PORT), HUB_SCHEDULER_TICK_MS: "1000" },
  stdio: ["ignore", "pipe", "pipe"],
});
let hubLog = "";
child.stdout.on("data", (d) => { hubLog += d; });
child.stderr.on("data", (d) => { hubLog += d; });
process.on("exit", () => { try { child.kill(); } catch {} try { hookServer.close(); } catch {} });

async function waitHubUp() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HUB + "/api/agents", { headers: { Authorization: "Bearer tok-admin" } });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("hub did not come up: " + hubLog);
}
await waitHubUp();

const admin = { Authorization: "Bearer tok-admin" };
const museTok = { Authorization: "Bearer tok-muse" };
const grokTok = { Authorization: "Bearer tok-grok" };

async function call(method, p, token, body) {
  const res = await fetch(HUB + p, {
    method,
    headers: { "content-type": "application/json", ...(token || admin) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch {}
  return { status: res.status, body: parsed };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(250);
  }
  throw new Error("timed out waiting for " + label + "; last=" + JSON.stringify(last));
}

// ---------------------------------------------------------------- unit: cron helpers (in-process require of the copy)
test("cron helpers: parse/next/runs-per-hour", async () => {
  const script = `
    const m = require(${JSON.stringify(HUB_COPY)});
    const assert = require("node:assert/strict");
    // 2026-11-12 08:00 UTC == 16:00 Shanghai. Next 09:00 Shanghai is next day 01:00 UTC.
    const from = Date.UTC(2026, 10, 12, 8, 0, 0);
    assert.equal(m.nextCronRun("0 9 * * *", from), Date.UTC(2026, 10, 13, 1, 0, 0));
    assert.equal(m.nextCronRun("*/15 * * * *", from), Date.UTC(2026, 10, 12, 8, 15, 0));
    assert.equal(m.runsPerHour({ cron: "*/5 * * * *" }, from), 12);
    assert.equal(m.runsPerHour({ intervalMinutes: 10 }, from), 6);
    assert.throws(() => m.nextCronRun("61 * * * *", from), /bad cron/);
    assert.throws(() => m.nextCronRun("* * *", from), /5 fields/);
    assert.equal(m.formatEnvelopeText({ goal: "g", background: "b", deliverable: "d", constraints: "c" }),
      "目标：g\\n背景：b\\n交付：d\\n约束：c");
    console.log("cron-unit-ok");
    process.exit(0); // required: the module starts a listening server + tick
  `;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, PORT: "8949" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let so = "", se = "";
    p.stdout.on("data", (d) => { so += d; });
    p.stderr.on("data", (d) => { se += d; });
    p.on("close", (code) => resolve({ code, so, se }));
    setTimeout(() => { p.kill(); reject(new Error("cron unit script timed out")); }, 10_000);
  });
  assert.equal(out.code, 0, "cron unit script failed: " + out.so + out.se);
  assert.match(out.so, /cron-unit-ok/);
});

// ---------------------------------------------------------------- schedules CRUD + validation
test("schedules: create/list/validate/patch/delete", async () => {
  const bad = await call("POST", "/api/schedules", null, { agentId: "nope", name: "x", cron: "* * * * *", envelope: { goal: "g" } });
  assert.equal(bad.status, 400);
  const badCron = await call("POST", "/api/schedules", null, { agentId: "muse", name: "x", cron: "61 * * * *", envelope: { goal: "g" } });
  assert.equal(badCron.status, 400);
  const both = await call("POST", "/api/schedules", null, { agentId: "muse", name: "x", cron: "* * * * *", intervalMinutes: 5, envelope: { goal: "g" } });
  assert.equal(both.status, 400);
  const noGoal = await call("POST", "/api/schedules", null, { agentId: "muse", name: "x", cron: "* * * * *", envelope: {} });
  assert.equal(noGoal.status, 400);

  const created = await call("POST", "/api/schedules", null, {
    agentId: "muse", name: "crud-test", cron: "0 9 * * *",
    envelope: { goal: "daily check", background: "b" }, requireApproval: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.schedule.agentId, "muse");
  assert.ok(created.body.schedule.nextRunAt > Date.now());
  const id = created.body.schedule.id;

  const listed = await call("GET", "/api/schedules");
  assert.equal(listed.status, 200);
  assert.ok(listed.body.schedules.some((s) => s.id === id));

  const patched = await call("PATCH", "/api/schedules/" + id, null, { enabled: false });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.schedule.enabled, false);

  const missing = await call("PATCH", "/api/schedules/nope", null, { enabled: false });
  assert.equal(missing.status, 404);

  const deleted = await call("DELETE", "/api/schedules/" + id);
  assert.equal(deleted.status, 200);
  const listed2 = await call("GET", "/api/schedules");
  assert.ok(!listed2.body.schedules.some((s) => s.id === id));
});

// ---------------------------------------------------------------- grok quota guard
test("grok quota guard: 4th hourly grok schedule is refused", async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await call("POST", "/api/schedules", null, {
      agentId: "grok", name: "quota-" + i, intervalMinutes: 1, envelope: { goal: "g" },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body.schedule.id);
  }
  const fourth = await call("POST", "/api/schedules", null, {
    agentId: "grok", name: "quota-3", intervalMinutes: 1, envelope: { goal: "g" },
  });
  assert.equal(fourth.status, 400, JSON.stringify(fourth.body));
  assert.match(fourth.body.error, /quota guard/);
  // A muse schedule at the same cadence is unaffected.
  const museOk = await call("POST", "/api/schedules", null, {
    agentId: "muse", name: "quota-muse", intervalMinutes: 1, envelope: { goal: "g" },
  });
  assert.equal(museOk.status, 201);
  ids.push(museOk.body.schedule.id);
  for (const id of ids) await call("DELETE", "/api/schedules/" + id);
});

// ---------------------------------------------------------------- due firing (no approval)
test("scheduler fires a due muse schedule and the bridge claims it", async () => {
  const created = await call("POST", "/api/schedules", null, {
    agentId: "muse", name: "fire-test", intervalMinutes: 60,
    envelope: { goal: "say hello", deliverable: "one line" },
    nextRunAt: Date.now() + 1500,
  });
  assert.equal(created.status, 201);
  const schedId = created.body.schedule.id;
  const task = await waitFor(async () => {
    const r = await call("GET", "/api/tasks");
    return (r.body.tasks || []).find((t) => t.scheduleId === schedId);
  }, 15_000, "scheduled task to appear");
  assert.equal(task.targetAgent, "muse");
  assert.equal(task.state, "SUBMITTED");
  assert.match(task.text, /目标：say hello/);
  assert.match(task.text, /交付：one line/);

  // Bridge claims it on next poll.
  const poll = await call("POST", "/bridge/poll", museTok, { agentId: "muse" });
  assert.equal(poll.status, 200);
  assert.ok((poll.body.tasks || []).some((t) => t.id === task.id));
  await call("DELETE", "/api/schedules/" + schedId);
});

// ---------------------------------------------------------------- muse approval loop
test("muse approval loop: input-required -> approve -> resume -> complete", async () => {
  const created = await call("POST", "/api/schedules", null, {
    agentId: "muse", name: "approval-test", intervalMinutes: 60,
    envelope: { goal: "needs a yes" }, requireApproval: true,
    nextRunAt: Date.now() + 1500,
  });
  assert.equal(created.status, 201);
  const schedId = created.body.schedule.id;
  const task = await waitFor(async () => {
    const r = await call("GET", "/api/tasks");
    return (r.body.tasks || []).find((t) => t.scheduleId === schedId);
  }, 15_000, "approval-gated task to appear");
  assert.equal(task.state, "INPUT_REQUIRED");
  assert.equal(task.approval.action, "执行定时任务「approval-test」");

  const approvals = await call("GET", "/api/approvals");
  assert.equal(approvals.status, 200);
  assert.ok(approvals.body.approvals.some((a) => a.taskId === task.id));

  // Approving a non-pending task is a 409; double-approve is a 409 too.
  const notPending = await call("POST", "/api/approvals/" + task.id + "/approve");
  assert.equal(notPending.status, 200, JSON.stringify(notPending.body));
  const again = await call("POST", "/api/approvals/" + task.id + "/approve");
  assert.equal(again.status, 409);

  // Resumed task is claimable again via the bridge.
  const resumed = await waitFor(async () => {
    const r = await call("GET", "/api/tasks");
    const t = (r.body.tasks || []).find((x) => x.id === task.id);
    return t && t.state === "SUBMITTED" ? t : null;
  }, 10_000, "task to return to SUBMITTED after approve");
  assert.ok(resumed);
  const poll = await call("POST", "/bridge/poll", museTok, { agentId: "muse" });
  assert.ok((poll.body.tasks || []).some((t) => t.id === task.id));

  // Muse asks for approval mid-task with metadata, then it is rejected.
  const reply = await call("POST", "/bridge/reply", museTok, {
    taskId: task.id, state: "input-required", text: "需要你确认是否发送",
    approval: { action: "发送邮件给客户", reason: "对外发送", consequence: "邮件发出后无法撤回" },
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.task.state, "INPUT_REQUIRED");
  assert.equal(reply.body.task.approval.action, "发送邮件给客户");
  const approvals2 = await call("GET", "/api/approvals");
  assert.ok(approvals2.body.approvals.some((a) => a.taskId === task.id && a.approval.action === "发送邮件给客户"));
  const rejected = await call("POST", "/api/approvals/" + task.id + "/reject");
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.task.state, "CANCELED");
  const approvals3 = await call("GET", "/api/approvals");
  assert.ok(!approvals3.body.approvals.some((a) => a.taskId === task.id));
  await call("DELETE", "/api/schedules/" + schedId);
});

// ---------------------------------------------------------------- grok approval loop (fake webhook)
test("grok loop: webhook dispatch, approval request, approve resumes via webhook", async () => {
  hookCalls.length = 0;
  const created = await call("POST", "/api/schedules", null, {
    agentId: "grok", name: "grok-test", intervalMinutes: 60,
    envelope: { goal: "grok job" }, nextRunAt: Date.now() + 1500,
  });
  assert.equal(created.status, 201);
  const schedId = created.body.schedule.id;
  const task = await waitFor(async () => {
    const r = await call("GET", "/api/tasks");
    const t = (r.body.tasks || []).find((x) => x.scheduleId === schedId);
    return t && t.state === "WORKING" ? t : null; // dispatch is async; wait past SUBMITTED
  }, 15_000, "grok scheduled task to reach WORKING");
  assert.equal(task.state, "WORKING");
  await waitFor(() => hookCalls.find((c) => c.taskId === task.id && !c.kind), 10_000, "webhook dispatch to arrive");
  assert.equal(task.targetAgent, "grok");

  // Grok asks for approval through the Hub (not its own card).
  const ask = await call("POST", "/bridge/grok/reply", grokTok, {
    taskId: task.id, state: "input-required", text: "要不要发布？",
    approval: { action: "发布到公开渠道", reason: "对外发布", consequence: "发布后所有人可见" },
  });
  assert.equal(ask.status, 200);
  assert.equal(ask.body.task.state, "INPUT_REQUIRED");
  const approvals = await call("GET", "/api/approvals");
  assert.ok(approvals.body.approvals.some((a) => a.taskId === task.id));

  // Approve: Hub re-triggers the routine with the decision.
  hookCalls.length = 0;
  const approved = await call("POST", "/api/approvals/" + task.id + "/approve");
  assert.equal(approved.status, 200);
  const resumeCall = await waitFor(
    () => hookCalls.find((c) => c.taskId === task.id && c.kind === "approval-resume"),
    10_000, "approval-resume webhook to arrive");
  assert.equal(resumeCall.approval.decision, "approved");
  assert.equal(resumeCall.approval.originalTaskId, task.id);
  const afterApprove = await call("GET", "/api/tasks");
  const resumedTask = (afterApprove.body.tasks || []).find((t) => t.id === task.id);
  assert.equal(resumedTask.state, "WORKING");

  // Grok completes the resumed task.
  const done = await call("POST", "/bridge/grok/reply", grokTok, { taskId: task.id, text: "已发布" });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.state, "COMPLETED");

  // Reject path: a second grok task, approval requested, rejected -> CANCELED + cancel notice.
  hookCalls.length = 0;
  const created2 = await call("POST", "/api/schedules", null, {
    agentId: "grok", name: "grok-reject", intervalMinutes: 60,
    envelope: { goal: "grok job 2" }, requireApproval: true, nextRunAt: Date.now() + 1500,
  });
  const task2 = await waitFor(async () => {
    const r = await call("GET", "/api/tasks");
    return (r.body.tasks || []).find((t) => t.scheduleId === created2.body.schedule.id);
  }, 15_000, "second grok task to appear");
  assert.equal(task2.state, "INPUT_REQUIRED");
  const rejected = await call("POST", "/api/approvals/" + task2.id + "/reject");
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.task.state, "CANCELED");
  const cancelCall = await waitFor(
    () => hookCalls.find((c) => c.taskId === task2.id && c.kind === "approval-cancel"),
    10_000, "approval-cancel webhook to arrive");
  assert.equal(cancelCall.approval.decision, "rejected");
  await call("DELETE", "/api/schedules/" + schedId);
  await call("DELETE", "/api/schedules/" + created2.body.schedule.id);
});

// ---------------------------------------------------------------- disabled schedule does not fire
test("disabled schedule never fires", async () => {
  const created = await call("POST", "/api/schedules", null, {
    agentId: "muse", name: "disabled-test", intervalMinutes: 60,
    envelope: { goal: "should not run" }, enabled: false, nextRunAt: Date.now() + 1000,
  });
  assert.equal(created.status, 201);
  await sleep(3500);
  const r = await call("GET", "/api/tasks");
  assert.ok(!(r.body.tasks || []).some((t) => t.scheduleId === created.body.schedule.id));
  await call("DELETE", "/api/schedules/" + created.body.schedule.id);
});

test("teardown", async () => {
  child.kill();
  hookServer.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
