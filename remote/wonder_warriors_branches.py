"""Run both remaining Wonder Warriors reel bonus choices in separate FUN sessions.

The game offers 3x5/15 spins, 4x5/10 spins and 5x5/5 spins; 6x5 is
locked in the observed FUN build. 3x5 is tracked separately by live MCP.
"""
from __future__ import annotations
import asyncio
import os
import re
import time
from pathlib import Path
from PIL import Image
import pytesseract
from playwright.async_api import async_playwright
from playtech_autopilot import Probe, OUT

GAME_URL = ("https://cachedownload.playtechone.com/ngmdesktop/casinoclient.html?"
            "game=gpas_aogww_pop&preferedmode=offline&real=0")
OPTIONS = {"4x5": (547, 354), "5x5": (732, 354)}


def read_crop(path: Path, box, scale=2):
    im=Image.open(path).convert("L").crop(box)
    im=im.resize((im.width*scale,im.height*scale))
    return pytesseract.image_to_string(im, config="--psm 6").upper()


async def play_variant(browser, variant: str, limit=3600):
    probe=Probe("gpas_aogww_pop")
    probe.game="wonder_"+variant
    probe.dir=OUT / f"wonder_{variant}"
    probe.dir.mkdir(parents=True,exist_ok=True)
    probe.log=probe.dir/"events.jsonl"
    probe.net=probe.dir/"network.jsonl"
    probe.progress=probe.dir/"progress.json"
    context=await browser.new_context(viewport={"width":1280,"height":720})
    page=await context.new_page()
    page.on("request",probe.on_request)
    page.on("response",probe.on_response)
    page.on("websocket",probe.on_socket)
    selected=False
    bonus_started_at=0.0
    last_spins=99
    base_after_feature=0
    try:
        probe.stage="loading"
        await page.goto(GAME_URL,wait_until="domcontentloaded",timeout=60000)
        started=time.monotonic()
        for attempt in range(60):
            await page.wait_for_timeout(2000)
            await probe.shot(page,"loading",save=attempt%12==0)
            txt=await asyncio.to_thread(read_crop, probe.dir/"_current.png", (420,460,870,575))
            if "START" in txt:
                await probe.click(page,(640,530),"start_PUBLIC_FUN_game")
                break
        await page.wait_for_timeout(1800)
        probe.stage="autoplay_setup"
        await probe.click(page,(800,619),"open_until_feature")
        await page.wait_for_timeout(500)
        await probe.shot(page,"until-feature-menu",save=True)
        # First-party native mode: select "Until Feature" and start it with PLAY.
        await probe.click(page,(989,619),"begin_until_feature")
        probe.stage="await_feature"
        await page.wait_for_timeout(2200)
        while time.monotonic()-started < limit:
            await page.wait_for_timeout(5500)
            words,state=await probe.shot(page,"watch",save=probe.observations%4==0)
            img=probe.dir/"_current.png"
            if not selected:
                choice_text=await asyncio.to_thread(read_crop,img,(370,135,940,225))
                if "SELECT" in choice_text or "YOUR REELS" in choice_text:
                    # Options independently verified from prior real MCP screenshot.
                    await probe.shot(page,"reel-choices",save=True)
                    await page.wait_for_timeout(2000)
                    await probe.shot(page,"confirm-reel-choices",save=False)
                    verified=await asyncio.to_thread(read_crop,img,(370,135,940,225))
                    if "SELECT" not in verified and "YOUR REELS" not in verified:
                        continue
                    await probe.click(page,OPTIONS[variant],f"choose_{variant}_FREE_GAMES")
                    selected=True
                    bonus_started_at=time.monotonic()
                    probe.feature_seen=True
                    probe.stage="bonus_in_progress"
                    probe.note("CHOICE",f"Selected {variant} via real feature prompt")
                    await probe.shot(page,"selected",save=True)
            else:
                count_text=await asyncio.to_thread(read_crop,img,(930,560,1048,668),3)
                m=re.search(r"(\d{1,2})\s*(?:SPINS|GAMES)",count_text)
                if m:
                    last_spins=int(m.group(1))
                    probe.note("BONUS_COUNT",f"{variant}: {last_spins} spins left")
                    base_after_feature=0
                if ("BONUS COMPLETE" in state["text"].upper() or
                    "FEATURE COMPLETE" in state["text"].upper() or
                    "FREE GAMES COMPLETE" in state["text"].upper()):
                    probe.feature_finished=True
                    probe.stage="verified_complete"
                    await probe.shot(page,"bonus-end",save=True)
                    break
                base_ui = "HIT SPIN" in state["text"].upper() or "CLICK SPIN TO START" in state["text"].upper()
                if (last_spins==0 or (base_ui and time.monotonic()-bonus_started_at>40)):
                    # Wait for return-to-base and absence of feature counter.
                    if not m and (base_ui or any(w["text"].upper() in {"SPIN","AUTOPLAY"} for w in words)):
                        base_after_feature+=1
                    if base_after_feature>=3:
                        probe.feature_finished=True
                        probe.stage="verified_return_to_base"
                        await probe.shot(page,"bonus-end",save=True)
                        break
                if time.monotonic()-bonus_started_at>1200:
                    probe.stage="bonus_needs_review"
                    probe.note("BLOCKER","Feature did not finish after 20 minutes")
                    break
            await probe.checkpoint()
        else:
            probe.stage="time_limit"
        await probe.checkpoint(probe.stage,force=True)
    except Exception as exc:
        probe.stage="error"
        probe.note("EXCEPTION",f"{type(exc).__name__}: {str(exc)[:240]}")
        await probe.checkpoint("error",force=True)
    finally:
        await probe.checkpoint(probe.stage,force=True)
        await context.close()


async def main():
    limit=max(120,min(6000,int(os.getenv("VARIANT_SECONDS","3600"))))
    async with async_playwright() as playwright:
        browser=await playwright.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
        await asyncio.gather(*(play_variant(browser,v,limit) for v in OPTIONS))
        await browser.close()


if __name__=="__main__":
    asyncio.run(main())
