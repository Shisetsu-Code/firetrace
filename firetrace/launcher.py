from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from .runtime import load_user_environment, quiet_process_options


def find_repo_root() -> Path:
    candidates = []
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent)
    candidates.extend(
        [
            Path(__file__).resolve().parents[1],
            Path.cwd(),
            Path.home() / "firetrace",
            Path.home() / "Firetrace",
        ]
    )
    for candidate in candidates:
        if (candidate / ".git").exists() and (candidate / "pyproject.toml").exists():
            return candidate
    return candidates[0]


ROOT = find_repo_root()
RUNTIME = ROOT / ".runtime"
FIRECRAWL_DIR = RUNTIME / "firecrawl"
FIRECRAWL_REF = os.getenv("FIRETRACE_FIRECRAWL_REF", "v2.11.0")
FIRECRAWL_URL = os.getenv("FIRETRACE_FIRECRAWL_URL", "http://127.0.0.1:3002")


def run(cmd, cwd=None, check=True, **kwargs):
    print("+", " ".join(map(str, cmd)))
    options = quiet_process_options()
    options.update(kwargs)
    return subprocess.run(cmd, cwd=cwd, check=check, **options)


def cdp_ready() -> bool:
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:9222/json/version", timeout=1.5
        ) as res:
            return res.status == 200
    except Exception:
        return False


def _browser_candidates() -> list[Path]:
    program_files = Path(os.environ.get("PROGRAMFILES", ""))
    program_files_x86 = Path(os.environ.get("PROGRAMFILES(X86)", ""))
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    return [
        program_files / "Google/Chrome/Application/chrome.exe",
        program_files_x86 / "Google/Chrome/Application/chrome.exe",
        local / "Google/Chrome/Application/chrome.exe",
        program_files / "Microsoft/Edge/Application/msedge.exe",
        program_files_x86 / "Microsoft/Edge/Application/msedge.exe",
        local / "Microsoft/Edge/Application/msedge.exe",
    ]


def ensure_chrome_cdp() -> None:
    if cdp_ready():
        print("Browser CDP already ready on 127.0.0.1:9222.")
        return
    if os.name != "nt":
        return

    browser = next((path for path in _browser_candidates() if path.is_file()), None)
    if not browser:
        print("Chrome/Edge not found; Playwright Chromium fallback will be used.")
        return

    RUNTIME.mkdir(parents=True, exist_ok=True)
    profile = RUNTIME / "browser-profile"
    profile.mkdir(parents=True, exist_ok=True)

    subprocess.Popen(
        [
            str(browser),
            "--remote-debugging-port=9222",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **quiet_process_options(),
    )

    deadline = time.time() + 20
    while time.time() < deadline:
        if cdp_ready():
            print("Browser CDP ready.")
            return
        time.sleep(0.5)

    print("Browser started but CDP did not answer; Playwright fallback will be attempted.")


def healthy() -> bool:
    for path in ("/", "/health"):
        try:
            with urllib.request.urlopen(
                FIRECRAWL_URL.rstrip("/") + path, timeout=2
            ) as res:
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
        run(
            [
                "git",
                "clone",
                "--depth",
                "1",
                "--branch",
                FIRECRAWL_REF,
                "https://github.com/firecrawl/firecrawl.git",
                str(FIRECRAWL_DIR),
            ]
        )

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


def run_local_mcp(stop_event: threading.Event | None = None) -> None:
    if os.getenv("FIRETRACE_BROWSER_BACKEND", "local").lower() == "firecrawl":
        raise RuntimeError(
            "The direct local MCP uses the Playwright/CDP backend. "
            "Unset FIRETRACE_BROWSER_BACKEND or set it to local."
        )

    ensure_chrome_cdp()

    from .local_browser import LocalBrowserBackend
    from .local_mcp import bridge_from_environment

    backend = LocalBrowserBackend(
        os.getenv("FIRETRACE_CDP_URL", "http://127.0.0.1:9222")
    )
    bridge = bridge_from_environment(backend)

    try:
        bridge.run(stop_event=stop_event)
    finally:
        backend.close()


def main(stop_event: threading.Event | None = None) -> int:
    try:
        load_user_environment()
        transport = os.getenv("FIRETRACE_TRANSPORT", "local").strip().lower()

        if stop_event and stop_event.is_set():
            return 0

        if transport == "local":
            print("Firetrace direct local MCP enabled.")
            run_local_mcp(stop_event=stop_event)
            return 0

        if os.getenv("FIRETRACE_BROWSER_BACKEND", "local").lower() == "firecrawl":
            ensure_firecrawl()
        else:
            ensure_chrome_cdp()

        if transport == "cloudflare":
            control_url = os.getenv("FIRETRACE_CONTROL_URL") or os.getenv(
                "CF_CONTROL_URL"
            )
            control_token = os.getenv("FIRETRACE_CONTROL_TOKEN") or os.getenv(
                "CF_CONTROL_TOKEN"
            )
            if not (control_url and control_token):
                raise RuntimeError(
                    "Cloudflare transport requires CF_CONTROL_URL and "
                    "CF_CONTROL_TOKEN (or Firetrace-specific overrides)."
                )
            print("Cloudflare WSS transport enabled.")
            from .cloudflare_agent import main as cloudflare_main

            cloudflare_main(stop_event=stop_event)
            return 0

        if transport == "github":
            print("Explicit GitHub transport enabled.")
            from .worker import Worker

            Worker().run(stop_event=stop_event)
            return 0

        raise RuntimeError(
            f"Unknown FIRETRACE_TRANSPORT={transport!r}; "
            "use local, cloudflare, or github."
        )

    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
