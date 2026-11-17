import json
import os
import shutil
import socket
import stat
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.home = Path(self.temp.name) / 'home'; self.home.mkdir(); self.source = Path(self.temp.name) / 'source'
        for name in ('hub', 'bridge', 'tools', 'client', 'install'): (self.source / name).mkdir(parents=True)
        for name in ('hub/server.js', 'bridge/muse-bridge.py', 'tools/wb.py', 'client/acp-bridge.py', 'install/hubctl.py'):
            target = self.source / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(ROOT / name, target)
        self.bad_source = self.source / 'bad'; self.bad_source.mkdir();
        for name in ('hub', 'bridge', 'tools', 'client', 'install'): shutil.copytree(self.source / name, self.bad_source / name);
        (self.bad_source / 'hub/server.js').write_text("process.exit(1);\n")
        source = self.source
        class Quiet(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(source), **kwargs)
            def log_message(self, *args): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Quiet); self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start(); self.url = f'http://127.0.0.1:{self.server.server_port}'
        probe = socket.socket(); probe.bind(('127.0.0.1', 0)); self.hub_port = probe.getsockname()[1]; probe.close()
        self.root = self.home / 'hub'; self.env = {**os.environ, 'HOME': str(self.home), 'AGENT_HUB_ROOT': str(self.root)}
    def tearDown(self):
        if (self.root / 'hubctl.py').exists(): subprocess.run([str(self.root / 'hubctl.py'), 'stop'], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.server.shutdown(); self.server.server_close(); self.temp.cleanup()
    def run_install(self, *args, source=None):
        return subprocess.run(['bash', str(ROOT / 'install.sh'), '--source-url', source or self.url, *args], env=self.env, text=True, capture_output=True)
    def test_requires_explicit_remote_or_local_mode(self):
        result = self.run_install(); self.assertNotEqual(result.returncode, 0); self.assertIn('--public-url', result.stderr)
    def test_rejects_loopback_remote_urls_and_invalid_ports(self):
        for address in ('http://localhost', 'http://localhost.', 'http://127.0.0.2:8930', 'http://[::1]:8930', 'http://0.0.0.0:8930'):
            with self.subTest(address=address):
                result = self.run_install('--public-url', address)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.root.exists())
        for port in ('0', '65536', '999999999999999999999999999999999999'):
            self.assertNotEqual(self.run_install('--local-only', '--port', port).returncode, 0)
    def test_refuses_to_replace_unmanaged_directory(self):
        self.root.mkdir(); (self.root / 'keep.txt').write_text('keep')
        result = self.run_install('--local-only', '--port', str(self.hub_port))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unmanaged', result.stderr)
        self.assertEqual((self.root / 'keep.txt').read_text(), 'keep')
    def test_supervisor_stops_cleanly_and_fails_when_a_child_dies(self):
        self.root = self.home / 'hub with spaces'; self.env['AGENT_HUB_ROOT'] = str(self.root)
        result = self.run_install('--local-only', '--port', str(self.hub_port))
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        for crash in (False, True):
            supervisor = subprocess.Popen([str(self.root / 'hubctl.py'), 'supervise'], env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 15
                values = {}
                while time.monotonic() < deadline:
                    if supervisor.poll() is not None:
                        self.fail('supervisor exited: ' + supervisor.stderr.read().decode())
                    try: values = json.loads((self.root / 'processes.json').read_text())
                    except (OSError, ValueError): values = {}
                    if (self.root / 'supervisor.json').exists() and values.get('bridge'):
                        break
                    time.sleep(.1)
                self.assertTrue(values.get('bridge'), 'supervisor did not start its bridge')
                if crash:
                    os.kill(values['bridge'], 9)
                else:
                    subprocess.check_call([str(self.root / 'hubctl.py'), 'stop'], env=self.env, stdout=subprocess.DEVNULL)
                self.assertEqual(supervisor.wait(timeout=20), 1 if crash else 0, supervisor.stderr.read().decode())
                self.assertFalse((self.root / 'supervisor.json').exists())
                status = json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env))
                self.assertFalse(status['hub']['running']); self.assertFalse(status['bridge']['running'])
            finally:
                if supervisor.poll() is None: supervisor.terminate(); supervisor.wait(timeout=20)
                supervisor.stderr.close()
    def test_occupied_hub_port_does_not_count_as_a_successful_install(self):
        result = self.run_install('--local-only', '--port', str(self.server.server_port))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unavailable', result.stderr)
        self.assertFalse(self.root.exists())
    def test_real_hub_install_connection_status_and_stop(self):
        result = self.run_install('--local-only', '--port', str(self.hub_port)); self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertTrue((self.root / 'client/acp-bridge.py').exists()); status = json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env)); self.assertTrue(status['running']); self.assertTrue(status['hub']['healthy']); self.assertTrue(status['bridge']['running']); self.assertFalse(status['bridge']['ready'])
        connection = self.root / 'connection.json'; value = json.loads(connection.read_text()); self.assertEqual(set(value), {'format', 'version', 'hubUrl', 'token'}); self.assertEqual(stat.S_IMODE(connection.stat().st_mode), 0o600)
        self.assertEqual(json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'connection'], env=self.env)), value)
        subprocess.check_call([str(self.root / 'hubctl.py'), 'muse-ready'], env=self.env, stdout=subprocess.DEVNULL); old = os.stat(self.root / 'bridge/ready').st_mtime - 61; os.utime(self.root / 'bridge/ready', (old, old)); self.assertFalse(json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env))['bridge']['ready'])
        future = time.time() + 3600; os.utime(self.root / 'bridge/ready', (future, future)); self.assertFalse(json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env))['bridge']['ready'])
        token = value['token']; (self.root / 'hub/data/sentinel.json').write_text('{"keep":true}\n')
        result = self.run_install('--local-only', '--port', str(self.hub_port)); self.assertEqual(result.returncode, 0, result.stderr + result.stdout); self.assertEqual(json.loads((self.root / 'connection.json').read_text())['token'], token); self.assertTrue((self.root / 'hub/data/sentinel.json').exists())
        result = self.run_install('--local-only', '--port', str(self.hub_port), source='http://127.0.0.1:1/missing'); self.assertNotEqual(result.returncode, 0); self.assertTrue((self.root / 'hub/data/sentinel.json').exists()); self.assertTrue(json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env))['running'])
        result = self.run_install('--local-only', '--port', str(self.hub_port), source=self.url + '/bad'); self.assertNotEqual(result.returncode, 0); self.assertIn('did not become healthy', result.stderr); self.assertTrue(json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env))['running']); self.assertEqual(json.loads((self.root / 'connection.json').read_text())['token'], token)
        subprocess.check_call([str(self.root / 'hubctl.py'), 'stop'], env=self.env); stopped = json.loads(subprocess.check_output([str(self.root / 'hubctl.py'), 'status'], env=self.env)); self.assertFalse(stopped['running']); self.assertFalse(stopped['hub']['running']); self.assertFalse(stopped['bridge']['running'])

if __name__ == '__main__': unittest.main()
