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
            # Isolated GitHub runner keeps the active FUN page in the foreground.
            # The prior two-tab run left bonus counters stalled for many minutes.
            await page.bring_to_front()
            await page.wait_for_timeout(2500 if selected else 5500)
            words,state=await probe.shot(page,"watch",save=selected or probe.observations%4==0)
            img=probe.dir/"_current.png"
            # Hard guard: no actions if the current screen is not explicitly FUN.
            if ("PLAYING FOR FUN" not in state["text"].upper() and not
                    ("preferedmode=offline" in page.url and "real=0" in page.url)):
                probe.stage="needs_review"
                probe.note("FUN_GUARD","Neither screen nor live URL independently establishes FUN/offline; stop")
                break
            # 40280174612/12635431364: Wonder 4x5 showed a persistent
            # first-party "Connection Lost" modal. Never click a spin or
            # reopen autoplay while disconnected; capture 3 stable images.
            if "CONNECTION LOST" in state["text"].upper():
                persistent=True
                for check in (2,3):
                    await page.wait_for_timeout(2000)
                    _, verified=await probe.shot(page,f"verify-connection-lost-{check}",save=True)
                    if "CONNECTION LOST" not in verified["text"].upper():
                        persistent=False
                        break
                if persistent:
                    probe.stage="connection_lost_external"
                    probe.note("CONNECTION_LOST_EXTERNAL",
                        f"{variant}: first-party session disconnected; no input or purchase attempted")
                    break
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
                # The verified 3x5 branch ends on a FULL-SCREEN TOTAL WIN
                # dialog requiring CONTINUE. The ordinary bottom HUD also
                # says TOTAL WIN, so only consider the CENTER crop.
                central=await asyncio.to_thread(read_crop,img,(380,150,900,540))
                if "TOTAL" in central and "WIN" in central:
                    candidates=[w for w in words if re.fullmatch(
                        r"CONTINUE",w["text"].strip(".,:!?"),re.I)
                        and 250<=w["x"]<=1040 and 160<=w["y"]<=650]
                    if not candidates:
                        probe.stage="terminal_needs_review"
                        probe.note("PENDING_TERMINAL","Center TOTAL WIN visible but no OCR-grounded CONTINUE target; no blind click")
                        await probe.shot(page,"terminal-no-confirmed-continue",save=True)
                        break
                    target=min(candidates,key=lambda w:abs(w["x"]-640))
                    await probe.shot(page,"terminal-result-first",save=True)
                    validated=True
                    for check in range(2):
                        await page.wait_for_timeout(2200)
                        words2,state2=await probe.shot(page,f"terminal-recheck-{check+2}",save=True)
                        central2=await asyncio.to_thread(read_crop,probe.dir/"_current.png",(380,150,900,540))
                        choices2=[w for w in words2 if re.fullmatch(
                            r"CONTINUE",w["text"].strip(".,:!?"),re.I)
                            and abs(w["x"]-target["x"])<=18 and abs(w["y"]-target["y"])<=18]
                        if not ("TOTAL" in central2 and "WIN" in central2 and choices2):
                            validated=False
                            break
                    if not validated:
                        probe.note("TERMINAL_UNSTABLE","One or more independent images disagree; no action")
                        continue
                    await probe.click(page,(target["x"],target["y"]),f"ack_{variant}_earned_bonus_result_CONTINUE_once")
                    probe.note("TERMINAL_ACK","One OCR-grounded click after three 2s-spaced confirmations; return still unverified")
                    await page.wait_for_timeout(2500)
                    base_ok=0
                    for check in range(3):
                        words3,state3=await probe.shot(page,f"verify-{variant}-base-return-{check+1}",save=True)
                        central3=await asyncio.to_thread(read_crop,probe.dir/"_current.png",(380,150,900,540))
                        base_text=state3["text"].upper()
                        if ("PLAYING FOR FUN" in base_text and
                            "TOTAL" not in central3 and "SPINS LEFT" not in base_text and
                            ("HIT SPIN" in base_text or
                             any(w["text"].upper() in {"SPIN","AUTOPLAY"} for w in words3))):
                            base_ok+=1
                        if check!=2:
                            await page.wait_for_timeout(2200)
                    if base_ok==3:
                        probe.feature_finished=True
                        probe.stage="verified_return_to_base"
                        probe.note("FEATURE_COMPLETE",f"{variant} terminal acknowledged and FUN base confirmed three times")
                    else:
                        probe.stage="return_uncertain"
                        probe.note("BLOCKED","Terminal CONTINUE sent exactly once but FUN base not independently established; no retry")
                    break
                count_text=await asyncio.to_thread(read_crop,img,(930,560,1048,668),3)
                m=re.search(r"(\d{1,2})\s*(?:SPINS|GAMES)",count_text)
                if m:
                    last_spins=int(m.group(1))
                    probe.note("BONUS_COUNT",f"{variant}: {last_spins} spins left")
                    base_after_feature=0
                if ("BONUS COMPLETE" in state["text"].upper() or
                    "FEATURE COMPLETE" in state["text"].upper() or
                    "FREE GAMES COMPLETE" in state["text"].upper()):
                    # A final title alone is not evidence of acknowledgement
                    # and return; preserve checkpoint and inspect next image.
                    probe.note("TERMINAL_HINT","Completion text appeared; require terminal result and confirmed base return")
                    await probe.shot(page,"bonus-terminal-hint",save=True)
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
                if time.monotonic()-bonus_started_at>1800:
                    probe.stage="bonus_needs_review"
                    probe.note("BLOCKER","Earned feature not terminally verified after 30 minutes; avoid new inputs")
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
    only=os.getenv("WONDER_ONLY_VARIANT")
    if only and only not in OPTIONS:
        raise ValueError("Invalid Wonder FUN variant, refusing run")
    variants=[only] if only else list(OPTIONS)
    async with async_playwright() as playwright:
        browser=await playwright.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
        await asyncio.gather(*(play_variant(browser,v,limit) for v in variants))
        await browser.close()


if __name__=="__main__":
    asyncio.run(main())
