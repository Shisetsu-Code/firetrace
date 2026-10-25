"""One-shot, no-purchase FUN Ante Bet probe for Playtech Wheels of Olympus.

The source evidence is run 40221846216, screenshot 00027-autoplay-menu.jpg.
Only one toggle and at most one DEMO spin; unverified state stops all input.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from PIL import Image, ImageChops, ImageStat, ImageFilter
import pytesseract
from playwright.async_api import async_playwright

from playtech_autopilot import OUT, Probe

GAME = "gpas_aogwfot_pop"
URL = (
    "https://cachedownload.playtechone.com/ngmdesktop/casinoclient.html"
    "?game=gpas_aogwfot_pop&preferedmode=offline&real=0"
)
PANEL = (87, 275, 294, 510)
# Separate text crops; ornate full-panel backgrounds cause unreliable OCR.
ANTE_LABEL = (97, 386, 280, 439)
ANTE_STATE = (194, 441, 288, 484)
REELS = (320, 198, 942, 589)


def difference(a: Image.Image, b: Image.Image) -> float:
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    return sum(ImageStat.Stat(d).mean) / 3.0


def crop(path: Path, rect) -> Image.Image:
    return Image.open(path).convert("RGB").crop(rect)


def read_panel(path: Path) -> str:
    """Read the Ante caption and OFF/ON state separately.

    Visually verified on 40232541630/00027-before-ante-toggle.jpg.
    Full-panel OCR missed both labels while this grayscale crop reads them.
    """
    def text(rect, psm):
        im = crop(path, rect).convert("L")
        im = im.resize((im.width * 4, im.height * 4))
        im = im.filter(ImageFilter.UnsharpMask(radius=1.5, percent=180))
        return pytesseract.image_to_string(im, config=f"--psm {psm}").upper()

    return text(ANTE_LABEL, 6) + " STATE: " + text(ANTE_STATE, 7)


async def main():
    probe = Probe(GAME)
    probe.note("SCOPE", "Wheels of Olympus DEMO single Ante Bet toggle; no Bonus Buy")
    probe.stage = "preflight"
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = await browser.new_context(
            viewport={"width": 1280, "height": 720},
            accept_downloads=False,
        )
        page = await context.new_page()
        page.on("request", probe.on_request)
        page.on("response", probe.on_response)
        page.on("websocket", probe.on_socket)
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            words, state = [], {}
            for i in range(25):
                await page.wait_for_timeout(3000)
                words, state = await probe.shot(page, "load", save=i in (0, 12, 24))
                if "DOUBLE" in state["text"].upper() and "FEATURE" in state["text"].upper():
                    break
            # 40221846216 proved this intro dismiss control does not buy anything.
            if not ("DOUBLE" in state["text"].upper() and "FEATURE" in state["text"].upper()):
                await probe.click(page, (640, 631), "verified_demo_intro")
                await page.wait_for_timeout(2500)
                await probe.shot(page, "intro-dismissed", save=True)
            _, state = await probe.shot(page, "before-ante-toggle", save=True)
            before_path = probe.dir / "_current.png"
            before = crop(before_path, PANEL)
            before_ante_state = crop(before_path, ANTE_STATE)
            before_reels = crop(before_path, REELS)
            before_text = read_panel(before_path)
            probe.note("ANTE_BEFORE", before_text[:280])
            # Check DEMO explicitly. Redirects may hide the query, but both
            # current screenshot and historical title contain PLAYING FOR FUN.
            if "PLAYING FOR FUN" not in state["text"].upper() and (
                    "real=0" not in page.url and "preferedmode=offline" not in page.url):
                probe.stage = "needs_review"
                probe.note("BLOCKED", "FUN mode not independently established")
                return
            if "OFF" not in before_text or "CHANCE" not in before_text:
                probe.stage = "needs_review"
                probe.note("BLOCKED", "Ante Bet OFF and DOUBLE CHANCE labels not proven")
                return
            await page.wait_for_timeout(2000)
            await probe.shot(page, "revalidate-ante-off", save=True)
            before_again = crop(probe.dir / "_current.png", PANEL)
            if difference(before, before_again) > 7:
                probe.stage = "needs_review"
                probe.note("BLOCKED", "Toggle panel changed before click")
                return
            await probe.click(page, (146, 465), "FUN_double_chance_toggle_ON_once")
            probe.stage = "ante_input_sent"
            await page.wait_for_timeout(2300)
            await probe.shot(page, "after-ante-toggle", save=True)
            after_path = probe.dir / "_current.png"
            after_first = crop(after_path, PANEL)
            await page.wait_for_timeout(2100)
            await probe.shot(page, "verify-ante-toggle", save=True)
            after_second = crop(probe.dir / "_current.png", PANEL)
            after_text = read_panel(probe.dir / "_current.png")
            probe.note("ANTE_AFTER", after_text[:280])
            changed_state = difference(before_ante_state, crop(probe.dir / "_current.png", ANTE_STATE))
            stable = difference(after_first, after_second)
            probe.note("ANTE_VISUAL_DELTA", json.dumps({
                "changed_state": round(changed_state, 2), "stable": round(stable, 2),
                "before_OFF": "OFF" in before_text,
                "after_ON": bool(re.search(r"\bON\b", after_text)),
                "after_OFF": "OFF" in after_text,
            }))
            # Never spin on a guessed ante state.
            if not (changed_state > 5 and stable < 8 and
                    re.search(r"\bON\b", after_text) and "OFF" not in after_text):
                probe.stage = "ante_result_uncertain"
                probe.note("STOP", "One toggle only. Cannot prove ante ON from 2 stable images")
                return
            probe.stage = "ante_enabled_observed"
            probe.note("ANTE_VERIFIED", "ON visually read in FUN mode; still no outcome claim")
            before_net = probe.network_events
            await probe.click(page, (1205, 627), "single_FUN_spin_with_verified_ante")
            probe.spin_attempts += 1
            await page.wait_for_timeout(2200)
            await probe.shot(page, "ante-spin-motion", save=True)
            await page.wait_for_timeout(2400)
            await probe.shot(page, "ante-spin-settle", save=True)
            after_reels = crop(probe.dir / "_current.png", REELS)
            moved = difference(before_reels, after_reels) > 6
            probe.note("ANTE_SPIN_EVIDENCE", json.dumps({
                "reels_changed": moved,
                "network_events_delta": probe.network_events - before_net,
            }))
            probe.stage = "ante_spin_visual_change" if moved else "ante_spin_unverified"
            # A changed screenshot is not by itself proof of a settled wager or
            # server response. Do not repeat an uncertain action.
        except Exception as exc:
            probe.stage = "error"
            probe.note("EXCEPTION", type(exc).__name__ + ": " + str(exc)[:140])
        finally:
            await probe.checkpoint(probe.stage, force=True)
            await context.close()
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
