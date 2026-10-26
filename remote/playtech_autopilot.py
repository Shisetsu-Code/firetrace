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

from PIL import Image, ImageStat
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
# Coordinates reviewed against archived 1280x720 FUN screenshots (2026-10-25).
# The UNTIL FEATURE item is not at the same height in every Playtech UI.
UNTIL_FEATURE = {
    "ashadv": (796, 452),
    "ftsis": (911, 581),
    "gpas_aogggriffin_pop": (825, 439),
    "aogmt": (789, 505),
    "aogroo": (794, 540),
    "gpas_gstorm2_pop": (835, 505),
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
    path = re.sub(r"(/socket\.io/\d+/websocket/)[^/]+", r"\1{session}", parsed.path)
    return f"{parsed.scheme}://{parsed.hostname}{path}" + ("?" + "&".join(qs) if qs else "")


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
    # Playtech also announces a true feature with 'YOU WIN 8 FREE GAMES'
    # or a free-games counter; earlier regex missed both visible screens.
    free_games = bool(re.search(
        r"\b(?:YOU\s+(?:HAVE\s+)?(?:WIN|WON)\s+)?\d{1,2}\s+FREE\s+(?:GAMES|SPINS)\b",
        text, re.I,
    ))
    return {"text": text[:1800], "feature": bool(FEATURE.search(text) or free_games),
            "finish": bool(END.search(text)),
            "power_unavailable": "Not available" in text or "NOT AVAILABLE" in text.upper()}


def autoplay_stopped_popup(png: Path) -> bool:
    """Verify a real legacy autoplay-repeat modal in the fixed 1280x720 viewport.

    Archive 40232112481/aogroo/00067-poll.jpg shows that global --psm 11
    skipped the modal text, despite an unmistakable stopped/repeat prompt.
    This tight crop --psm 6 and paired green YES/red NO guard prevents
    confusing a game HUD's 'AUTOPLAY' text with a dismissible dialog.
    """
    with Image.open(png) as im:
        rgb = im.convert("RGB")
        caption = rgb.crop((445, 275, 842, 365))
        label = pytesseract.image_to_string(caption, config="--psm 6").upper()
        yes = ImageStat.Stat(rgb.crop((470, 411, 628, 443))).mean
        no = ImageStat.Stat(rgb.crop((660, 411, 817, 443))).mean
    return (all(word in label for word in ("AUTOPLAY", "STOPPED", "REPEAT"))
            and yes[1] > yes[0] * 1.25 and yes[1] > yes[2] * 1.1
            and no[0] > no[1] * 1.4 and no[0] > no[2] * 1.4)



def known_finished_feature_modal(game: str, png: Path) -> bool:
    """Verify archived FUN result modal (not just a free-games introduction).

    Evidence: 40231711671/ashadv/00199-poll.jpg and
    gpas_aogggriffin_pop/00422-feature.jpg. Buttons were missed by OCR.
    """
    if game not in ("ashadv", "gpas_aogggriffin_pop"):
        return False
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        if game == "ashadv":
            title_crop = rgb.crop((390, 115, 895, 555))
            button_crop = rgb.crop((560, 470, 720, 548))
        else:
            title_crop = rgb.crop((290, 160, 997, 512))
            button_crop = rgb.crop((545, 470, 735, 507))
        title = pytesseract.image_to_string(title_crop, config="--psm 11").upper()
        button = pytesseract.image_to_string(button_crop, config="--psm 7").upper()
    if "CONTINUE" not in button:
        return False
    if game == "ashadv":
        return ("YOU'VE WON" in title or "YOUVE WON" in title) and (
            "CONGRAT" in title or "CONGAT" in title or "CONGRAL" in title
        )
    return all(x in title for x in ("CONGRATULATIONS", "YOU WON", "FREE GAMES"))




def rulers_bonus_intro(png: Path) -> bool:
    """Detect the *earned* Rulers of Olympus Battle for Power intro.

    Archived FUN 40233535136/aogroo/_current.png: text and yellow
    CONTINUE coexist at 1280x720 after base game rounds, not in the
    initial startup splash. Global OCR missed the clickable label.
    """
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        text_crop = rgb.crop((335, 202, 960, 465))
        button_crop = rgb.crop((881, 485, 1019, 512)).convert("L")
        button_crop = button_crop.resize((button_crop.width * 4, button_crop.height * 4))
        title = pytesseract.image_to_string(text_crop, config="--psm 6").upper()
        button = pytesseract.image_to_string(button_crop, config="--psm 7").upper()
    return all(x in title for x in ("BATTLE FOR POWER", "STARTS NOW", "FREE GAMES END")) and "CONTINUE" in button



def rulers_finished_bonus_result(png: Path) -> bool:
    """Identify the earned Rulers of Olympus terminal FREE GAMES modal.

    Visual proof: 40241233787/aogroo/_current.png, text CONGRATULATIONS,
    YOU WON, DURING FREE GAMES; yellow CONTINUE at (944, 500).
    The button is stylized, so OCR needs a fourfold enlargement.
    This is a result acknowledgement, never a wager or purchase.
    """
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        title = pytesseract.image_to_string(
            rgb.crop((340, 130, 960, 465)), config="--psm 6",
        ).upper()
        button = rgb.crop((846, 467, 1039, 533))
        button = button.resize((button.width * 4, button.height * 4))
        label = pytesseract.image_to_string(button, config="--psm 7").upper()
    return (all(x in title for x in ("CONGRATULATIONS", "YOU WON", "DURING FREE GAMES"))
            and "CONTINUE" in label)


def ash_tea_party_bonus_intro(png: Path) -> bool:
    """Recognize the earned Ash Advantage Tea Party Bonus START overlay.

    Visual proof: 40241535898/ashadv/_current.png; repeated base spins were
    sent to this blocking modal. Starting an earned FUN bonus is not a buy.
    Avoid guessing subsequent character-choice coordinates.
    """
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        title = pytesseract.image_to_string(
            rgb.crop((275, 160, 1030, 445)), config="--psm 6",
        ).upper()
        button = rgb.crop((659, 465, 966, 526))
        button = button.resize((button.width * 4, button.height * 4))
        label = pytesseract.image_to_string(button, config="--psm 7").upper()
    return (all(x in title for x in ("SELECT CHARACTERS TO DRINK TEA",
                                      "THE LONGER THEY DRINK", "JACKPOT"))
            and "START" in label)


def midas_earned_spin_ready(png: Path) -> bool:
    """Mighty Midas earned Amethyst Spins needs a manual SPIN after OK.

    Archived 40231711671/aogmt/00239-after-amethyst-ok.jpg and 00361-poll.jpg
    retain a magenta AMETHYST SPINS banner with a green SPIN (979,559).
    The intro/result modal has no banner and must never be clicked here.
    """
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        band = list(rgb.crop((482, 83, 804, 117)).getdata())
        magenta = sum(
            1 for r, g, b in band
            if r > 100 and b > 70 and r > g * 1.3 and b > g * 1.3
        ) / len(band)
        button = rgb.crop((930, 514, 1041, 604))
        button = button.resize((button.width * 4, button.height * 4))
        label = pytesseract.image_to_string(button, config="--psm 6").upper()
    return magenta > 0.11 and "SPIN" in label


def midas_earned_emerald_intro(png: Path) -> bool:
    """Identify earned EMERALD BONUS OK; no bet or purchase.

    Proof: 40246749884/12619273713/aogmt/_current.png.
    Require caption and green button because global OCR misses OK.
    """
    with Image.open(png) as image:
        rgb = image.convert("RGB")
        title = pytesseract.image_to_string(
            rgb.crop((290, 130, 985, 401)), config="--psm 6",
        ).upper()
        pixels = list(rgb.crop((606, 426, 670, 478)).getdata())
        green = sum(
            1 for r, g, b in pixels
            if g > 65 and g > r * 1.24 and g > b * 1.10
        ) / len(pixels)
    return (all(s in title for s in ("CONGRATULATIONS", "EMERALD", "BONUS", "REVEAL"))
            and green > 0.35)

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
        self.autoplay_repeats = 0
        self.midas_feature_steps = 0
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
             "autoplay_repeats": self.autoplay_repeats,
             "midas_feature_steps": self.midas_feature_steps,
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
            elif self.game in UNTIL_FEATURE:
                # Each coordinate is independently verified from the matching
                # autoplay menu screenshot. A uniform -137px offset accidentally
                # selected 25/50 spins in classic games and no feature mode.
                await page.wait_for_timeout(700)
                await self.shot(page, "pre-until-feature", save=True)
                await self.click(page, UNTIL_FEATURE[self.game], "select_verified_until_feature")
                await page.wait_for_timeout(1250)
                await self.shot(page, "after-until-feature", save=True)
                # God of Storms 2 uses a separate play-arrow to begin the
                # chosen until-feature mode; classic menus auto-start on select.
                # Never click a purchase control or a second play-arrow here.
                if self.game == "gpas_gstorm2_pop" and self.visual_delta < 5:
                    await self.click(page, SPIN[self.game], "start_selected_until_feature")
                    await page.wait_for_timeout(1400)
                    await self.shot(page, "after-autoplay-start", save=True)
            elif self.game in ("gpas_agstorm3_pop", "gpas_mgaogkol_pop"):
                # Screenshots show long-press creates an AUTOPLAY OPTIONS modal.
                # Previous runner opened that modal but never pressed START.
                ax, ay = AUTOPLAY[self.game]
                await page.mouse.move(ax, ay)
                await page.mouse.down()
                await page.wait_for_timeout(1300)
                await self.shot(page, "autoplay-held", save=True)
                await page.mouse.up()
                await page.wait_for_timeout(600)
                words, state = await self.shot(page, "autoplay-options", save=True)
                self.note("LONG_PRESS", f"HOLD_FOR_AUTOPLAY at ({ax},{ay})")
                # Stable menu action, verified visually in archived FUN screens.
                target = (640, 424) if self.game == "gpas_agstorm3_pop" else (640, 374)
                await self.click(page, target, "start_native_autoplay_from_options")
                await page.wait_for_timeout(1800)
                await self.shot(page, "after-autoplay-start", save=True)
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
                # 40241233787 reached an earned Battle for Power FINAL
                # result (€17.15 during Free Games) but never clicked CONTINUE.
                # Require two 2-second-separated observations before one
                # result acknowledgement, then prove return to the FUN board.
                if (self.game == "aogroo"
                        and rulers_finished_bonus_result(self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "verify-rulers-finished-result", save=True)
                    if not rulers_finished_bonus_result(self.dir / "_current.png"):
                        self.note("RESULT_UNSTABLE", "Rulers result vanished before acknowledgement")
                        continue
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.note("FEATURE_RESULT", "Rulers earned FREE GAMES result observed twice; no buy")
                    await self.click(page, (944, 500), "verified_rulers_finished_bonus_continue_once")
                    self.last_feature_action = "rulers_result_continue"
                    confirmed_return = False
                    for i in range(3):
                        await page.wait_for_timeout(2400)
                        _, back = await self.shot(page, f"rulers-result-return-{i}", save=True)
                        result_still_visible = rulers_finished_bonus_result(self.dir / "_current.png")
                        hud = back["text"].upper()
                        if (not result_still_visible and
                                any(word in hud for word in
                                    ("TOTAL BET", "AUTOPLAY", "UNTIL FEATURE", "SPIN"))):
                            confirmed_return = True
                            break
                    if confirmed_return:
                        self.feature_finished = True
                        self.stage = "feature_complete"
                        self.note("FEATURE_COMPLETE",
                                  "Rulers result acknowledged exactly once and FUN board returned")
                        await self.checkpoint("feature_complete", force=True)
                        return
                    self.stage = "needs_review"
                    self.note("RESULT_RETURN_UNCERTAIN",
                              "One Rulers result acknowledgement; no verified FUN board return")
                    await self.checkpoint("result_needs_review", force=True)
                    return
                # 40241535898 stopped on a real Tea Party Bonus START modal.
                # Do NOT keep wagering into it: verify twice and START the
                # already-earned feature exactly once. Character picks require
                # new visual evidence, never guessed coordinates.
                if (self.game == "ashadv"
                        and self.last_feature_action != "ash_tea_party_start"
                        and ash_tea_party_bonus_intro(self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "verify-ash-tea-party-intro", save=True)
                    if not ash_tea_party_bonus_intro(self.dir / "_current.png"):
                        self.note("BONUS_INTRO_UNSTABLE", "Ash bonus START vanished")
                        continue
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.stage = "feature_observed"
                    await self.click(page, (809, 494), "verified_FUN_ash_tea_party_start_once")
                    self.last_feature_action = "ash_tea_party_start"
                    fallback = False
                    await page.wait_for_timeout(2300)
                    await self.shot(page, "after-ash-tea-party-start", save=True)
                    if ash_tea_party_bonus_intro(self.dir / "_current.png"):
                        self.stage = "needs_review"
                        self.note("BONUS_START_UNCERTAIN", "Ash START clicked once; intro still visible")
                        await self.checkpoint("bonus_needs_review", force=True)
                        return
                    self.note("BONUS_ACK", "Ash Tea Party earned bonus started; observe choices")
                    await self.checkpoint(force=True)
                    continue
                # 40246749884 stalled on a positively identified, earned
                # Emerald Bonus OK overlay. Two screenshots guard this
                # non-purchase acknowledgement; never repeat uncertain OK.
                if (self.game == "aogmt"
                        and self.last_feature_action != "midas_emerald_ok"
                        and midas_earned_emerald_intro(self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "verify-midas-emerald-intro", save=True)
                    if not midas_earned_emerald_intro(self.dir / "_current.png"):
                        self.note("EMERALD_UNSTABLE", "Earned modal not stable on second screenshot")
                        continue
                    if not ("real=0" in page.url or "preferedmode=offline" in page.url):
                        self.stage = "needs_review"
                        self.note("BLOCKED", "Cannot prove FUN before bonus OK")
                        await self.checkpoint("blocked_mode", force=True)
                        return
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.stage = "feature_observed"
                    await self.click(page, (640, 454), "verified_earned_FUN_midas_emerald_OK_once")
                    self.last_feature_action = "midas_emerald_ok"
                    await page.wait_for_timeout(2400)
                    await self.shot(page, "after-midas-emerald-OK", save=True)
                    if midas_earned_emerald_intro(self.dir / "_current.png"):
                        self.stage = "needs_review"
                        self.note("EMERALD_ACK_UNCERTAIN", "Clicked earned OK once; modal remains")
                        await self.checkpoint("emerald_uncertain", force=True)
                        return
                    self.note("EMERALD_ACK", "Earned bonus intro dismissed; choices/payout not yet verified")
                    await self.checkpoint(force=True)
                    continue
                # 40231711671/aogmt: the 3 AMETHYST SPINS intro was
                # acknowledged, but the earned feature retained green SPIN
                # for 900s. Its separate spins are not autoplayed. We only
                # click when both the magenta bonus banner and green SPIN
                # remain stable in two screenshots; maximum 3 verified steps.
                if (self.game == "aogmt" and self.feature_seen
                        and self.midas_feature_steps < 3
                        and midas_earned_spin_ready(self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "revalidate-midas-earned-spin", save=True)
                    if (not midas_earned_spin_ready(self.dir / "_current.png")
                            or self.visual_delta > 3):
                        self.note("AMETHYST_UNSTABLE", "No stable earned bonus spin control")
                        continue
                    if not ("real=0" in page.url or "preferedmode=offline" in page.url):
                        self.stage = "needs_review"
                        self.note("BLOCKED", "Cannot prove FUN mode before earned spin")
                        await self.checkpoint("blocked_mode", force=True)
                        return
                    before = self.previous_pixels
                    before_net = self.network_events
                    await self.click(page, (979, 559), "verified_Midas_earned_amethyst_spin")
                    await page.wait_for_timeout(1800)
                    await self.shot(page, "after-amethyst-spin", save=True)
                    first_delta = self.visual_delta
                    await page.wait_for_timeout(2200)
                    await self.shot(page, "settle-amethyst-spin", save=True)
                    final_delta = (sum(abs(a-b) for a,b in zip(before, self.previous_pixels))
                                   / len(before)) if before else 0
                    if max(first_delta, final_delta) <= 5 and self.network_events == before_net:
                        self.stage = "needs_review"
                        self.note("AMETHYST_RESULT_UNCERTAIN",
                                  "One earned spin clicked, no definitive gameplay change; do not retry")
                        await self.checkpoint("amethyst_uncertain", force=True)
                        return
                    self.midas_feature_steps += 1
                    self.stage = "feature_observed"
                    self.feature_since = time.monotonic()
                    self.note("AMETHYST_SPIN",
                              f"Earned spin #{self.midas_feature_steps} caused observed reel/network change")
                    await self.checkpoint(force=True)
                    continue
                # Run 40233535136 stopped on an earned Battle for Power
                # intro. It is NOT a bet/purchase; only the yellow CONTINUE
                # may be acknowledged after two independent observations.
                if (self.game == "aogroo"
                        and self.last_feature_action != "rulers_battle_intro_continue"
                        and rulers_bonus_intro(self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "verify-rulers-bonus-intro", save=True)
                    if not rulers_bonus_intro(self.dir / "_current.png"):
                        self.note("BONUS_INTRO_UNSTABLE", "Rulers intro vanished before input")
                        continue
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.stage = "feature_observed"
                    await self.click(page, (950, 500), "verified_FUN_rulers_bonus_continue_once")
                    self.last_feature_action = "rulers_battle_intro_continue"
                    await page.wait_for_timeout(2300)
                    await self.shot(page, "after-rulers-bonus-continue", save=True)
                    if rulers_bonus_intro(self.dir / "_current.png"):
                        self.stage = "needs_review"
                        self.note("BONUS_INTRO_UNCERTAIN", "One CONTINUE input; modal still visible")
                        await self.checkpoint("bonus_needs_review", force=True)
                        return
                    self.note("BONUS_ACK", "Rulers earned bonus intro disappeared; bonus outcome still unverified")
                    await self.checkpoint(force=True)
                    continue
                # Two verified modal controls from run 40221846216, NOT purchase buttons.
                # Midas: screenshot 00160-feature.jpg shows AMETHYST SPINS and
                # a green OK at (640, 455). Observe twice 2s apart before click.
                if (self.game == "aogmt" and "AMETHYST SPINS" in state["text"].upper()
                        and "CONGRATULATIONS" in state["text"].upper()
                        and self.last_feature_action != "midas_amethyst_ok"):
                    await page.wait_for_timeout(2000)
                    _, checked = await self.shot(page, "verify-amethyst-modal", save=True)
                    if ("AMETHYST SPINS" in checked["text"].upper()
                            and "CONGRATULATIONS" in checked["text"].upper()):
                        await self.click(page, (640, 455), "verified_amethyst_spins_ok")
                        self.last_feature_action = "midas_amethyst_ok"
                        await page.wait_for_timeout(2000)
                        await self.shot(page, "after-amethyst-ok", save=True)
                        self.note("BONUS_ACK", "Mighty Midas Amethyst Spins intro acknowledged; awaiting actual bonus completion")
                        await self.checkpoint(force=True)
                    continue
                # King of Olympus: screenshot 00164-feature.jpg shows a terminal
                # FEATURE WIN screen and a play-arrow at (1175,360). Verify two
                # observations and require the summary screen to disappear.
                if (self.game == "gpas_mgaogkol_pop" and "FEATURE WIN" in state["text"].upper()
                        and self.last_feature_action != "king_feature_win_arrow"):
                    await page.wait_for_timeout(2000)
                    _, checked = await self.shot(page, "verify-king-feature-win", save=True)
                    if "FEATURE WIN" in checked["text"].upper():
                        self.note("FEATURE_RESULT", "King of Olympus Megaways: FEATURE WIN summary visible")
                        await self.click(page, (1175, 360), "verified_feature_win_continue")
                        self.last_feature_action = "king_feature_win_arrow"
                        await page.wait_for_timeout(2300)
                        _, after = await self.shot(page, "after-feature-win", save=True)
                        if "FEATURE WIN" not in after["text"].upper() and self.visual_delta > 5:
                            self.feature_finished = True
                            self.stage = "feature_complete"
                            self.note("FEATURE_COMPLETE", "Visible FEATURE WIN summary acknowledged; FUN board returned")
                            await self.checkpoint("feature_complete", force=True)
                            return
                        self.stage = "needs_review"
                        self.note("FEATURE_RESULT_UNCERTAIN", "Arrow clicked once; no unambiguous board return")
                        await self.checkpoint("feature_needs_review", force=True)
                        return
                # Previously captured FUN bonus result dialog, not a new wager.
                # Check two independently acquired screenshots 2 seconds apart.
                if (self.game in ("ashadv", "gpas_aogggriffin_pop")
                        and self.last_feature_action != "known_result_continue"
                        and known_finished_feature_modal(self.game, self.dir / "_current.png")):
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "verify-result-modal", save=True)
                    if not known_finished_feature_modal(self.game, self.dir / "_current.png"):
                        self.note("FEATURE_RESULT_UNSTABLE", "Modal not identical on second observation")
                        continue
                    target = (640, 507) if self.game == "ashadv" else (640, 489)
                    self.feature_seen = True
                    self.feature_since = self.feature_since or time.monotonic()
                    self.note("FEATURE_RESULT", "Finished FUN bonus result and CONTINUE verified twice")
                    await self.click(page, target, "acknowledge_finished_FUN_feature_once")
                    self.last_feature_action = "known_result_continue"
                    await page.wait_for_timeout(2500)
                    _, returned1 = await self.shot(page, "after-result-continue", save=True)
                    await page.wait_for_timeout(2300)
                    _, returned2 = await self.shot(page, "verify-base-return", save=True)
                    still_modal = known_finished_feature_modal(self.game, self.dir / "_current.png")
                    on_board = (("SPIN" in returned1["text"].upper() or "SPIN" in returned2["text"].upper())
                                if self.game == "ashadv" else
                                ("PLAYING FOR FUN" in returned1["text"].upper()
                                 or "PLAYING FOR FUN" in returned2["text"].upper()))
                    if not still_modal and on_board:
                        self.feature_finished = True
                        self.stage = "feature_complete"
                        self.note("FEATURE_COMPLETE", "Result acknowledged once and returned to observed FUN board")
                        await self.checkpoint("feature_complete", force=True)
                        return
                    self.stage = "needs_review"
                    self.note("FEATURE_RESULT_UNCERTAIN", "One CONTINUE input; no unambiguous board return")
                    await self.checkpoint("feature_needs_review", force=True)
                    return
                if self.feature_seen and state["finish"]:
                    self.feature_finished = True
                    self.stage = "feature_complete"
                    await self.checkpoint("feature_complete", force=True)
                    return
                if self.feature_seen:
                    # A new board can legitimately show Continue in the same place
                    # on successive free games. Reset the dedupe key only after a
                    # significant visual transition has been observed.
                    if self.visual_delta > 8:
                        self.last_feature_action = None
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
                    if self.feature_since and time.monotonic()-self.feature_since > 900:
                        self.stage = "needs_review"
                        self.note("FEATURE_STALLED", "Bonus did not reach a verified end in 900 seconds")
                        await self.checkpoint("feature_needs_review", force=True)
                        return
                    await self.checkpoint()
                    continue
                # Click only the twice-verified stopped/repeat modal.
                # Global screenshot OCR omits the dialog in aogroo; a dedicated
                # crop and green YES / red NO guard is required before input.
                if self.game in ("ftsis", "aogroo", "ashadv") and autoplay_stopped_popup(self.dir / "_current.png"):
                    if self.autoplay_repeats >= 4:
                        self.stage = "needs_review"
                        self.note("REPEAT_LIMIT", "Four FUN autoplay confirmations reached")
                        await self.checkpoint("repeat_limit", force=True)
                        return
                    await page.wait_for_timeout(2000)
                    await self.shot(page, "revalidate-autoplay-stopped", save=True)
                    if not autoplay_stopped_popup(self.dir / "_current.png"):
                        self.note("REPEAT_NOT_STABLE", "Modal did not survive two-second independent verification")
                        continue
                    await self.click(page, (544, 426), "verified_repeat_FUN_autoplay_yes")
                    self.autoplay_repeats += 1
                    await page.wait_for_timeout(2500)
                    await self.shot(page, "after-autoplay-repeat", save=True)
                    if autoplay_stopped_popup(self.dir / "_current.png"):
                        self.stage = "needs_review"
                        self.note("REPEAT_UNCERTAIN", "Clicked YES once; modal remains visible")
                        await self.checkpoint("repeat_uncertain", force=True)
                        return
                    self.stage = "running"
                    fallback = False
                    last_activity = time.monotonic()
                    self.note("REPEAT_REQUESTED", "Verified FUN repeat dialog dismissed; round outcome still unverified")
                    await self.checkpoint(force=True)
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
                # HUD clocks and balances vary even with stopped reels; they are
                # not proof that autoplay is active. Track the reel region only.
                if self.visual_delta > 5:
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
            if self.stage not in ("needs_review", "action_limit"):
                self.stage = "time_limit"
            await self.checkpoint(self.stage, force=True)
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
    # Honor the allowlist so a subsequent recovery can target only unfinished
    # games, rather than accidentally restarting all ten after an audit update.
    requested = config.get("games", IDS)
    if not isinstance(requested, list) or not all(isinstance(g, str) and g in IDS for g in requested):
        raise ValueError("Invalid Playtech game allowlist")
    assigned = [game for i, game in enumerate(IDS) if i % groups == group and game in requested]
    if os.getenv("PLAYTECH_ONLY"):
        assigned = [game for game in IDS if game == os.environ["PLAYTECH_ONLY"] and game in requested]
    print(json.dumps({"runner": RUN, "group": group, "games": assigned}), flush=True)
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        tasks = [asyncio.create_task(Probe(game).run(browser, limit)) for game in assigned]
        await asyncio.gather(*tasks)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
