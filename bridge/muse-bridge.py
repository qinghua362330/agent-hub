#!/usr/bin/env python3
"""Muse-side bridge daemon for the multi-agent workbench hub.

Inbound half of Muse's two-piece workbench kit (ARCHITECTURE.md §5.1):
- heartbeats to the hub every 20s so the roster shows Muse online;
- polls the hub every 3s for tasks claimed for agents muse+chief and
  drops them as JSON files into bridge/inbox/ for Muse to process;
- forwards reply files Muse writes into bridge/outbox/ back to the
  hub via POST /bridge/reply, then archives them into bridge/done/.

Python 3 stdlib only. The muse token is read at runtime from
the sibling hub/config.json (tokens.muse); it is never
hardcoded, logged, or printed. If the hub is down or the token is not
provisioned yet, the daemon retries silently (state changes are logged
once, not per attempt).
"""

import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INBOX_DIR = os.path.join(BASE_DIR, "inbox")
OUTBOX_DIR = os.path.join(BASE_DIR, "outbox")
DONE_DIR = os.path.join(BASE_DIR, "done")
LOG_PATH = os.path.join(BASE_DIR, "bridge.log")

HUB_URL = os.environ.get("WB_HUB", "http://127.0.0.1:8930").rstrip("/")
CONFIG_PATH = os.environ.get(
    "WB_HUB_CONFIG",
    os.path.join(os.path.dirname(BASE_DIR), "hub", "config.json"),
)
AGENT_ID = "muse"
READY_FILE = os.environ.get("WB_MUSE_READY_FILE")
READY_TIMEOUT_SECONDS = 60

POLL_INTERVAL = 3.0
HEARTBEAT_INTERVAL = 20.0
TICK = 0.5
HTTP_TIMEOUT = 10.0

_running = True


def executor_ready():
    if not READY_FILE:
        return None
    try:
        age = time.time() - os.path.getmtime(READY_FILE)
        return 0 <= age < READY_TIMEOUT_SECONDS
    except OSError:
        return False


def log(msg):
    line = "%s [muse-bridge] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def _stop(signum, frame):
    global _running
    _running = False


# --- token handling -------------------------------------------------------

_token_cache = {"mtime": None, "value": None}


def load_token():
    """Return the muse token from the hub config, or None if unavailable.

    Reloads automatically when the config file changes. Never logs the
    token itself.
    """
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        _token_cache["mtime"] = None
        _token_cache["value"] = None
        return None
    if _token_cache["mtime"] == mtime and _token_cache["value"]:
        return _token_cache["value"]
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
        token = (cfg.get("tokens") or {}).get(AGENT_ID)
    except (OSError, ValueError):
        token = None
    _token_cache["mtime"] = mtime
    _token_cache["value"] = token or None
    return _token_cache["value"]


# --- hub HTTP -------------------------------------------------------------

class HubUnreachable(Exception):
    pass


class HubHTTPError(HubUnreachable):
    def __init__(self, status, body=""):
        super().__init__("HTTP %s" % status)
        self.status = status
        self.body = body


def hub_post(path, payload):
    """POST JSON to the hub with the muse bearer token.

    Returns parsed JSON (or {}). Raises HubUnreachable on any transport
    or HTTP failure so callers can retry silently.
    """
    token = load_token()
    if not token:
        raise HubUnreachable("token not provisioned")
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        HUB_URL + path,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise HubHTTPError(exc.code, body)
    except (urllib.error.URLError, OSError) as exc:
        raise HubUnreachable(str(exc))
    if not body:
        return {}
    try:
        return json.loads(body)
    except ValueError:
        return {}


# --- task intake ----------------------------------------------------------

def _pick(task, *names):
    for name in names:
        if isinstance(task, dict) and task.get(name) not in (None, ""):
            return task[name]
    return None


def write_inbox(task):
    """Normalize one claimed task into bridge/inbox/<taskId>.json."""
    task_id = _pick(task, "taskId", "task_id", "id")
    if not task_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(task_id)):
        log("claimed task with invalid taskId, skipped")
        return
    record = {
        "taskId": str(task_id),
        "targetAgent": _pick(task, "targetAgent", "target", "agentId") or AGENT_ID,
        "conversationId": _pick(task, "conversationId", "conversation_id", "contextId"),
        "claimToken": _pick(task, "claimToken", "claim_token"),
        "leaseExpiresAt": _pick(task, "leaseExpiresAt", "lease_expires_at"),
        "fromAgent": _pick(task, "fromAgent", "from", "sender", "caller"),
        "role": _pick(task, "role"),
        "instructions": _pick(task, "instructions", "roleInstructions", "role_instructions"),
        "parentTaskId": _pick(task, "parentTaskId", "parent_task_id"),
        "messages": task.get("messages") if isinstance(task.get("messages"), list) else [],
        "text": _pick(task, "text", "message", "prompt") or "",
        "ts": _pick(task, "ts", "timestamp", "createdAt") or int(time.time()),
    }
    path = os.path.join(INBOX_DIR, "%s.json" % record["taskId"])
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh: previous = json.load(fh)
            if previous.get("claimToken") == record.get("claimToken"):
                return  # already delivered; poll is at-least-once
        except (OSError, ValueError):
            pass
        # A retry/recovery may reuse taskId with a fresh claim. Replace the
        # local receipt so replies carry the current lease token.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    log("inbox <- task %s (target=%s, conv=%s, from=%s)"
        % (record["taskId"], record["targetAgent"],
           record["conversationId"], record["fromAgent"]))


CLAIM_AGENTS = ["muse", "chief"]  # muse wears the chief hat in v1


def poll_once():
    total = 0
    for agent_id in CLAIM_AGENTS:
        resp = hub_post("/bridge/poll", {"agentId": agent_id})
        tasks = []
        if isinstance(resp, dict):
            tasks = resp.get("tasks") or resp.get("claimed") or []
        elif isinstance(resp, list):
            tasks = resp
        for task in tasks:
            if isinstance(task, dict):
                write_inbox(task)
        total += len(tasks)
    return total


def renew_inbox():
    """Keep claimed work leased while Muse is processing it."""
    try:
        names = os.listdir(INBOX_DIR)
    except OSError:
        return
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(INBOX_DIR, name), encoding="utf-8") as fh:
                task = json.load(fh)
            token = task.get("claimToken")
            if token:
                hub_post("/bridge/renew", {"taskId": task.get("taskId"), "claimToken": token})
        except HubHTTPError as exc:
            if exc.status in (404, 409):
                # A stale/canceled claim must not pin the inbox forever.
                try: os.replace(os.path.join(INBOX_DIR, name), os.path.join(DONE_DIR, name))
                except OSError: pass
                continue
            return
        except (OSError, ValueError, HubUnreachable):
            return


# --- reply outbox ---------------------------------------------------------

def flush_outbox():
    try:
        names = sorted(os.listdir(OUTBOX_DIR))
    except OSError:
        return
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(OUTBOX_DIR, name)
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError) as exc:
            log("outbox file %s unreadable (%s), left in place" % (name, exc))
            continue
        task_id = payload.get("taskId") or name[:-len(".json")]
        body = {
            "taskId": task_id,
            "state": payload.get("state") or "completed",
            "text": payload.get("text") or "",
        }
        if payload.get("claimToken"):
            body["claimToken"] = payload["claimToken"]
        if isinstance(payload.get("approval"), dict):
            body["approval"] = payload["approval"]
        try:
            hub_post("/bridge/reply", body)
        except HubHTTPError as exc:
            if exc.status in (404, 409):
                # stale/canceled claims are terminal for this local outbox item;
                # archive them so one expired task cannot block all later replies.
                log("reply for %s became stale (HTTP %s), archived" % (task_id, exc.status))
            else:
                return
        except HubUnreachable:
            return  # hub down; remaining files retried next tick
        dest = os.path.join(DONE_DIR, name)
        try:
            os.replace(path, dest)
        except OSError as exc:
            log("reply for %s sent but archive failed: %s" % (task_id, exc))
            continue
        # housekeeping: the inbox copy of a replied task is done too
        try:
            os.remove(os.path.join(INBOX_DIR, name))
        except OSError:
            pass
        log("reply -> task %s (state=%s)" % (task_id, body["state"]))


# --- main loop ------------------------------------------------------------

def main():
    for d in (INBOX_DIR, OUTBOX_DIR, DONE_DIR):
        os.makedirs(d, exist_ok=True)
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    log("started (hub=%s, config=%s)" % (HUB_URL, CONFIG_PATH))

    hub_up = None  # None=unknown, True/False last known state
    next_poll = 0.0
    next_beat = 0.0

    def note_state(up, what):
        nonlocal hub_up
        if hub_up != up:
            hub_up = up
            log("hub %s (%s)" % ("reachable" if up else "unreachable", what))

    while _running:
        now = time.monotonic()
        if now >= next_beat:
            next_beat = now + HEARTBEAT_INTERVAL
            try:
                ready = executor_ready()
                payload = {"agentId": AGENT_ID}
                if ready is not None:
                    payload["ready"] = ready
                    if not ready:
                        payload["reason"] = "Muse 执行器未接入或就绪心跳已过期"
                hub_post("/bridge/heartbeat", payload)
                note_state(True, "heartbeat")
            except HubUnreachable as exc:
                note_state(False, str(exc))
        if now >= next_poll:
            next_poll = now + POLL_INTERVAL
            try:
                if executor_ready() is not False:
                    poll_once()
                    renew_inbox()
                note_state(True, "poll")
            except HubUnreachable as exc:
                note_state(False, str(exc))
        try:
            flush_outbox()
        except Exception as exc:  # keep daemon alive on unexpected errors
            log("outbox flush error: %s" % (exc,))
        time.sleep(TICK)

    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
