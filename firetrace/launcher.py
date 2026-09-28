from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

def find_repo_root() -> Path:
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent)
    candidates.extend([
        Path(__file__).resolve().parents[1],
        Path.cwd(),
        Path.home() / "firetrace",
        Path.home() / "Firetrace",
    ])
    for candidate in candidates:
        if (candidate / ".git").exists() and (candidate / "pyproject.toml").exists():
            return candidate
    return candidates[0]


ROOT = find_repo_root()
RUNTIME = ROOT / ".runtime"
FIRECRAWL_DIR = RUNTIME / "firecrawl"
FIRECRAWL_REF = os.getenv("FIRETRACE_FIRECRAWL_REF", "v2.11.0")
FIRECRAWL_URL = os.getenv("FIRETRACE_FIRECRAWL_URL", "http://127.0.0.1:3002")


def run(cmd, cwd=None, check=True):
    print("+", " ".join(map(str, cmd)))
    return subprocess.run(cmd, cwd=cwd, check=check)



def cdp_ready() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1.5) as res:
            return res.status == 200
    except Exception:
        return False


def ensure_chrome_cdp() -> None:
    if cdp_ready():
        print("Chrome CDP already ready on 127.0.0.1:9222.")
        return
    if os.name != "nt":
        return

    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    chrome = next((p for p in candidates if p.is_file()), None)
    if not chrome:
        print("Chrome not found; Playwright will launch its own browser if installed.")
        return

    profile = RUNTIME / "chrome-profile"
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        [
            str(chrome),
            "--remote-debugging-port=9222",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while time.time() < deadline:
        if cdp_ready():
            print("Chrome CDP ready.")
            return
        time.sleep(0.5)
    print("Chrome started but CDP did not answer; Playwright fallback will be attempted.")

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
        if os.getenv("FIRETRACE_BROWSER_BACKEND", "local").lower() == "firecrawl":
            ensure_firecrawl()
        else:
            ensure_chrome_cdp()
        control_url = os.getenv("FIRETRACE_CONTROL_URL") or os.getenv("CF_CONTROL_URL")
        control_token = os.getenv("FIRETRACE_CONTROL_TOKEN") or os.getenv("CF_CONTROL_TOKEN")
        if control_url and control_token:
            print("Cloudflare WSS transport enabled.")
            from .cloudflare_agent import main as cloudflare_main
            cloudflare_main()
        else:
            print("Cloudflare credentials not found; using GitHub polling fallback.")
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
