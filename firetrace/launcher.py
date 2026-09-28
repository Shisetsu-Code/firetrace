from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".runtime"
FIRECRAWL_DIR = RUNTIME / "firecrawl"
FIRECRAWL_REF = os.getenv("FIRETRACE_FIRECRAWL_REF", "v2.11.0")
FIRECRAWL_URL = os.getenv("FIRETRACE_FIRECRAWL_URL", "http://127.0.0.1:3002")


def run(cmd, cwd=None, check=True):
    print("+", " ".join(map(str, cmd)))
    return subprocess.run(cmd, cwd=cwd, check=check)


def healthy() -> bool:
    for path in ("/", "/health"):
        try:
            with urllib.request.urlopen(FIRECRAWL_URL.rstrip("/") + path, timeout=2) as res:
                if res.status < 500:
                    return True
        except Exception:
            pass
    return False


def ensure_firecrawl() -> None:
    if healthy():
        print("Firecrawl already healthy.")
        return
    if not shutil.which("docker"):
        raise RuntimeError("Docker is required to start local Firecrawl")
    RUNTIME.mkdir(exist_ok=True)
    if not FIRECRAWL_DIR.exists():
        run(["git", "clone", "--depth", "1", "--branch", FIRECRAWL_REF,
             "https://github.com/firecrawl/firecrawl.git", str(FIRECRAWL_DIR)])
    env_file = FIRECRAWL_DIR / ".env"
    if not env_file.exists():
        env_file.write_text(
            "USE_DB_AUTHENTICATION=false\n"
            "PORT=3002\n"
            "HOST=0.0.0.0\n",
            encoding="utf-8",
        )
    run(["docker", "compose", "up", "-d"], cwd=FIRECRAWL_DIR)
    deadline = time.time() + 180
    while time.time() < deadline:
        if healthy():
            print("Firecrawl ready.")
            return
        time.sleep(3)
    raise RuntimeError("Firecrawl did not become healthy within 180 seconds")


def main() -> int:
    try:
        run(["git", "pull", "--ff-only"], cwd=ROOT, check=False)
        ensure_firecrawl()
        from .worker import Worker
        Worker().run()
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
