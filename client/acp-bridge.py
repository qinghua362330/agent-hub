#!/usr/bin/env python3
"""ACP stdio bridge: OpenMausBot customAcp instance -> Agent Hub /mcp.

One program, one personality per Hub agent via WB_BRIDGE_TARGET (default muse).
OpenMausBot spawns it as `config.cli` and speaks ACP (newline-delimited
JSON-RPC 2.0) on stdio; this bridge translates each session/prompt into a
Hub send_to_bot + wait_for_conversation round-trip.

Wire contract (verified against the OpenMausBot source in
~/workspace/agent-hub/openmausbot-eval):
- server/drivers/acp/core.ts: client sends initialize {protocolVersion: 1,
  clientInfo, clientCapabilities}, then session/new {cwd, mcpServers, ...},
  then session/prompt {sessionId, prompt: [{type: "text", text}]}. The
  session/prompt result is {stopReason}; "end_turn" settles ok, "cancelled"
  settles as cancelled, anything else is an error. A turn that emits no text
  is marked "empty_turn", so at least one agent_message_chunk is mandatory.
  The driver kills a prompt that stays silent for 15 min (promptIdleTimeoutMs
  default), so keep-alive thought chunks are emitted while waiting.
- server/drivers/acp/custom-model-catalog.ts: discovery reads the models a
  session/new result advertises, then confirms each one with a
  session/set_model round-trip checking currentValue.
- Models are fixed per Hub agent: Muse runs whatever its sandbox runs,
  Grok's model is set inside the Grok account, Chief is Muse's. initialize
  answers _meta.modelState {currentModelId, availableModels}; session/new
  answers {sessionId, models: {availableModels, currentModelId}}.
  session/set_model {modelId} and session/set_config_option {configId:
  "model", value} accept only an advertised id, persist it to
  ~/.agent-hub/model-<target>.json (0600), and answer models.currentModelId
  (set_config_option also answers the configOptions currentValue); an
  unknown id is a JSON-RPC error, so the driver reports the failed switch
  instead of recording it.
- server/testing/fake-acp-cli.ts: initialize answers {protocolVersion: 1,
  authMethods, agentInfo, agentCapabilities, _meta}; session/update
  notifications carry {sessionId, update: {sessionUpdate:
  "agent_message_chunk"|"agent_thought_chunk", content: {type: "text",
  text}}}; session/cancel arrives as a notification (no id).
- customAcp never sends authenticate (pickAuthMethod returns null), but it is
  answered anyway.

Stdout is the ACP wire: never print anything else there. All diagnostics go
to stderr (and best-effort to ~/.agent-hub/bridge.log). The Hub token is
never printed or logged.
"""

import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = "1.3.1"
AGENT_NAME = "agent-hub-bridge"

TARGET = os.environ.get("WB_BRIDGE_TARGET", "muse").strip() or "muse"
HUB_URL = (os.environ.get("WB_HUB_URL") or "http://127.0.0.1:8930").rstrip("/")
# Wait budget per prompt: ~6 min of 55 s Hub long-polls.
MAX_WAIT_SECONDS = 360
KEEPALIVE_SECONDS = 25

HOME = os.path.expanduser("~")
ENV_FILE = os.path.join(HOME, ".agent-hub", "env")
LOG_FILE = os.path.join(HOME, ".agent-hub", "bridge.log")
SESSION_DIR = os.path.join(HOME, ".agent-hub", "sessions", TARGET)


def log(msg):
    line = "%s [acp-bridge:%s] %s" % (time.strftime("%F %T"), TARGET, msg)
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def load_token():
    token = os.environ.get("WB_MAC_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == "WB_MAC_TOKEN":
                    value = value.strip().strip('"').strip("'")
                    if value and value != "PASTE_HERE":
                        return value
    except OSError:
        pass
    return ""


TOKEN = load_token()
if not re.fullmatch(r"[A-Za-z0-9_-]+", TARGET):
    sys.stderr.write("WB_BRIDGE_TARGET must be a Hub agent id, got %r\n" % TARGET)
    sys.exit(2)
if not TOKEN and "--selftest" not in sys.argv:
    sys.stderr.write(
        "WB_MAC_TOKEN is not set and %s has no usable token.\n"
        "Import your maintainer's connection information in OpenMausBot, "
        "or set WB_HUB_URL, WB_BRIDGE_TARGET and WB_MAC_TOKEN.\n" % ENV_FILE
    )
    sys.exit(2)


MODEL_FILE = os.path.join(HOME, ".agent-hub", "model-%s.json" % TARGET)

# A remote agent has no switchable model: Muse runs whatever its sandbox
# runs, Grok's model is set inside the Grok account, Chief is Muse's.
FIXED_MODELS = {
    "muse": ("muse", "Muse"),
    "grok": ("grok", "Grok"),
    "chief": ("muse", "Muse"),
}


def fixed_model():
    return FIXED_MODELS.get(TARGET.lower(), (TARGET, TARGET))


def load_requested_model():
    """The model a set_model/set_config_option call recorded, if it is still advertised."""
    try:
        with open(MODEL_FILE, encoding="utf-8") as fh:
            saved = json.load(fh)
    except (OSError, ValueError):
        return None
    model_id = saved.get("modelId") if isinstance(saved, dict) else None
    return model_id if model_id == fixed_model()[0] else None


def save_requested_model(model_id):
    """Persist the recorded model (0600). A failure only loses the restart memory, never the turn."""
    try:
        os.makedirs(os.path.dirname(MODEL_FILE), exist_ok=True)
        tmp = MODEL_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"modelId": model_id}))
        os.replace(tmp, MODEL_FILE)
    except OSError as exc:
        log("could not persist model: %s" % exc)


def current_models():
    model_id, name = fixed_model()
    requested = load_requested_model()
    return {
        "availableModels": [{"modelId": model_id, "name": name}],
        "currentModelId": requested or model_id,
    }


def model_config_option(models):
    return [{
        "id": "model",
        "type": "select",
        "currentValue": models["currentModelId"],
        "options": [{"value": entry["modelId"], "name": entry["name"]}
                    for entry in models["availableModels"]],
    }]


class HubError(Exception):
    pass


# urllib honours http_proxy/https_proxy from the environment by default; the
# Hub (public VPS address or sandbox localhost) must be reached directly, so
# never route these calls through any proxy.
_HUB_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def hub_mcp(method, params, timeout=65):
    """One Hub /mcp JSON-RPC call. Returns the result dict, or raises HubError."""
    body = json.dumps(
        {"jsonrpc": "2.0", "id": secrets.token_hex(4), "method": method, "params": params}
    ).encode("utf-8")
    req = urllib.request.Request(
        HUB_URL + "/mcp",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + TOKEN,
        },
        method="POST",
    )
    try:
        with _HUB_OPENER.open(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise HubError("Hub HTTP %s" % exc.code)
    except Exception as exc:
        raise HubError("Hub unreachable: %s" % exc)
    if payload.get("error"):
        raise HubError("Hub error: %s" % payload["error"].get("message", payload["error"]))
    return payload.get("result") or {}


def mcp_tool(name, arguments):
    result = hub_mcp("tools/call", {"name": name, "arguments": arguments})
    if isinstance(result, dict) and "structuredContent" in result:
        return result["structuredContent"]
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        for part in result["content"]:
            if isinstance(part, dict) and part.get("type") == "text":
                try:
                    return json.loads(part["text"])
                except ValueError:
                    return {"text": part["text"]}
    return result


class Bridge:
    def __init__(self):
        self.out_lock = threading.Lock()
        self.sessions = {}  # sessionId -> {"n": int, "cancel": Event, "busy": bool}
        self.sessions_lock = threading.Lock()
        self.shutdown = threading.Event()

    # -- wire -------------------------------------------------------------
    def send(self, obj):
        line = json.dumps(obj, ensure_ascii=False)
        with self.out_lock:
            try:
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            except BrokenPipeError:
                self.shutdown.set()

    def send_result(self, req_id, result):
        self.send({"jsonrpc": "2.0", "id": req_id, "result": result})

    def send_error(self, req_id, code, message):
        self.send({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}})

    def send_update(self, session_id, session_update, text):
        self.send({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": session_update,
                    "content": {"type": "text", "text": text},
                },
            },
        })

    # -- sessions -----------------------------------------------------------
    def new_session(self):
        session_id = "wb-" + secrets.token_hex(8)
        with self.sessions_lock:
            self.sessions[session_id] = self.load_session(session_id)
        return session_id

    def get_session(self, session_id):
        with self.sessions_lock:
            return self.sessions.get(session_id)

    def ensure_session(self, session_id):
        with self.sessions_lock:
            if session_id not in self.sessions:
                self.sessions[session_id] = self.load_session(session_id)
            return self.sessions[session_id]

    def session_path(self, session_id):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
            raise ValueError("invalid sessionId")
        return os.path.join(SESSION_DIR, session_id + ".json")

    def load_session(self, session_id):
        record = {}
        try:
            with open(self.session_path(session_id), encoding="utf-8") as fh:
                value = json.load(fh)
                if isinstance(value, dict):
                    record = value
        except (OSError, ValueError):
            pass
        n = record.get("n", 0)
        conversation_id = record.get("conversationId")
        return {
            "id": session_id, "n": n if isinstance(n, int) and n >= 0 else 0,
            "conversationId": conversation_id if isinstance(conversation_id, str) else None,
            "cancel": threading.Event(), "busy": False,
        }

    def save_session(self, session):
        path = self.session_path(session["id"])
        os.makedirs(SESSION_DIR, mode=0o700, exist_ok=True)
        tmp = path + ".tmp-" + secrets.token_hex(4)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"n": session["n"], "conversationId": session.get("conversationId")}, fh)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def cancel_task(self, session):
        with self.sessions_lock:
            task_id = session.get("taskId")
            if not task_id or session.get("interruptSent"):
                return
            session["interruptSent"] = True
        try:
            mcp_tool("interrupt", {"taskId": task_id})
        except HubError:
            log("task cancellation could not reach the Hub")

    def record_model(self, req_id, wanted):
        """Validate a requested model against the advertised list and persist it. Answers errors; True when accepted."""
        advertised = {entry["modelId"] for entry in current_models()["availableModels"]}
        if not isinstance(wanted, str) or wanted not in advertised:
            self.send_error(req_id, -32602, "unknown model for this agent")
            return False
        save_requested_model(wanted)
        return True

    # -- Hub round-trip -----------------------------------------------------
    def wait_for_reply(self, session, conversation_id, req_id):
        """Long-poll the Hub until the teammate answers. Returns reply text
        (possibly a graceful timeout note). Emits keep-alive thought chunks."""
        target_name = "Muse" if TARGET == "muse" else "Grok Bot" if TARGET == "grok" else TARGET
        deadline = time.time() + MAX_WAIT_SECONDS
        last_keepalive = 0.0
        errors = 0
        while time.time() < deadline:
            if session["cancel"].is_set():
                return None  # cancelled
            now = time.time()
            if now - last_keepalive >= KEEPALIVE_SECONDS:
                last_keepalive = now
                self.send_update(
                    session["id"], "agent_thought_chunk",
                    "正在等%s回复…" % target_name,
                )
            try:
                waited = mcp_tool("wait_for_conversation", {
                    "conversationId": conversation_id,
                    "timeoutMs": 55000,
                })
                errors = 0
            except HubError as exc:
                errors += 1
                log("wait error (%d): %s" % (errors, exc))
                if errors >= 2:
                    return "工作台暂时连不上（%s），请稍后再试。" % exc
                time.sleep(2)
                continue
            status = (waited or {}).get("status")
            if status in ("settled", "needs-user", "failed"):
                return self.extract_reply(waited, status, session.get("taskId"))
            # status "working": loop until the deadline
        return "%s还在处理（已等约 6 分钟），回复会出现在工作台的对话里，稍后查看即可。" % target_name

    def extract_reply(self, waited, status, task_id=None):
        tasks = waited.get("tasks") or []
        for task in reversed(tasks):
            if (isinstance(task, dict) and task.get("targetAgent") == TARGET
                    and (not task_id or task.get("id") == task_id)):
                result = task.get("result")
                if isinstance(result, str) and result.strip():
                    return result
        for msg in reversed(waited.get("recentMessages") or []):
            if (isinstance(msg, dict) and msg.get("from") == TARGET
                    and (not task_id or msg.get("taskId") == task_id)):
                text = msg.get("text")
                if isinstance(text, str) and text.strip():
                    return text
        if status == "failed":
            return "对方处理失败了，请在工作台里查看任务详情或再试一次。"
        return "对方已回复，但我没能从工作台取到回复文本，请直接在工作台查看。"

    def do_prompt(self, session, req_id, text):
        session["n"] += 1
        session["taskId"] = None
        session["interruptSent"] = False
        self.save_session(session)
        request_key = "acp-%s-%s-%d" % (TARGET, session["id"], session["n"])
        try:
            arguments = {
                "agentId": TARGET,
                "text": text,
                "requestKey": request_key,
            }
            if session.get("conversationId"):
                arguments["conversationId"] = session["conversationId"]
            else:
                arguments["newConversation"] = True
            sent = mcp_tool("send_to_bot", arguments)
        except HubError as exc:
            self.send_update(session["id"], "agent_message_chunk",
                             "工作台暂时连不上（%s），请稍后再试。" % exc)
            self.send_result(req_id, {"stopReason": "end_turn"})
            return
        conversation_id = (sent or {}).get("conversationId") or ((sent or {}).get("task") or {}).get("contextId")
        if not conversation_id:
            self.send_update(session["id"], "agent_message_chunk",
                             "派活失败：工作台没有返回会话，请稍后再试。")
            self.send_result(req_id, {"stopReason": "end_turn"})
            return
        session["conversationId"] = conversation_id
        session["taskId"] = ((sent or {}).get("task") or {}).get("id")
        self.save_session(session)
        if session["cancel"].is_set():
            self.cancel_task(session)
            self.send_result(req_id, {"stopReason": "cancelled"})
            return
        reply = self.wait_for_reply(session, conversation_id, req_id)
        if reply is None:  # cancelled
            self.send_result(req_id, {"stopReason": "cancelled"})
            return
        for i in range(0, len(reply), 1500):
            self.send_update(session["id"], "agent_message_chunk", reply[i:i + 1500])
        self.send_result(req_id, {"stopReason": "end_turn"})

    # -- dispatch -----------------------------------------------------------
    def handle_request(self, msg):
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            models = current_models()
            self.send_result(req_id, {
                "protocolVersion": 1,
                "authMethods": [],
                "agentInfo": {"name": AGENT_NAME, "version": VERSION},
                "agentCapabilities": {"promptCapabilities": {}},
                "_meta": {"modelState": {"currentModelId": models["currentModelId"],
                                         "availableModels": models["availableModels"]}},
            })
            return
        if method == "authenticate":
            self.send_result(req_id, {})
            return
        if method == "session/new":
            session_id = self.new_session()
            self.send_result(req_id, {"sessionId": session_id, "models": current_models()})
            return
        if method in ("session/load", "session/resume"):
            session_id = params.get("sessionId")
            if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id):
                self.send_error(req_id, -32602, "invalid sessionId")
                return
            self.ensure_session(session_id)
            self.send_result(req_id, {})
            return
        if method == "session/set_model":
            if self.record_model(req_id, params.get("modelId")):
                self.send_result(req_id, {"models": current_models()})
            return
        if method == "session/set_config_option":
            if params.get("configId") == "model":
                if self.record_model(req_id, params.get("value")):
                    models = current_models()
                    self.send_result(req_id, {"models": models, "configOptions": model_config_option(models)})
                return
            self.send_result(req_id, {})
            return
        if method == "session/set_mode":
            self.send_result(req_id, {})
            return
        if method in ("session/close", "session/delete"):
            session_id = params.get("sessionId")
            if isinstance(session_id, str):
                with self.sessions_lock:
                    self.sessions.pop(session_id, None)
                if method == "session/delete":
                    try:
                        os.unlink(self.session_path(session_id))
                    except (OSError, ValueError):
                        pass
            self.send_result(req_id, {})
            return
        if method == "session/prompt":
            session_id = params.get("sessionId")
            session = self.get_session(session_id) if isinstance(session_id, str) else None
            if session is None:
                self.send_error(req_id, -32602, "unknown sessionId")
                return
            blocks = params.get("prompt") or []
            text = "".join(
                b.get("text", "") for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
            if session["busy"]:
                self.send_error(req_id, -32000, "a prompt is already running in this session")
                return
            session["busy"] = True
            session["cancel"].clear()
            session["id"] = session_id

            def run():
                try:
                    self.do_prompt(session, req_id, text)
                except Exception as exc:  # never kill the process on a prompt
                    log("prompt failed: %r" % (exc,))
                    try:
                        self.send_update(session_id, "agent_message_chunk",
                                         "处理这条消息时出了点问题，请在工作台里查看或再试一次。")
                        self.send_result(req_id, {"stopReason": "end_turn"})
                    except Exception:
                        pass
                finally:
                    session["busy"] = False

            threading.Thread(target=run, daemon=True).start()
            return
        self.send_error(req_id, -32601, "method not found: %s" % method)

    def handle_notification(self, msg):
        if msg.get("method") == "session/cancel":
            session_id = (msg.get("params") or {}).get("sessionId")
            session = self.get_session(session_id) if isinstance(session_id, str) else None
            if session is not None:
                session["cancel"].set()
                if session["busy"]:
                    threading.Thread(target=self.cancel_task, args=(session,), daemon=True).start()

    def run(self):
        log("bridge started (target=%s hub=%s)" % (TARGET, HUB_URL))
        while not self.shutdown.is_set():
            line = sys.stdin.readline()
            if line == "":
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                log("ignoring malformed line")
                continue
            if not isinstance(msg, dict) or "method" not in msg:
                continue
            try:
                if "id" in msg:
                    self.handle_request(msg)
                else:
                    self.handle_notification(msg)
            except Exception as exc:
                log("dispatch failed: %r" % (exc,))
                if "id" in msg:
                    try:
                        self.send_error(msg["id"], -32603, "internal error")
                    except Exception:
                        pass
        log("bridge exiting (stdin closed)")


def selftest():
    """Drive this bridge over stdio against tests/stub-hub.py and assert the
    full initialize -> session/new -> session/prompt round-trip, plus the
    model surface: advertise, record a switch, confirm it, reject an unknown
    id, and keep the recorded model across a restart."""
    import shutil
    import socket
    import subprocess
    import tempfile

    here = os.path.dirname(os.path.abspath(__file__))
    stub = os.path.join(here, "tests", "stub-hub.py")
    if not os.path.isfile(stub):
        print("SELFTEST FAIL: run this check from a source checkout containing tests/stub-hub.py")
        return 1
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        stub_port = probe.getsockname()[1]
    home = tempfile.mkdtemp(prefix="wb-selftest-")
    env = dict(os.environ)
    env["HOME"] = home  # the recorded model file lands in scratch, never the real home
    env["WB_HUB_URL"] = "http://127.0.0.1:%d" % stub_port
    env["WB_MAC_TOKEN"] = "selftest-token"
    env["WB_BRIDGE_TARGET"] = "muse"
    stub_proc = subprocess.Popen(
        [sys.executable, stub, str(stub_port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    proc = None
    try:
        available = False
        for _ in range(50):
            assert stub_proc.poll() is None, "isolated stub Hub exited before becoming healthy"
            try:
                import urllib.request
                urllib.request.urlopen("http://127.0.0.1:%d/health" % stub_port, timeout=1)
                available = True
                break
            except Exception:
                time.sleep(0.1)
        assert available and stub_proc.poll() is None, "isolated stub Hub did not become healthy"
        proc = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__)],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )

        def send(obj):
            proc.stdin.write(json.dumps(obj) + "\n")
            proc.stdin.flush()

        # Reader thread + queue: select() on a buffered text stream is
        # wrong, the buffer may already hold lines while the fd looks empty.
        import queue
        inbox = queue.Queue()

        def reader():
            try:
                for line in proc.stdout:
                    if not line.strip():
                        continue
                    try:
                        inbox.put(json.loads(line))
                    except ValueError:
                        pass
            finally:
                inbox.put(None)

        threading.Thread(target=reader, daemon=True).start()

        def read_msg(timeout=20):
            try:
                msg = inbox.get(timeout=timeout)
            except queue.Empty:
                raise AssertionError("timed out waiting for bridge output")
            if msg is None:
                raise AssertionError("bridge closed stdout")
            return msg

        def wait_result(want_id, timeout=30):
            chunks = []
            deadline = time.time() + timeout
            while time.time() < deadline:
                msg = read_msg(timeout=max(1, deadline - time.time()))
                if msg.get("method") == "session/update":
                    update = (msg.get("params") or {}).get("update") or {}
                    content = update.get("content") or {}
                    if update.get("sessionUpdate") == "agent_message_chunk":
                        chunks.append(content.get("text", ""))
                    continue
                if msg.get("id") == want_id:
                    return msg, "".join(chunks)
            raise AssertionError("no result for id %r" % want_id)

        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": 1,
                         "clientInfo": {"name": "selftest", "version": "1"},
                         "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False},
                                                "terminal": False}}})
        msg, _ = wait_result(1)
        assert msg.get("result", {}).get("protocolVersion") == 1, "initialize: %r" % msg
        print("PASS initialize protocolVersion=1")
        state = ((msg.get("result") or {}).get("_meta") or {}).get("modelState") or {}
        assert state.get("currentModelId") == "muse", "initialize modelState: %r" % msg
        assert state.get("availableModels") == [{"modelId": "muse", "name": "Muse"}], "initialize modelState: %r" % msg
        print("PASS initialize modelState currentModelId=muse")
        send({"jsonrpc": "2.0", "id": 2, "method": "session/new",
              "params": {"cwd": "/tmp", "mcpServers": []}})
        msg, _ = wait_result(2)
        session_id = (msg.get("result") or {}).get("sessionId")
        assert isinstance(session_id, str) and session_id, "session/new: %r" % msg
        models = (msg.get("result") or {}).get("models") or {}
        assert models.get("currentModelId") == "muse", "session/new models: %r" % msg
        assert models.get("availableModels") == [{"modelId": "muse", "name": "Muse"}], "session/new models: %r" % msg
        print("PASS session/new sessionId=%s models=muse" % session_id)
        send({"jsonrpc": "2.0", "id": 3, "method": "session/prompt",
              "params": {"sessionId": session_id,
                         "prompt": [{"type": "text", "text": "你好，请回复一句话"}]}})
        msg, chunks = wait_result(3, timeout=60)
        assert (msg.get("result") or {}).get("stopReason") == "end_turn", "prompt: %r" % msg
        assert "Stub Hub" in chunks, "reply text missing from chunks: %r" % chunks
        print("PASS session/prompt stopReason=end_turn, reply streamed (%d chars)" % len(chunks))
        send({"jsonrpc": "2.0", "id": 4, "method": "session/set_model",
              "params": {"sessionId": session_id, "modelId": "muse"}})
        msg, _ = wait_result(4)
        assert (msg.get("result") or {}).get("models", {}).get("currentModelId") == "muse", "set_model: %r" % msg
        print("PASS session/set_model currentModelId=muse")
        send({"jsonrpc": "2.0", "id": 5, "method": "session/set_config_option",
              "params": {"sessionId": session_id, "configId": "model", "value": "muse"}})
        msg, _ = wait_result(5)
        result = msg.get("result") or {}
        assert result.get("models", {}).get("currentModelId") == "muse", "set_config_option: %r" % msg
        options = result.get("configOptions") or []
        assert options and options[0].get("currentValue") == "muse", "set_config_option: %r" % msg
        print("PASS session/set_config_option model currentValue=muse")
        send({"jsonrpc": "2.0", "id": 6, "method": "session/set_model",
              "params": {"sessionId": session_id, "modelId": "no-such-model"}})
        msg, _ = wait_result(6)
        assert "error" in msg, "unknown model accepted: %r" % msg
        print("PASS session/set_model rejects unknown model")
        send({"jsonrpc": "2.0", "id": 7, "method": "session/set_config_option",
              "params": {"sessionId": session_id, "configId": "model", "value": "no-such-model"}})
        msg, _ = wait_result(7)
        assert "error" in msg, "unknown model accepted: %r" % msg
        print("PASS session/set_config_option rejects unknown model")
        send({"jsonrpc": "2.0", "id": 8, "method": "initialize",
              "params": {"protocolVersion": 1,
                         "clientInfo": {"name": "selftest", "version": "1"},
                         "clientCapabilities": {}}})
        msg, _ = wait_result(8)
        state = ((msg.get("result") or {}).get("_meta") or {}).get("modelState") or {}
        assert state.get("currentModelId") == "muse", "re-initialize modelState: %r" % msg
        print("PASS re-initialize modelState currentModelId=muse")
        proc.stdin.close()
        proc.wait(timeout=5)
        model_file = os.path.join(home, ".agent-hub", "model-muse.json")
        with open(model_file, encoding="utf-8") as fh:
            assert json.load(fh) == {"modelId": "muse"}, "model file: %s" % model_file
        assert oct(os.stat(model_file).st_mode & 0o777) == "0o600", "model file mode: %s" % model_file
        print("PASS recorded model persisted 0600")
        fresh = subprocess.run(
            [sys.executable, os.path.abspath(__file__)], env=env,
            input=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                              "params": {"protocolVersion": 1,
                                         "clientInfo": {"name": "selftest", "version": "1"},
                                         "clientCapabilities": {}}}) + "\n",
            capture_output=True, text=True, timeout=20,
        )
        first = (fresh.stdout.splitlines() or [""])[0]
        state = ((json.loads(first).get("result") or {}).get("_meta") or {}).get("modelState") or {}
        assert state.get("currentModelId") == "muse", "fresh initialize modelState: %r" % first
        print("PASS fresh process initialize modelState currentModelId=muse")
        print("SELFTEST PASS")
        return 0
    except AssertionError as exc:
        print("SELFTEST FAIL: %s" % exc)
        return 1
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        shutil.rmtree(home, ignore_errors=True)
        stub_proc.terminate()
        try:
            stub_proc.wait(timeout=5)
        except Exception:
            stub_proc.kill()


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    Bridge().run()
