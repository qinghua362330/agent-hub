#!/usr/bin/env python3
"""Tiny stdlib stub of the Agent Hub /mcp surface, for testing acp-bridge.py
without the real Hub. Implements just enough JSON-RPC:

- initialize -> MCP-style result (protocolVersion echo, capabilities, serverInfo)
- tools/call send_to_bot -> a fixed task + conversationId
- tools/call wait_for_conversation -> "working" on the first call for a
  conversation, "settled" afterwards, with a canned teammate reply
- ping -> {}
- notifications/* -> 202, no body

Usage: python3 stub-hub.py [port]   (default 18099)
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CANNED_REPLY = "这是来自 Stub Hub 的模拟回复：收到你的消息了。"


class StubHub(BaseHTTPRequestHandler):
    waits = {}  # conversationId -> call count

    def log_message(self, *args):
        pass

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            frame = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except ValueError:
            self._json(400, {"error": "bad json"})
            return
        method = frame.get("method") or ""
        req_id = frame.get("id")
        if method.startswith("notifications/"):
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "initialize":
            want = (frame.get("params") or {}).get("protocolVersion") or "2025-06-18"
            self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": {
                "protocolVersion": want,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "stub-hub", "version": "0.0.1"},
            }})
            return
        if method == "ping":
            self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": {}})
            return
        if method == "tools/call":
            params = frame.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            if name == "send_to_bot":
                result = {
                    "task": {"id": "stub-task-1", "contextId": "stub-conv-1",
                             "targetAgent": args.get("agentId"), "state": "SUBMITTED"},
                    "conversationId": "stub-conv-1",
                }
                self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": {
                    "content": [{"type": "text", "text": json.dumps(result)}],
                    "structuredContent": result,
                }})
                return
            if name == "wait_for_conversation":
                conv = args.get("conversationId") or "stub-conv-1"
                n = self.waits.get(conv, 0) + 1
                self.waits[conv] = n
                if n < 2:
                    result = {"status": "working", "tasks": [
                        {"id": "stub-task-1", "targetAgent": "muse",
                         "state": "WORKING"}], "recentMessages": []}
                else:
                    result = {"status": "settled", "tasks": [
                        {"id": "stub-task-1", "targetAgent": "muse",
                         "state": "COMPLETED", "result": CANNED_REPLY}],
                        "recentMessages": [
                            {"from": "mac", "text": "你好，请回复一句话"},
                            {"from": "muse", "text": CANNED_REPLY}]}
                self._json(200, {"jsonrpc": "2.0", "id": req_id, "result": {
                    "content": [{"type": "text", "text": json.dumps(result)}],
                    "structuredContent": result,
                }})
                return
            self._json(200, {"jsonrpc": "2.0", "id": req_id,
                             "error": {"code": -32601, "message": "unknown tool: %s" % name}})
            return
        self._json(200, {"jsonrpc": "2.0", "id": req_id,
                         "error": {"code": -32601, "message": "method not found: %s" % method}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18099
    ThreadingHTTPServer(("127.0.0.1", port), StubHub).serve_forever()
