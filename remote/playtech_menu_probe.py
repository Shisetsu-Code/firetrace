"""Read-only-after-menu Playtech native autoplay UI probe (public FUN URLs)."""
import asyncio, os, json
from pathlib import Path
from playwright.async_api import async_playwright
from playtech_autopilot import AUTOPLAY, INTRO

# Read-only menu inventory for all ten originally requested Playtech FUN games.
# Isolated browser contexts; never click any purchase or Ante control here.
GAMES=["ashadv","ftsis","gpas_aogggriffin_pop","aogmt","aogroo",
       "gpas_gstorm2_pop","gpas_agstorm3_pop","gpas_mgaogkol_pop",
       "gpas_aogww_pop","gpas_aogwfot_pop"]
OUT=Path(os.getenv("MENU_OUT","/tmp/playtech-menu-probe"))
OUT.mkdir(parents=True,exist_ok=True)

async def run_game(browser,game):
    p=OUT/game
    p.mkdir(exist_ok=True)
    c=await browser.new_context(viewport={"width":1280,"height":720})
    page=await c.new_page()
    status={"game":game,"ok":False}
    try:
        url=f"https://cachedownload.playtechone.com/ngmdesktop/casinoclient.html?game={game}&preferedmode=offline&real=0"
        await page.goto(url,wait_until="domcontentloaded",timeout=60000)
        await page.wait_for_timeout(12000)
        await page.screenshot(path=str(p/"01-loaded.jpg"),type="jpeg",quality=55)
        if game in INTRO:
            await page.mouse.click(*INTRO[game],delay=60)
            await page.wait_for_timeout(2000)
        await page.screenshot(path=str(p/"02-main.jpg"),type="jpeg",quality=55)
        await page.mouse.click(*AUTOPLAY[game],delay=60)
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(p/"03-after-autoplay-click.jpg"),type="jpeg",quality=60)
        if game in ("gpas_gstorm2_pop","gpas_agstorm3_pop","gpas_mgaogkol_pop"):
            x,y=AUTOPLAY[game]
            await page.mouse.move(x,y)
            await page.mouse.down()
            await page.wait_for_timeout(1300)
            await page.screenshot(path=str(p/"04-held-autoplay.jpg"),type="jpeg",quality=60)
            await page.mouse.up()
            await page.wait_for_timeout(300)
            await page.screenshot(path=str(p/"05-after-hold.jpg"),type="jpeg",quality=60)
        status.update({"ok":True,"final_url":page.url.split("#")[0]})
    except Exception as exc:
        status.update({"error":f"{type(exc).__name__}: {str(exc)[:160]}"})
        try: await page.screenshot(path=str(p/"error.jpg"),type="jpeg",quality=50)
        except Exception: pass
    finally:
        (p/"result.json").write_text(json.dumps(status,indent=2))
        print(json.dumps(status),flush=True)
        await c.close()

async def main():
    group=int(os.getenv("MENU_GROUP","0"))
    assigned=[g for i,g in enumerate(GAMES) if i%2==group]
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(headless=True,args=["--disable-dev-shm-usage"])
        await asyncio.gather(*(run_game(browser,g) for g in assigned))
        await browser.close()

if __name__=="__main__":
    asyncio.run(main())
