"""Bounded parallel Playtech FUN feature explorer for GitHub Actions.

Uses actual native autoplay controls, optional OCR, and network metadata.
Raw cookies/authentication and response bodies are never persisted.
An input dispatch is not evidence of a completed bonus.
"""
from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import os
import re
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl

from PIL import Image
import pytesseract
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.getenv("PLAYTECH_OUT", "/tmp/playtech-bonus-evidence"))
OUT.mkdir(parents=True, exist_ok=True)
RUN = os.getenv("GITHUB_RUN_ID", "local")
IDS = [
    "ashadv", "ftsis", "gpas_aogggriffin_pop", "aogmt", "aogroo",
    "gpas_gstorm2_pop", "gpas_agstorm3_pop", "gpas_mgaogkol_pop",
    "gpas_aogww_pop", "gpas_aogwfot_pop",
]
# Coordinates are based on verified 1280 x 720 screenshots; reobserve every action.
INTRO = {
    "gpas_aogggriffin_pop": (640, 458),
    "aogmt": (640, 585), "aogroo": (640, 590),
    "gpas_gstorm2_pop": (640, 552), "gpas_agstorm3_pop": (640, 641),
    "gpas_mgaogkol_pop": (1175, 358),
    "gpas_aogww_pop": (640, 530),
    "gpas_aogwfot_pop": (640, 631),
}
AUTOPLAY = {
    "ashadv": (797, 630),
    "ftsis": (912, 624),
    "gpas_aogggriffin_pop": (826, 575),
    "aogmt": (789, 558),
    "aogroo": (776, 589),
    "gpas_gstorm2_pop": (836, 615),
    "gpas_agstorm3_pop": (1155, 404),
    "gpas_mgaogkol_pop": (1160, 393),
    "gpas_aogww_pop": (801, 619),
    "gpas_aogwfot_pop": (1035, 631),
}
SPIN = {
    "ashadv": (997, 631), "ftsis": (1044, 638),
    "gpas_aogggriffin_pop": (960, 585),
    "aogmt": (979, 559), "aogroo": (971, 590),
    "gpas_gstorm2_pop": (1063, 618),
    "gpas_agstorm3_pop": (1148, 406),
    "gpas_mgaogkol_pop": (1156, 398),
    "gpas_aogww_pop": (986, 619),
    "gpas_aogwfot_pop": (1206, 606),
}
SENSITIVE = re.compile(r"(?:token|secret|session|cookie|auth|password|signature|jwt|key|uid|email|nonce|sid|seed|csrf)", re.I)
FEATURE = re.compile(r"\b(?:FEATURE (?:TRIGGERED|AWARDED|WIN)|BONUS (?:GAME|WON|AWARDED)|FREE (?:SPINS|GAMES) (?:AWARDED|WON|START)|CONGRATULATIONS|YOU HAVE WON \d+ FREE|PICK A|CHOOSE YOUR)\b", re.I)
END = re.compile(r"\b(?:FEATURE COMPLETE|BONUS COMPLETE|FREE GAMES COMPLETE|TOTAL BONUS WIN|CONGRATULATIONS YOU WON)\b", re.I)
CONTINUE = re.compile(r"^(?:CONTINUE|PLAY|START|NEXT|COLLECT|OK|CLOSE)$", re.I)


def iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_url(url: str) -> str:
    parsed = urlsplit(url)
    qs = sorted(set(k for k, _ in parse_qsl(parsed.query)))
    return f"{parsed.scheme}://{parsed.hostname}{parsed.path}" + ("?" + "&".join(qs) if qs else "")


def sanitize_payload(body: str, content_type: str):
    if not body or len(body) > 30000:
        return {"omitted": True, "size": len(body or "")}
    try:
        if "json" in content_type or body.lstrip().startswith(("{", "[")):
            return sanitize_json(json.loads(body))
        if "=" in body:
            return {k: "[REDACTED]" if SENSITIVE.search(k) else v[:200]
                    for k, v in parse_qsl(body, keep_blank_values=True)[:100]}
    except (ValueError, TypeError):
        pass
    return {"body_type": "opaque", "size": len(body)}


def sanitize_json(v, key=""):
    if SENSITIVE.search(str(key)):
        return "[REDACTED]"
    if isinstance(v, dict):
        return {str(k)[:80]: sanitize_json(z, str(k)) for k, z in list(v.items())[:100]}
    if isinstance(v, list):
        return [sanitize_json(z) for z in v[:50]]
    if isinstance(v, str):
        return v[:200] if len(v) < 200 and not re.search(r"(?i)(bearer |eyJ[a-zA-Z0-9_-]{15})", v) else "[REDACTED/OMITTED]"
    return v


def ocr_words(png: Path):
    # Read words and their centers; OCR is an observation, not action proof.
    data = pytesseract.image_to_data(Image.open(png), config="--psm 11",
                                    output_type=pytesseract.Output.DICT)
    words = []
    for i, text in enumerate(data["text"]):
        w = str(text or "").strip()
        if not w:
            continue
        try:
            confidence = float(data["conf"][i])
        except (ValueError, TypeError):
            continue
        if confidence < 35:
            continue
        words.append({
            "text": w,
            "x": int(data["left"][i] + data["width"][i] / 2),
            "y": int(data["top"][i] + data["height"][i] / 2),
        })
    return words


def classify(words):
    text = " ".join(x["text"] for x in words)
    return {"text": text[:1800], "feature": bool(FEATURE.search(text)),
            "finish": bool(END.search(text)),
            "power_unavailable": "Not available" in text or "NOT AVAILABLE" in text.upper()}


def record_event(path: Path, event: dict):
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps({"time": iso(), **event}, ensure_ascii=False) + "\n")


class Probe:
    def __init__(self, game: str):
        self.game = game
        self.visual_delta = 0.0
        self.previous_pixels = None
        self.dir = OUT / game
        self.dir.mkdir(parents=True, exist_ok=True)
        self.log = self.dir / "events.jsonl"
        self.net = self.dir / "network.jsonl"
        self.progress = self.dir / "progress.json"
        self.requests = Counter()
        self.websockets = 0
        self.network_events = 0
        self.observations = 0
        self.clicks = 0
        self.spin_attempts = 0
        self.feature_since = None
        self.last_feature_action = None
        self.feature_seen = False
        self.feature_finished = False
        self.stage = "starting"
        self.last_text = ""
        self.recorded_frames = 0
        self.started = time.monotonic()
        self.last_publish = 0
        self.note("INIT", "Initializes a distinct isolated browser context")

    def note(self, kind, msg):
        record_event(self.log, {"event": kind, "detail": str(msg)[:350]})

    def on_request(self, request):
        try:
            url = urlsplit(request.url)
            if not url.hostname:
                return
            # Skip static assets and third-party telemetry; retain game protocol calls.
            req_method = request.method
            path = url.path
            if req_method == "GET" and not any(x in path.lower() for x in ("api", "game", "session", "play", "spin")):
                return
            if req_method != "GET" or "playtechone.com" in url.hostname:
                self.requests[(req_method, url.hostname, path)] += 1
                if req_method != "GET":
                    headers = request.headers
                    payload = sanitize_payload(request.post_data or "", headers.get("content-type", ""))
                    record_event(self.net, {
                        "direction": "request", "method": req_method, "endpoint": safe_url(request.url),
                        "payload": payload,
                    })
                    self.network_events += 1
        except Exception as exc:
            self.note("REQUEST_CAPTURE_ERROR", type(exc).__name__)

    def on_response(self, response):
        try:
            req = response.request
            if req.method != "GET":
                record_event(self.net, {"direction": "response", "method": req.method,
                                        "endpoint": safe_url(response.url), "status": response.status})
        except Exception:
            pass

    def on_socket(self, ws):
        self.websockets += 1
        record_event(self.net, {"direction": "websocket_open", "endpoint": safe_url(ws.url)})
        def store(direction, payload):
            # Record structure only, never raw opaque binary or session credentials.
            data = payload if isinstance(payload, str) else ""
            record_event(self.net, {"direction": direction, "endpoint": safe_url(ws.url),
                                    "payload": sanitize_payload(data, "application/json") if data else {"binary": True}})
            self.network_events += 1
        ws.on("framesent", lambda p: store("ws_sent", p))
        ws.on("framereceived", lambda p: store("ws_received", p))

    async def shot(self, page, label: str, save: bool = True):
        self.observations += 1
        tmp = self.dir / "_current.png"
        await page.screenshot(path=str(tmp), full_page=False, animations="disabled", timeout=15000)
        pix = list(Image.open(tmp).crop((270, 115, 1010, 540)).convert("L").resize((32, 20)).getdata())
        if self.previous_pixels:
            self.visual_delta = sum(abs(a-b) for a,b in zip(pix, self.previous_pixels)) / len(pix)
        self.previous_pixels = pix
        # OCR is intentionally run in a thread so multiple Chromium tabs can progress.
        words = await asyncio.to_thread(ocr_words, tmp)
        state = classify(words)
        self.last_text = state["text"]
        if save:
            fname = f"{self.observations:05}-{label}.jpg"
            (self.dir / "screenshots").mkdir(exist_ok=True)
            await page.screenshot(path=str(self.dir / "screenshots" / fname), type="jpeg", quality=45)
            self.recorded_frames += 1
            record_event(self.log, {"event": "OBSERVE", "image": fname,
                                    "text": state["text"][:400], "feature": state["feature"]})
        return words, state

    async def click(self, page, xy, role, words=None):
        x, y = xy
        if x < 0 or x > 1280 or y < 0 or y > 720:
            raise ValueError("Out-of-bounds input")
        await page.mouse.click(x, y, delay=60)
        self.clicks += 1
        self.note("CLICK", f"{role} @({x},{y})")

    async def checkpoint(self, outcome=None, force=False):
        now = time.monotonic()
        if not force and now - self.last_publish < 75:
            return
        d = {"game": self.game, "stage": self.stage, "outcome": outcome,
             "feature_seen": self.feature_seen, "feature_finished": self.feature_finished,
             "observations": self.observations, "clicks": self.clicks,
             "spin_attempts": self.spin_attempts,
             "network_events": self.network_events, "websocket_connections": self.websockets,
             "requests_total": sum(self.requests.values()), "elapsed_seconds": int(now-self.started),
             "latest_text": self.last_text[:250], "run_id": RUN, "time": iso()}
        self.progress.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        self.last_publish = now
        print(json.dumps({"checkpoint": d}, ensure_ascii=False), flush=True)
        if os.getenv("GH_TOKEN"):
            await asyncio.to_thread(self.publish)
    
    def publish(self):
        # Store only sanitized status in the PUBLIC repository, not network bodies/captures.
        path = f"remote/progress/playtech/{self.game}.json"
        encoded = base64.b64encode(self.progress.read_bytes()).decode("ascii")
        for attempt in range(3):
            existing = subprocess.run(["gh", "api", f"repos/Shisetsu-Code/firetrace/contents/{path}"],
                                      capture_output=True, text=True)
            args = ["gh", "api", f"repos/Shisetsu-Code/firetrace/contents/{path}",
                    "-X", "PUT", "-f", "branch=main",
                    "-f", f"message=progress: {self.game} run {RUN} [skip ci]",
                    "-f", f"content={encoded}"]
            if existing.returncode == 0:
                args += ["-f", f"sha={json.loads(existing.stdout)['sha']}"]
            res = subprocess.run(args, capture_output=True, text=True)
            if res.returncode == 0:
                return
            time.sleep(attempt + 1)
        self.note("CHECKPOINT_PUBLISH_FAILURE", res.stderr[-150:])

    async def run(self, browser, seconds):
        url = f"https://cachedownload.playtechone.com/ngmdesktop/casinoclient.html?game={self.game}&preferedmode=offline&real=0"
        context = await browser.new_context(viewport={"width":1280,"height":720},
                                            accept_downloads=False, ignore_https_errors=False)
        page = await context.new_page()
        page.on("request", self.on_request)
        page.on("response", self.on_response)
        page.on("websocket", self.on_socket)
        try:
            self.stage = "loading"
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            words = []
            for load_try in range(25):
                await page.wait_for_timeout(3000)
                words, state = await self.shot(page, "load", save=load_try in (0, 5, 12, 24))
                if any(re.search(r"^(?:SPIN|AUTOPLAY|AUTO|START|PLAY|CONTINUE)$", w["text"], re.I)
                       and 100 < w["y"] < 680 for w in words):
                    break
            # Prior knowledge: some canvas titles don't OCR, but explicit intro geometry is verified.
            if self.game in INTRO and not any(w["text"].upper() == "SPIN" and w["y"] > 450 for w in words):
                self.stage = "intro"
                await self.click(page, INTRO[self.game], "verified_introduction")
                await page.wait_for_timeout(2500)
                words, state = await self.shot(page, "after-intro")
            self.stage = "autoplay_setup"
            await self.click(page, AUTOPLAY[self.game], "open_native_autoplay")
            await page.wait_for_timeout(650)
            words, state = await self.shot(page, "autoplay-menu")
            if self.game == "gpas_aogww_pop":
                # Visually verified: until-feature switch at x800,619, play x986,619.
                await self.click(page, SPIN[self.game], "native_until_feature_start")
            elif self.game in ("ashadv","ftsis","gpas_aogggriffin_pop","aogmt","aogroo"):
                # Playtech classic drop-down. The TOP option is "UNTIL FEATURE".
                # Measured Griffin: AUTOPLAY at (826,575), option at (826,438).
                ax, ay = AUTOPLAY[self.game]
                await self.click(page, (ax, ay-137), "select_dropdown_until_feature")
                await page.wait_for_timeout(850)
                await self.shot(page, "after-until-feature", save=True)
                # Do not click SPIN: selecting the autoplay option starts the cycle.
            elif self.game in ("gpas_gstorm2_pop","gpas_agstorm3_pop","gpas_mgaogkol_pop"):
                # New games render a large "HOLD FOR AUTOPLAY" circle. Short
                # clicks only produce a single spin. Long-press opens its menu.
                ax, ay = AUTOPLAY[self.game]
                await page.mouse.move(ax,ay)
                await page.mouse.down()
                await page.wait_for_timeout(1100)
                await self.shot(page, "autoplay-held", save=True)
                await page.mouse.up()
                self.note("LONG_PRESS", f"HOLD_FOR_AUTOPLAY at ({ax},{ay})")
                await page.wait_for_timeout(600)
                await self.shot(page, "autoplay-held-result", save=True)
            else:
                # Wheel of Olympus has a separate right-side autoplay control.
                # Observe the menu; if not running, bounded fallback takes over.
                self.note("REVIEW", "Autoplay menu inspected; avoid an unverified buy or double spin")
            await page.wait_for_timeout(2200)
            self.stage = "running"
            words, state = await self.shot(page, "run")
            previous_screenshot = state["text"]
            last_activity = time.monotonic()
            fallback = False
            failed_inputs = 0
            while time.monotonic()-self.started < seconds:
                await page.wait_for_timeout(2500 if fallback else 4500)
                words, state = await self.shot(page, "poll", save=self.observations%6 == 0)
                if state["feature"]:
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.stage = "feature_observed"
                    await self.shot(page, "feature", save=True)
                    self.note("FEATURE", state["text"][:300])
                    # Never send a base wager while a feature or choice is active.
                    fallback = False
                if self.feature_seen and state["finish"]:
                    self.feature_finished = True
                    self.stage = "feature_complete"
                    await self.checkpoint("feature_complete", force=True)
                    return
                if self.feature_seen:
                    # Only use a visible, stable and positively identified bonus
                    # Continue/Play control, never guessed coordinates or buys.
                    candidates = [w for w in words if CONTINUE.fullmatch(w["text"])
                                  and 180 < w["y"] < 660 and 140 < w["x"] < 1140]
                    if candidates:
                        target = candidates[0]
                        key = (target["text"].upper(), target["x"]//20, target["y"]//20)
                        if key != self.last_feature_action:
                            await page.wait_for_timeout(2000)
                            verified, _ = await self.shot(page, "revalidate-feature", save=False)
                            still = any(q["text"].upper() == target["text"].upper()
                                        and abs(q["x"]-target["x"]) < 18
                                        and abs(q["y"]-target["y"]) < 18 for q in verified)
                            if still:
                                await self.click(page, (target["x"],target["y"]), "confirmed_feature_continue")
                                self.last_feature_action = key
                                await self.shot(page, "after-feature-action", save=True)
                    if self.feature_since and time.monotonic()-self.feature_since > 300:
                        self.stage = "needs_review"
                        self.note("FEATURE_STALLED", "Bonus did not reach a verified end in 300 seconds")
                        await self.checkpoint("feature_needs_review", force=True)
                        return
                    await self.checkpoint()
                    continue
                if fallback:
                    # We only run manual fallback in the official, explicit FUN/offline game.
                    if not ("real=0" in page.url or "preferedmode=offline" in page.url):
                        self.note("BLOCKED", "Offline FUN mode not proven; no further input")
                        self.stage = "needs_review"
                        break
                    if self.spin_attempts >= 750:
                        self.stage = "action_limit"
                        break
                    before_net = self.network_events
                    previous_signature = self.previous_pixels
                    await self.click(page, SPIN[self.game], "FUN_spin_fallback")
                    await page.wait_for_timeout(2400)
                    _, after = await self.shot(page, "after-fallback", save=self.spin_attempts%8 == 0)
                    # Additional 2-second observation prevents repeating a still-animating round.
                    await page.wait_for_timeout(2200)
                    _, settled = await self.shot(page, "settle-fallback", save=False)
                    self.spin_attempts += 1
                    changed_from_before = bool(previous_signature and self.previous_pixels and
                        sum(abs(a-b) for a,b in zip(previous_signature,self.previous_pixels))/len(previous_signature) > 5)
                    moved = self.network_events > before_net or changed_from_before
                    if not moved:
                        failed_inputs += 1
                    else:
                        failed_inputs = 0
                    if after["feature"] or settled["feature"]:
                        self.feature_seen = True
                        self.feature_since = self.feature_since or time.monotonic()
                        self.stage = "feature_observed"
                        self.note("FEATURE", settled["text"][:300])
                        await self.shot(page, "feature", save=True)
                        fallback = False
                    if failed_inputs >= 3:
                        self.stage = "needs_review"
                        self.note("UNVERIFIED_SPINS", "Three inputs without observable gameplay change")
                        break
                    await self.checkpoint()
                    continue
                if state["text"] != previous_screenshot or self.visual_delta > 5:
                    last_activity = time.monotonic()
                    previous_screenshot = state["text"]
                if time.monotonic()-last_activity > 60:
                    # Native autoplay wasn't continuing; revalidated static FUN surface,
                    # so switch to one explicit spin at a time with network checks.
                    fallback = True
                    self.stage = "bounded_base_spin_fallback"
                    self.note("FALLBACK", "Native autoplay inactive; verify each FUN spin")
                    await self.shot(page, "fallback-start", save=True)
                    await self.checkpoint(force=True)
                else:
                    await self.checkpoint()
            self.stage = "time_limit"
            await self.checkpoint("time_limit", force=True)
        except Exception as exc:
            self.stage = "error"
            self.note("EXCEPTION", f"{type(exc).__name__}: {str(exc)[:180]}")
            try:
                await self.shot(page, "error", save=True)
            except Exception:
                pass
            await self.checkpoint("error", force=True)
        finally:
            await self.checkpoint(self.stage, force=True)
            await context.close()


async def main():
    config_path = ROOT / "remote" / "playtech-bonus-batch.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    group = int(os.getenv("PLAYTECH_GROUP", "0"))
    groups = int(os.getenv("PLAYTECH_GROUPS", "4"))
    limit = max(30, min(6000, int(config.get("seconds_per_game", 3600))))
    assigned = [game for i, game in enumerate(IDS) if i % groups == group]
    if os.getenv("PLAYTECH_ONLY"):
        assigned = [game for game in IDS if game == os.environ["PLAYTECH_ONLY"]]
    print(json.dumps({"runner": RUN, "group": group, "games": assigned}), flush=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        tasks = [asyncio.create_task(Probe(game).run(browser, limit)) for game in assigned]
        await asyncio.gather(*tasks)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
