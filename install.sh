#!/usr/bin/env bash
set -euo pipefail
SOURCE_URL="${AGENT_HUB_SOURCE_URL:-https://raw.githubusercontent.com/qinghua362330/agent-hub/v1.3.0}"
ROOT="${AGENT_HUB_ROOT:-$HOME/.agent-hub/server}"; PUBLIC_URL=""; LISTEN="0.0.0.0"; PORT="8930"; LOCAL_ONLY=0
usage() { printf '%s\n' 'Agent Hub installer (no paid service required)' 'Usage: install.sh --public-url https://hub.example.com [--listen 0.0.0.0] [--port 8930]' '       install.sh --local-only [--listen 127.0.0.1] [--port 8930]' 'The script does not buy a server, open firewall ports, create a tunnel, or issue TLS.'; }
while (($#)); do
  case "$1" in
    --public-url) PUBLIC_URL="${2:?missing URL}"; shift 2;;
    --listen) LISTEN="${2:?missing address}"; shift 2;;
    --port) PORT="${2:?missing port}"; shift 2;;
    --root) ROOT="${2:?missing directory}"; shift 2;;
    --source-url) SOURCE_URL="${2:?missing source URL}"; shift 2;;
    --local-only) LOCAL_ONLY=1; PUBLIC_URL="http://127.0.0.1:${PORT}"; shift;;
    --help|-h) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done
if [[ "$LOCAL_ONLY" != 1 && -z "$PUBLIC_URL" ]]; then echo "Refusing to install without --public-url or --local-only." >&2; exit 2; fi
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required before downloading." >&2; exit 1; }
PORT="$(python3 - "$PORT" <<'PYPORT'
import sys
value = sys.argv[1]
if not value.isascii() or not value.isdigit() or len(value) > 10 or not 1 <= int(value) <= 65535:
    raise SystemExit('Invalid --port')
print(int(value))
PYPORT
)"
LISTEN="${LISTEN#[}"; LISTEN="${LISTEN%]}"
if [[ "$LOCAL_ONLY" == 1 ]]; then PUBLIC_URL="http://127.0.0.1:${PORT}"; fi
if [[ "$LOCAL_ONLY" == 1 ]]; then LISTEN="127.0.0.1"; fi
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "Node.js >=22 is required before downloading; install it on the Hub machine." >&2; exit 1; }
if [[ "$LOCAL_ONLY" != 1 ]]; then NODE_BIN="$NODE_BIN" python3 - "$PUBLIC_URL" <<'PY'
import ipaddress, sys
from urllib.parse import urlsplit
value = sys.argv[1]; parsed = urlsplit(value)
try: parsed.port
except ValueError: raise SystemExit('Invalid --public-url port')
if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit('Invalid --public-url: use an http(s) URL without userinfo/query/fragment')
if any(c.isspace() or ord(c) < 32 for c in value):
    raise SystemExit('Invalid --public-url whitespace')
if parsed.hostname.rstrip('.').lower() == 'localhost' or parsed.hostname.rstrip('.').lower().endswith('.localhost'):
    raise SystemExit('A loopback/unspecified --public-url requires --local-only')
try: ip = ipaddress.ip_address(parsed.hostname)
except ValueError: ip = None
if ip and (ip.is_loopback or ip.is_unspecified):
    raise SystemExit('A loopback/unspecified --public-url requires --local-only')
PY
fi
NODE_MAJOR="$("$NODE_BIN" --version | sed -E 's/^v([0-9]+).*/\1/')"; [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || { echo "Node.js >=22 is required before downloading (found $NODE_MAJOR)." >&2; exit 1; }
ROOT="$(python3 - "$ROOT" <<'PYROOT'
import json, sys
from pathlib import Path
root = Path(sys.argv[1]).expanduser()
if root.is_symlink(): raise SystemExit('Install root must not be a symlink')
root = root.resolve()
if root == Path('/') or root == Path.home(): raise SystemExit('Choose a dedicated Agent Hub install directory')
if root.exists():
    try: managed = json.loads((root / 'install.json').read_text()).get('format') == 'agent-hub-install'
    except (OSError, ValueError, AttributeError): managed = False
    if not managed: raise SystemExit('Refusing to replace an unmanaged directory: ' + str(root))
print(root)
PYROOT
)"
mkdir -p "$(dirname "$ROOT")"
LOCK="${ROOT}.install-lock"
mkdir "$LOCK" 2>/dev/null || { echo "Another install is active: $LOCK" >&2; exit 1; }
STAGE=""; BACKUP="${ROOT}.backup.$$"; OLD_STOPPED=0; MOVED_OLD=0; PROMOTED=0
cleanup() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    if (( PROMOTED == 1 )); then
      AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" stop >/dev/null 2>&1 || true
      mv "$ROOT" "${ROOT}.failed.$$" || true
    fi
    if (( MOVED_OLD == 1 )); then
      if ! mv "$BACKUP" "$ROOT"; then
        echo "Previous installation retained at $BACKUP; restore it manually." >&2
        exit "$result"
      fi
    fi
    if (( OLD_STOPPED == 1 )); then
      AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" start >/dev/null 2>&1 || echo "Previous files restored; restart the Hub with hubctl.py start." >&2
      if [[ -f "$ROOT/service.json" ]]; then
        AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" enable >/dev/null 2>&1 || echo "Restore service supervision with hubctl.py enable." >&2
      fi
    fi
  fi
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
  rmdir "$LOCK" 2>/dev/null || true
  return "$result"
}
trap cleanup EXIT
STAGE="$(mktemp -d "${ROOT}.stage.XXXXXX")"
mkdir -p "$STAGE/hub" "$STAGE/bridge" "$STAGE/tools" "$STAGE/client"; chmod 700 "$STAGE" "$STAGE/hub" "$STAGE/bridge" "$STAGE/tools" "$STAGE/client"
download() {
  local remote="$1" target="$2" temp="${2}.tmp.$$"
  if command -v curl >/dev/null 2>&1; then curl --fail --silent --show-error --location --retry 2 "${SOURCE_URL%/}/${remote}" -o "$temp"
  elif command -v python3 >/dev/null 2>&1; then python3 - "$SOURCE_URL" "$remote" "$temp" <<'PY'
import sys, urllib.request
base, name, target = sys.argv[1:]
with urllib.request.urlopen(base.rstrip('/') + '/' + name, timeout=30) as source, open(target, 'wb') as output: output.write(source.read())
PY
  else echo "Need curl or python3 to download the Hub." >&2; exit 1; fi
  test -s "$temp"; mv "$temp" "$target"
}
download hub/server.js "$STAGE/hub/server.js"; download bridge/muse-bridge.py "$STAGE/bridge/muse-bridge.py"; download tools/wb.py "$STAGE/tools/wb.py"; download client/acp-bridge.py "$STAGE/client/acp-bridge.py"; download install/hubctl.py "$STAGE/hubctl.py"
chmod 755 "$STAGE/bridge/muse-bridge.py" "$STAGE/tools/wb.py" "$STAGE/client/acp-bridge.py" "$STAGE/hubctl.py"
"$NODE_BIN" --check "$STAGE/hub/server.js"; python3 -m py_compile "$STAGE/bridge/muse-bridge.py" "$STAGE/tools/wb.py" "$STAGE/client/acp-bridge.py" "$STAGE/hubctl.py"
if [[ -x "$ROOT/hubctl.py" ]]; then OLD_STOPPED=1; AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" stop; fi
if [[ -d "$ROOT/hub/data" ]]; then cp -a "$ROOT/hub/data" "$STAGE/hub/"; fi
if [[ -f "$ROOT/hub/config.json" ]]; then cp -p "$ROOT/hub/config.json" "$STAGE/hub/config.json"; fi
for item in bridge/inbox bridge/outbox bridge/done; do if [[ -d "$ROOT/$item" ]]; then mkdir -p "$STAGE/$item"; cp -a "$ROOT/$item/." "$STAGE/$item/"; fi; done
for item in bridge/ready hub.log bridge.log connection.json service.json; do if [[ -e "$ROOT/$item" ]]; then cp -p "$ROOT/$item" "$STAGE/$item"; fi; done
python3 - "$STAGE" "$PUBLIC_URL" "$LISTEN" "$PORT" "$SOURCE_URL" "$NODE_BIN" <<'PY'
import json, sys
from pathlib import Path
root, public_url, listen, port, source, node_bin = sys.argv[1:]
root = Path(root); path = root / 'install.json'; path.write_text(json.dumps({'format':'agent-hub-install', 'version':1, 'publicUrl':public_url.rstrip('/'), 'listen':listen, 'port':int(port), 'sourceUrl':source.rstrip('/')}, indent=2) + '\n'); path.chmod(0o600)
env = root / 'hub.env'; env.write_text(json.dumps({'HOST':listen, 'PORT':port, 'AGENT_HUB_NODE':node_bin}, indent=2) + '\n'); env.chmod(0o600)
PY
if [[ -e "$ROOT" ]]; then mv "$ROOT" "$BACKUP"; MOVED_OLD=1; fi
mv "$STAGE" "$ROOT"; PROMOTED=1
AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" start
AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" connection --write-only >/dev/null
if [[ -f "$ROOT/service.json" ]]; then AGENT_HUB_ROOT="$ROOT" "$ROOT/hubctl.py" enable; fi
if (( MOVED_OLD == 1 )); then rm -rf -- "$BACKUP"; fi
PROMOTED=0; OLD_STOPPED=0; MOVED_OLD=0
printf '%s\n' '' 'Agent Hub installed. Keep this machine online.' 'Private connection file:' "  $ROOT/connection.json" 'Muse must connect its actual task processor. Refresh its readiness every 20s while the executor is alive:' "  $ROOT/hubctl.py muse-ready" 'Share connection JSON privately with OpenMausBot:' "  $ROOT/hubctl.py connection" "For Linux systemd user startup: $ROOT/hubctl.py enable"
