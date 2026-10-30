"""Download official nflverse release assets, preserving provenance and TLS."""
from __future__ import annotations

import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

BASE = "https://github.com/nflverse/nflverse-data/releases/download"


def sources(start: int = 2015, end: int = 2025) -> list[tuple[str, str]]:
    result = [("players.csv", f"{BASE}/players/players.csv")]
    for year in range(start, end + 1):
        result.extend([
            (f"stats_{year}.csv", f"{BASE}/stats_player/stats_player_week_{year}.csv"),
            (f"rosters_{year}.csv", f"{BASE}/rosters/roster_{year}.csv"),
            (f"snaps_{year}.csv", f"{BASE}/snap_counts/snap_counts_{year}.csv"),
            (f"injuries_{year}.csv", f"{BASE}/injuries/injuries_{year}.csv"),
        ])
    return result


def download(root: Path, start: int = 2015, end: int = 2025, refresh: bool = False) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}

    def fetch(source: tuple[str, str]) -> tuple[str, dict]:
        filename, url = source
        path = root / filename
        if path.exists() and not refresh:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            old = previous.get("files", {}).get(filename, {})
            if old.get("sha256") != digest:
                raise ValueError(f"Cached checksum missing/mismatch: {filename}; use --refresh")
            return filename, old
        for attempt in range(3):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "ff-game-research/0.1"})
                with urllib.request.urlopen(request, timeout=90) as response:
                    content = response.read()
                    if not content or b"," not in content.splitlines()[0]:
                        raise ValueError(f"Not a nonempty CSV: {url}")
                    entry = {"url": url, "bytes": len(content),
                             "sha256": hashlib.sha256(content).hexdigest(),
                             "downloaded_at": datetime.now(timezone.utc).isoformat(),
                             "etag": response.headers.get("ETag"), "status": "downloaded"}
                temporary = path.with_suffix(".part")
                temporary.write_bytes(content)
                temporary.replace(path)
                print(f"Downloaded {filename}: {len(content):,} bytes", flush=True)
                return filename, entry
            except urllib.error.HTTPError as error:
                # Missing injury reports are explicit gaps, never fabricated zeros.
                if error.code == 404 and filename.startswith("injuries_"):
                    return filename, {"url": url, "status": "missing", "http_status": 404}
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise
            except (TimeoutError, urllib.error.URLError):
                if attempt == 2:
                    raise
            time.sleep(2 ** attempt)
        raise RuntimeError(filename)

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        files = dict(executor.map(fetch, sources(start, end)))
    manifest = {"source": "nflverse/nflverse-data", "start": start, "end": end,
                "note": "SHA-256 records downloaded bytes; not publisher-signed checksums.",
                "files": files}
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest
