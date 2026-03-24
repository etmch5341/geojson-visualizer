#!/usr/bin/env python3
"""
GeoJSON Viewer — Local Server
Serves the web app and provides a streaming API for large files.

Usage:
    python server.py [port]          # default port: 8000

Then open: http://localhost:8000
"""

import sys
import os
import json
import decimal
import random
import time
import urllib.parse
import webbrowser
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler


class _Encoder(json.JSONEncoder):
    """ijson returns Decimal for all numbers; convert them to float for JSON."""
    def default(self, obj):
        if isinstance(obj, decimal.Decimal):
            return float(obj)
        return super().default(obj)

try:
    import ijson
    HAS_IJSON = True
except ImportError:
    HAS_IJSON = False

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = dict(urllib.parse.parse_qsl(parsed.query))

        if parsed.path == "/api/load":
            self.handle_load(params)
        elif parsed.path == "/api/files":
            self.handle_files()
        else:
            super().do_GET()

    def handle_load(self, params):
        file_path = params.get("file", "")
        try:
            max_features = int(params.get("max", 100_000))
        except ValueError:
            max_features = 100_000

        if not file_path:
            self._json_error(400, "Missing 'file' parameter")
            return
        if not os.path.isfile(file_path):
            self._json_error(404, f"File not found: {file_path}")
            return

        file_size = os.path.getsize(file_path)
        t0 = time.time()

        try:
            if HAS_IJSON:
                result = self._load_with_ijson(file_path, max_features)
            else:
                result = self._load_simple(file_path, max_features)
        except Exception as e:
            self._json_error(500, str(e))
            return

        result["_meta"]["load_time_s"] = round(time.time() - t0, 2)
        result["_meta"]["file_size_mb"] = round(file_size / 1e6, 1)

        payload = json.dumps(result, cls=_Encoder).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _load_with_ijson(self, path, max_features):
        # Fast count pass
        total = 0
        with open(path, "rb") as f:
            for _ in ijson.items(f, "features.item.type"):
                total += 1

        keep_prob = min(1.0, max_features / max(total, 1))
        rng = random.Random(42)
        features = []

        with open(path, "rb") as f:
            for feat in ijson.items(f, "features.item"):
                if rng.random() <= keep_prob:
                    features.append(feat)

        return {
            "type": "FeatureCollection",
            "features": features,
            "_meta": {
                "total": total,
                "shown": len(features),
                "sampled": keep_prob < 1.0,
                "engine": "ijson",
            },
        }

    def _load_simple(self, path, max_features):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        features = data.get("features", [])
        total = len(features)
        sampled = total > max_features

        if sampled:
            features = random.sample(features, max_features)

        return {
            "type": "FeatureCollection",
            "features": features,
            "_meta": {
                "total": total,
                "shown": len(features),
                "sampled": sampled,
                "engine": "json",
            },
        }

    def handle_files(self):
        data_dir = os.path.join(ROOT, "data")
        files = []
        if os.path.isdir(data_dir):
            for name in sorted(os.listdir(data_dir)):
                if name.lower().endswith((".geojson", ".json")):
                    full = os.path.join(data_dir, name)
                    files.append({
                        "name": name,
                        "path": full,
                        "size": os.path.getsize(full),
                    })

        payload = json.dumps(files).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def _json_error(self, code, message):
        payload = json.dumps({"error": message}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        # Suppress all request logs (favicon 404s, etc.)
        pass


def open_browser(port):
    time.sleep(0.6)
    webbrowser.open(f"http://localhost:{port}")


if __name__ == "__main__":
    os.chdir(ROOT)

    data_dir = os.path.join(ROOT, "data")
    if not os.path.isdir(data_dir):
        os.makedirs(data_dir)
        print(f"Created data/ directory at {data_dir}")

    httpd = HTTPServer(("", PORT), Handler)

    ijson_status = "✓ ijson (fast streaming)" if HAS_IJSON else "✗ ijson not installed (pip install ijson)"
    print(f"""
╔══════════════════════════════════════════════╗
║          GeoJSON Viewer — Local Server       ║
╠══════════════════════════════════════════════╣
║  URL  : http://localhost:{PORT:<20}║
║  ijson: {ijson_status:<36}║
╚══════════════════════════════════════════════╝
Press Ctrl+C to stop.
""")

    threading.Thread(target=open_browser, args=(PORT,), daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
