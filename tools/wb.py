#!/usr/bin/env python3
"""wb — Muse's command-line handle on the workbench calling surface.

Wraps the hub façade's MCP endpoint (POST /mcp, JSON-RPC tools/call)
with the unified tool set from ARCHITECTURE.md §3, plus the local
bridge inbox/outbox workflow from §5. Python 3 stdlib only.

Usage:
  wb members                        list_members: roster, status, skills
  wb send <agentId> <text...>       send_to_bot: message one bot
      [--conversation <id>] [--new]
  wb channel <channelId> <text...>  send_to_channel: message a channel
  wb wait <conversationId>          wait_for_conversation (long-poll)
  wb read <conversationId>          read_conversation (transcript)
      [--before <timestamp> | --before-id <id>] [--limit <n>]
  wb resume <conversationId>        resume a user-paused discussion
  wb reset <conversationId>         reset turn count and resume
  wb retry <taskId>                 explicitly retry a failed task
  wb inbox                          list pending bridge/inbox tasks (JSON)
  wb reply <taskId> <text...>       queue a reply via bridge/outbox
      [--state <state>]             reply state, default "completed"
                                    (e.g. "input-required" for NEED_USER)
      [--approval <json>]           approval metadata for input-required,
                                    e.g. '{"action":"...","reason":"..."}'
  wb tasks                          GET /api/tasks if the hub offers it

Config: hub base URL from env WB_HUB (default http://127.0.0.1:8930).
The muse token is read at runtime from
the sibling hub/config.json (tokens.muse); it is never
printed. Output is compact JSON on stdout.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.join(os.path.dirname(BASE_DIR), "bridge")
INBOX_DIR = os.path.join(BRIDGE_DIR, "inbox")
OUTBOX_DIR = os.path.join(BRIDGE_DIR, "outbox")

HUB_URL = os.environ.get("WB_HUB", "http://127.0.0.1:8930").rstrip("/")
CONFIG_PATH = os.environ.get(
    "WB_HUB_CONFIG",
    os.path.join(os.path.dirname(BASE_DIR), "hub", "config.json"),
)
AGENT_ID = "muse"


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
    return code


def fail(msg, code=1, **extra):
    out = {"ok": False, "error": msg}
    out.update(extra)
    return emit(out, code)


def load_token():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            cfg = json.load(fh)
        return (cfg.get("tokens") or {}).get(AGENT_ID)
    except (OSError, ValueError):
        return None


def inbox_claim(task_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
        raise OSError("task id must be a local task id")
    try:
        with open(os.path.join(INBOX_DIR, task_id + ".json"), encoding="utf-8") as fh:
            claim = json.load(fh).get("claimToken")
    except (OSError, ValueError, AttributeError):
        claim = None
    if not claim:
        raise OSError("task has no active inbox claim")
    return str(claim)


def http_json(method, path, payload=None, timeout=30.0):
    """One HTTP call to the hub with the muse bearer token.

    Returns (status, parsed_json_or_text). Raises OSError on transport
    failure.
    """
    token = load_token()
    if not token:
        raise OSError("muse token not provisioned in hub config")
    headers = {"Authorization": "Bearer " + token}
    # Chief work is authorized by the active inbox claim, never by pretending
    # the Muse token is a Chief credential.
    task_id = os.environ.get("WB_TASK_ID")
    if task_id:
        headers["X-Agent-Hub-Task"] = task_id
        headers["X-Agent-Hub-Claim"] = inbox_claim(task_id)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        HUB_URL + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        status = exc.code
    if not body:
        return status, {}
    try:
        return status, json.loads(body)
    except ValueError:
        return status, body


def mcp_call(tool, arguments, timeout=30.0):
    """Call one façade MCP tool; returns (status, unwrapped_result)."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    status, resp = http_json("POST", "/mcp", payload, timeout=timeout)
    if isinstance(resp, dict) and "result" in resp:
        result = resp["result"]
        if isinstance(result, dict):
            if result.get("structuredContent") is not None:
                return status, result["structuredContent"]
            content = result.get("content") or []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    text = item.get("text", "")
                    try:
                        return status, json.loads(text)
                    except ValueError:
                        return status, text
        return status, result
    return status, resp


def run_mcp(tool, arguments, timeout=30.0):
    try:
        status, result = mcp_call(tool, arguments, timeout=timeout)
    except OSError as exc:
        return fail("hub unreachable: %s" % (exc,))
    if status >= 400:
        return fail("hub returned HTTP %s" % status, result=result)
    if isinstance(result, dict) and result.get("error"):
        return fail(str(result["error"]), result=result)
    return emit(result if isinstance(result, (dict, list)) else {"result": result})


# --- commands -------------------------------------------------------------

def cmd_members(argv):
    return run_mcp("list_members", {})


def cmd_send(argv):
    if len(argv) < 2:
        return fail("usage: wb send <agentId> <text...>")
    args = list(argv)
    conversation = None
    new = False
    if "--conversation" in args:
        i = args.index("--conversation")
        if i + 1 >= len(args): return fail("--conversation needs an id")
        conversation = args[i + 1]; del args[i:i + 2]
    if "--new" in args:
        args.remove("--new"); new = True
    if len(args) < 2: return fail("usage: wb send <agentId> [--conversation <id>] [--new] <text...>")
    payload = {"agentId": args[0], "text": " ".join(args[1:])}
    if conversation: payload["conversationId"] = conversation
    if new: payload["newConversation"] = True
    return run_mcp("send_to_bot", payload)


def cmd_channel(argv):
    if len(argv) < 2:
        return fail("usage: wb channel <channelId> <text...>")
    return run_mcp("send_to_channel",
                   {"channelId": argv[0], "text": " ".join(argv[1:])})


def cmd_wait(argv):
    if len(argv) < 1:
        return fail("usage: wb wait <conversationId>")
    # wait_for is a long-poll on the hub side; give it a generous timeout.
    return run_mcp("wait_for_conversation",
                   {"conversationId": argv[0]}, timeout=300.0)


def cmd_read(argv):
    if len(argv) < 1:
        return fail("usage: wb read <conversationId>")
    args = list(argv); payload = {"conversationId": args.pop(0)}
    before_flag = "--before-id" if "--before-id" in args else "--before"
    if before_flag in args:
        i = args.index(before_flag)
        if i + 1 >= len(args): return fail("%s needs a message id" % before_flag)
        value = args[i + 1]
        if before_flag == "--before" and not value.isdigit(): return fail("--before needs a numeric timestamp")
        payload["beforeId" if before_flag == "--before-id" else "beforeTs"] = value if before_flag == "--before-id" else int(value)
    if "--limit" in args:
        i = args.index("--limit")
        if i + 1 >= len(args): return fail("--limit needs a number")
        try: payload["limit"] = int(args[i + 1])
        except ValueError: return fail("--limit needs a numeric value")
    return run_mcp("read_conversation", payload)


def cmd_control(argv, tool):
    if len(argv) != 1: return fail("usage: wb %s <conversationId>" % tool.removesuffix("_conversation"))
    return run_mcp(tool, {"conversationId": argv[0]})


def cmd_retry(argv):
    if len(argv) != 1: return fail("usage: wb retry <taskId>")
    try:
        status, resp = http_json("POST", "/api/tasks/%s/retry" % urllib.parse.quote(argv[0], safe=""), {})
    except OSError as exc: return fail("hub unreachable: %s" % exc)
    return emit(resp if isinstance(resp, (dict, list)) else {"result": resp}, 0 if status < 400 else 1)


def cmd_inbox(argv):
    tasks = []
    try:
        names = sorted(os.listdir(INBOX_DIR))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(INBOX_DIR, name), encoding="utf-8") as fh:
                tasks.append(json.load(fh))
        except (OSError, ValueError) as exc:
            tasks.append({"file": name, "error": "unreadable: %s" % (exc,)})
    return emit(tasks)


def cmd_reply(argv):
    state = "completed"
    approval = None
    args = list(argv)
    while args and args[0] in ("--state", "--approval"):
        if len(args) < 2:
            return fail("usage: wb reply [--state <state>] [--approval <json>] <taskId> <text...>")
        if args[0] == "--state":
            state = args[1]
        else:
            try:
                approval = json.loads(args[1])
            except ValueError:
                return fail("--approval must be JSON, e.g. '{\"action\":\"...\",\"reason\":\"...\"}'")
            if not isinstance(approval, dict) or not approval.get("action"):
                return fail("--approval JSON needs an 'action' field")
        args = args[2:]
    if len(args) < 2:
        return fail("usage: wb reply [--state <state>] [--approval <json>] <taskId> <text...>")
    task_id, text = args[0], " ".join(args[1:])
    try:
        claim = inbox_claim(task_id)
    except OSError as exc:
        return fail(str(exc))
    os.makedirs(OUTBOX_DIR, exist_ok=True)
    record = {"taskId": task_id, "claimToken": claim, "state": state, "text": text}
    if approval is not None:
        record["approval"] = approval
    path = os.path.join(OUTBOX_DIR, "%s.json" % task_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return emit({"ok": True, "taskId": task_id, "state": state,
                 "queued": "bridge/outbox/%s.json" % task_id})


def cmd_tasks(argv):
    try:
        status, resp = http_json("GET", "/api/tasks", timeout=15.0)
    except OSError as exc:
        return emit({"status": "unavailable",
                     "detail": "hub unreachable: %s" % (exc,)})
    if status == 404:
        return emit({"status": "unavailable",
                     "detail": "hub does not offer GET /api/tasks"})
    if status >= 400:
        return emit({"status": "unavailable",
                     "detail": "hub returned HTTP %s" % status})
    return emit(resp if isinstance(resp, (dict, list)) else {"result": resp})


COMMANDS = {
    "members": cmd_members,
    "send": cmd_send,
    "channel": cmd_channel,
    "wait": cmd_wait,
    "read": cmd_read,
    "resume": lambda argv: cmd_control(argv, "resume_conversation"),
    "reset": lambda argv: cmd_control(argv, "reset_conversation"),
    "retry": cmd_retry,
    "inbox": cmd_inbox,
    "reply": cmd_reply,
    "tasks": cmd_tasks,
}

USAGE = __doc__.strip().splitlines()[0] + "\nRun `wb` with no args for usage."


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    handler = COMMANDS.get(argv[0])
    if handler is None:
        return fail("unknown command: %s (try: %s)"
                    % (argv[0], ", ".join(sorted(COMMANDS))))
    return handler(argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
