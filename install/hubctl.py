#!/usr/bin/env python3
"""Dependency-free controller for one Agent Hub installation."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from urllib.request import build_opener, ProxyHandler, Request

ROOT = Path(os.environ.get("AGENT_HUB_ROOT", Path(__file__).resolve().parent)).expanduser().resolve()
META = ROOT / "install.json"
ENV = ROOT / "hub.env"
PIDS = ROOT / "processes.json"
SUPERVISOR = ROOT / "supervisor.json"
LOG = ROOT / "hub.log"
BRIDGE_LOG = ROOT / "bridge.log"
HEALTH_HTTP = build_opener(ProxyHandler({}))


def read_json(path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def meta():
    return read_json(META, {}) or {}


def local_url():
    host = str(meta().get("listen", "127.0.0.1"))
    if host in ("0.0.0.0", "127.0.0.1", "localhost", ""):
        host = "127.0.0.1"
    elif host == "::":
        host = "::1"
    if ":" in host:
        host = "[" + host.strip("[]") + "]"
    return "http://%s:%s" % (host, meta().get("port", 8930))


def public_url():
    value = meta().get("publicUrl")
    if not isinstance(value, str) or not value:
        raise SystemExit("Hub public URL is not configured")
    return value.rstrip("/")


def processes():
    return read_json(PIDS, {}) or {}


@contextmanager
def controller_lock():
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / ".control-lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def matches(value, script, argument=None):
    if not isinstance(value, int) or value <= 1:
        return False
    try:
        output = subprocess.check_output(
            ["ps", "-p", str(value), "-o", "stat=", "-o", "args="],
            text=True, stderr=subprocess.DEVNULL,
        ).strip()
        state, command = output.split(None, 1)
        script_match = re.search(r"(?:^|\s)" + re.escape(str(script)) + r"(?:\s|$)", command)
        argument_match = argument is None or re.search(r"(?:^|\s)" + re.escape(argument) + r"(?:\s|$)", command)
        return "Z" not in state and bool(script_match and argument_match)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return False


def healthy():
    try:
        with HEALTH_HTTP.open(Request(local_url() + "/health"), timeout=2) as response:
            return response.status == 200 and json.loads(response.read()).get("service") == "agent-hub"
    except (OSError, ValueError):
        return False


def ready():
    try:
        age = time.time() - (ROOT / "bridge" / "ready").stat().st_mtime
        return 0 <= age < 60
    except OSError:
        return False


def child_env():
    settings = read_json(ENV, {}) or {}
    env = os.environ.copy()
    env.update({k: v for k, v in settings.items() if isinstance(k, str) and isinstance(v, str)})
    env.update(
        WB_HUB=local_url(), HUB_PUBLIC_URL=public_url(),
        WB_HUB_CONFIG=str(ROOT / "hub" / "config.json"),
        WB_MUSE_READY_FILE=str(ROOT / "bridge" / "ready"),
    )
    return env


def launch_bridge(env, current):
    script = ROOT / "bridge" / "muse-bridge.py"
    if matches(current.get("bridge"), script):
        return current
    with BRIDGE_LOG.open("ab") as output:
        child = subprocess.Popen(
            [sys.executable, str(script)], cwd=ROOT / "bridge", env=env,
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
        )
    current = {**current, "bridge": child.pid}
    write_json(PIDS, current)
    time.sleep(0.2)
    if child.poll() is not None:
        raise SystemExit("Muse bridge exited; inspect " + str(BRIDGE_LOG))
    return current


def stop_children():
    values = processes()
    for name, script in (("bridge", ROOT / "bridge" / "muse-bridge.py"), ("hub", ROOT / "hub" / "server.js")):
        pid = values.get(name)
        if not matches(pid, script):
            values.pop(name, None)
            continue
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while matches(pid, script) and time.monotonic() < deadline:
            time.sleep(0.1)
        if matches(pid, script):
            os.kill(pid, signal.SIGKILL)
            deadline = time.monotonic() + 2
            while matches(pid, script) and time.monotonic() < deadline:
                time.sleep(0.1)
        if matches(pid, script):
            write_json(PIDS, values)
            raise SystemExit("Could not stop owned " + name + " process; process record retained")
        values.pop(name, None)
        write_json(PIDS, values)
    PIDS.unlink(missing_ok=True)


def start():
    with controller_lock():
        current = processes()
        env = child_env()
        hub_script = ROOT / "hub" / "server.js"
        if matches(current.get("hub"), hub_script) and healthy():
            launch_bridge(env, current)
            print(json.dumps({"ok": True, "running": True, "pid": current["hub"]}))
            return
        stop_children()
        settings = meta()
        address = str(settings.get("listen", "127.0.0.1")).strip("[]")
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        try:
            with socket.socket(family, socket.SOCK_STREAM) as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind((address, int(settings.get("port", 8930))))
        except OSError:
            raise SystemExit("Hub listen address/port is unavailable; no other service was stopped")
        with LOG.open("ab") as output:
            child = subprocess.Popen(
                [env.get("AGENT_HUB_NODE", "node"), str(hub_script)], cwd=ROOT, env=env,
                stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True,
            )
        write_json(PIDS, {"hub": child.pid})
        deadline = time.monotonic() + 10
        started = False
        try:
            while time.monotonic() < deadline and child.poll() is None:
                if healthy():
                    time.sleep(0.1)
                    if child.poll() is None:
                        started = True
                        break
                time.sleep(0.1)
            if not started:
                raise SystemExit("Hub did not become healthy; inspect " + str(LOG))
            launch_bridge(env, {"hub": child.pid})
        except BaseException:
            stop_children()
            raise
        print(json.dumps({"ok": True, "running": True, "pid": child.pid, "bridge": True}))


def stop():
    supervisor = read_json(SUPERVISOR, {}) or {}
    pid = supervisor.get("pid")
    script = supervisor.get("script", str(ROOT / "hubctl.py"))
    if not isinstance(script, str) or Path(script).resolve() != ROOT / "hubctl.py":
        raise SystemExit("Invalid supervisor record; installation was left intact")
    if pid != os.getpid() and matches(pid, script, "supervise"):
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 15
        while matches(pid, script, "supervise") and time.monotonic() < deadline:
            time.sleep(0.1)
        if matches(pid, script, "supervise"):
            raise SystemExit("Supervisor did not stop; installation was left intact")
    with controller_lock():
        stop_children()
    print(json.dumps({"ok": True, "running": False}))


def status():
    values = processes()
    hub = matches(values.get("hub"), ROOT / "hub" / "server.js")
    bridge = matches(values.get("bridge"), ROOT / "bridge" / "muse-bridge.py")
    health = hub and healthy()
    print(json.dumps({
        "ok": True, "running": health,
        "hub": {"pid": values.get("hub"), "running": hub, "healthy": health},
        "bridge": {"pid": values.get("bridge"), "running": bridge, "ready": bridge and ready()},
        "hubUrl": meta().get("publicUrl"),
    }, ensure_ascii=False))


def connection(print_value=False):
    token = ((read_json(ROOT / "hub" / "config.json", {}) or {}).get("tokens") or {}).get("mac")
    if not isinstance(token, str) or not token:
        raise SystemExit("Hub has not generated tokens; run hubctl start first")
    value = {"format": "agent-hub-connection", "version": 1, "hubUrl": public_url(), "token": token}
    path = ROOT / "connection.json"
    write_json(path, value)
    print(json.dumps(value, ensure_ascii=False) if print_value else str(path))


def muse_ready():
    marker = ROOT / "bridge" / "ready"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("ready\n")
    marker.chmod(0o600)
    print(json.dumps({"ok": True, "readyMarker": str(marker)}))


def muse_not_ready():
    (ROOT / "bridge" / "ready").unlink(missing_ok=True)
    print(json.dumps({"ok": True, "ready": False}))


def wb():
    raise SystemExit(subprocess.run(
        [sys.executable, str(ROOT / "tools" / "wb.py"), *sys.argv[2:]], env=child_env(),
    ).returncode)


def supervise():
    quitting = False
    def on_stop(signum, frame):
        nonlocal quitting
        quitting = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, on_stop)
    with (ROOT / ".supervisor-lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("A supervisor is already running for this installation")
        write_json(SUPERVISOR, {"pid": os.getpid(), "script": os.path.abspath(sys.argv[0])})
        try:
            start()
            while not quitting:
                values = processes()
                if not (matches(values.get("hub"), ROOT / "hub" / "server.js") and healthy()
                        and matches(values.get("bridge"), ROOT / "bridge" / "muse-bridge.py")):
                    raise SystemExit(1)
                for _ in range(10):
                    if quitting:
                        break
                    time.sleep(0.2)
        finally:
            with controller_lock():
                stop_children()
            SUPERVISOR.unlink(missing_ok=True)


def systemd_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def enable():
    systemctl = shutil.which("systemctl")
    if not systemctl:
        raise SystemExit("systemd is unavailable; use your machine's service manager")
    directory = Path.home() / ".config" / "systemd" / "user"
    directory.mkdir(parents=True, exist_ok=True)
    unit = directory / "agent-hub.service"
    executable = (systemd_quote(sys.executable) + " " + systemd_quote(ROOT / "hubctl.py")).replace("$", "$$")
    unit.write_text(
        "[Unit]\nDescription=Agent Hub\nAfter=network-online.target\n\n"
        "[Service]\nType=simple\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=25\n"
        "Environment=" + systemd_quote("AGENT_HUB_ROOT=" + str(ROOT)) + "\n"
        "ExecStart=" + executable + " supervise\nExecStop=" + executable + " stop\n\n"
        "[Install]\nWantedBy=default.target\n"
    )
    loaded = subprocess.run([systemctl, "--user", "show", unit.name, "--property=LoadState", "--value"], check=True, capture_output=True, text=True).stdout.strip()
    if loaded != "not-found":
        subprocess.run([systemctl, "--user", "stop", unit.name], check=True)
    stop()
    subprocess.run([systemctl, "--user", "daemon-reload"], check=True)
    subprocess.run([systemctl, "--user", "enable", "--now", unit.name], check=True)
    write_json(ROOT / "service.json", {"manager": "systemd-user"})
    print(json.dumps({"ok": True, "unit": str(unit)}))


if __name__ == "__main__":
    args = sys.argv[1:]
    command = args[0] if args else "status"
    if command in ("--help", "-h"):
        print("Usage: hubctl.py {start|stop|status|connection [--write-only]|muse-ready|muse-not-ready|wb ...|supervise|enable}")
    elif command == "wb":
        wb()
    elif command == "connection":
        connection("--write-only" not in args[1:])
    else:
        actions = {"start": start, "stop": stop, "status": status, "muse-ready": muse_ready,
                   "muse-not-ready": muse_not_ready, "enable": enable, "supervise": supervise}
        if command not in actions:
            raise SystemExit("unknown command: " + command)
        actions[command]()
