import json
import io
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

import importlib.util

def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
bridge = load_module("muse_bridge", os.path.join(os.path.dirname(__file__), "..", "bridge", "muse-bridge.py"))
wb = load_module("wb", os.path.join(os.path.dirname(__file__), "..", "tools", "wb.py"))


class FakeResponse:
    def __init__(self, status=200, body=b"{}"):
        self.status = status
        self.body = body
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self): return self.body


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = {name: getattr(bridge, name) for name in ("INBOX_DIR", "OUTBOX_DIR", "DONE_DIR", "CONFIG_PATH", "LOG_PATH")}
        bridge.INBOX_DIR = os.path.join(self.tmp.name, "inbox")
        bridge.OUTBOX_DIR = os.path.join(self.tmp.name, "outbox")
        bridge.DONE_DIR = os.path.join(self.tmp.name, "done")
        bridge.CONFIG_PATH = os.path.join(self.tmp.name, "config.json")
        bridge.LOG_PATH = os.path.join(self.tmp.name, "bridge.log")
        for path in (bridge.INBOX_DIR, bridge.OUTBOX_DIR, bridge.DONE_DIR): os.makedirs(path)
        with open(bridge.CONFIG_PATH, "w") as fh: json.dump({"tokens": {"muse": "secret"}}, fh)
        bridge._token_cache.update(mtime=None, value=None)
    def tearDown(self):
        for name, value in self.old.items(): setattr(bridge, name, value)
        self.tmp.cleanup()

    def test_executor_readiness_requires_a_fresh_live_marker(self):
        with mock.patch.object(bridge, "READY_FILE", None):
            self.assertIsNone(bridge.executor_ready())
        marker = os.path.join(self.tmp.name, "ready")
        with mock.patch.object(bridge, "READY_FILE", marker):
            self.assertFalse(bridge.executor_ready())
            with open(marker, "w") as fh: fh.write("ready")
            self.assertTrue(bridge.executor_ready())
            old = time.time() - 61
            os.utime(marker, (old, old))
            self.assertFalse(bridge.executor_ready())
            future = time.time() + 60
            os.utime(marker, (future, future))
            self.assertFalse(bridge.executor_ready())

    def test_inbox_preserves_context_and_parent(self):
        bridge.write_inbox({"id": "t1", "contextId": "c1", "parentTaskId": "p1", "role": "chief", "instructions": "delegate", "messages": [{"from": "user", "text": "hi"}], "claimToken": "claim", "text": "work"})
        with open(os.path.join(bridge.INBOX_DIR, "t1.json")) as fh: row = json.load(fh)
        self.assertEqual(row["parentTaskId"], "p1")
        self.assertEqual(row["instructions"], "delegate")
        self.assertEqual(row["messages"][0]["text"], "hi")

    def test_stale_reply_is_archived_and_does_not_block_next(self):
        with open(os.path.join(bridge.OUTBOX_DIR, "a-old.json"), "w") as fh: json.dump({"taskId": "old", "claimToken": "x", "text": "late"}, fh)
        with open(os.path.join(bridge.OUTBOX_DIR, "z-new.json"), "w") as fh: json.dump({"taskId": "new", "claimToken": "y", "text": "ok"}, fh)
        def post(path, payload):
            if payload["taskId"] == "old": raise bridge.HubHTTPError(409)
            return {}
        with mock.patch.object(bridge, "hub_post", side_effect=post): bridge.flush_outbox()
        self.assertTrue(os.path.exists(os.path.join(bridge.DONE_DIR, "a-old.json")))
        self.assertTrue(os.path.exists(os.path.join(bridge.DONE_DIR, "z-new.json")))

    def test_stale_renewal_does_not_block_later_claims(self):
        bridge.write_inbox({"id": "old", "claimToken": "old-claim"})
        bridge.write_inbox({"id": "current", "claimToken": "current-claim"})
        with mock.patch.object(bridge, "hub_post", side_effect=[bridge.HubHTTPError(409), {}]) as post:
            bridge.renew_inbox()
        self.assertEqual(post.call_count, 2)
        self.assertTrue(os.path.exists(os.path.join(bridge.DONE_DIR, "old.json")))


class CliTests(unittest.TestCase):
    def test_invalid_before_is_friendly(self):
        with mock.patch.object(wb, "run_mcp", return_value=0) as call:
            code = wb.cmd_read(["conv", "--before", "abc"])
        self.assertEqual(code, 1)
        call.assert_not_called()

    def test_chief_claim_headers_without_logging_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = wb.INBOX_DIR
            wb.INBOX_DIR = tmp
            with open(os.path.join(tmp, "t1.json"), "w") as fh: json.dump({"claimToken": "claim-secret"}, fh)
            config = os.path.join(tmp, "config.json")
            with open(config, "w") as fh: json.dump({"tokens": {"muse": "muse-secret"}}, fh)
            with mock.patch.object(wb, "CONFIG_PATH", config), mock.patch.dict(os.environ, {"WB_TASK_ID": "t1"}):
                with mock.patch.object(wb.urllib.request, "urlopen", return_value=FakeResponse()) as open_call:
                    wb.http_json("POST", "/mcp", {})
            request = open_call.call_args[0][0]
            self.assertEqual(request.headers["X-agent-hub-task"], "t1")
            self.assertEqual(request.headers["X-agent-hub-claim"], "claim-secret")
            wb.INBOX_DIR = old


class RecoveryTests(unittest.TestCase):
    def test_new_claim_replaces_same_task_inbox(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = {name: getattr(bridge, name) for name in ("INBOX_DIR", "OUTBOX_DIR", "DONE_DIR")}
            bridge.INBOX_DIR, bridge.OUTBOX_DIR, bridge.DONE_DIR = [os.path.join(tmp, x) for x in ("inbox", "outbox", "done")]
            for path in (bridge.INBOX_DIR, bridge.OUTBOX_DIR, bridge.DONE_DIR): os.makedirs(path)
            bridge.write_inbox({"id": "same", "claimToken": "old", "text": "old"})
            bridge.write_inbox({"id": "same", "claimToken": "new", "text": "new"})
            with open(os.path.join(bridge.INBOX_DIR, "same.json")) as fh: row = json.load(fh)
            self.assertEqual(row["claimToken"], "new")
            for name, value in old.items(): setattr(bridge, name, value)

    def test_outbox_transport_failure_stays_then_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = {name: getattr(bridge, name) for name in ("INBOX_DIR", "OUTBOX_DIR", "DONE_DIR")}
            bridge.INBOX_DIR, bridge.OUTBOX_DIR, bridge.DONE_DIR = [os.path.join(tmp, x) for x in ("inbox", "outbox", "done")]
            for path in (bridge.INBOX_DIR, bridge.OUTBOX_DIR, bridge.DONE_DIR): os.makedirs(path)
            with open(os.path.join(bridge.OUTBOX_DIR, "one.json"), "w") as fh: json.dump({"taskId": "one", "claimToken": "c", "text": "reply"}, fh)
            with mock.patch.object(bridge, "hub_post", side_effect=[bridge.HubUnreachable("offline"), {}]):
                bridge.flush_outbox(); self.assertTrue(os.path.exists(os.path.join(bridge.OUTBOX_DIR, "one.json")))
                bridge.flush_outbox(); self.assertTrue(os.path.exists(os.path.join(bridge.DONE_DIR, "one.json")))
            for name, value in old.items(): setattr(bridge, name, value)

    def test_task_id_path_traversal_is_rejected(self):
        with mock.patch.object(wb, "load_token", return_value="fixture"), mock.patch.dict(os.environ, {"WB_TASK_ID": "../escape"}), self.assertRaisesRegex(OSError, "local task id"):
            wb.http_json("POST", "/mcp", {})

    def test_reply_persists_current_claim_privately_without_printing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = os.path.join(tmp, "inbox"); outbox = os.path.join(tmp, "outbox"); os.mkdir(inbox)
            with open(os.path.join(inbox, "same.json"), "w") as fh: json.dump({"claimToken": "new-private-claim"}, fh)
            output = io.StringIO()
            with mock.patch.object(wb, "INBOX_DIR", inbox), mock.patch.object(wb, "OUTBOX_DIR", outbox), redirect_stdout(output):
                self.assertEqual(wb.cmd_reply(["same", "finished"]), 0)
                self.assertEqual(wb.cmd_reply(["missing", "must fail"]), 1)
            path = os.path.join(outbox, "same.json")
            with open(path) as fh: self.assertEqual(json.load(fh)["claimToken"], "new-private-claim")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertNotIn("new-private-claim", output.getvalue())


if __name__ == "__main__": unittest.main()
