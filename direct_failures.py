#!/usr/bin/env python3
"""Direct mode failure paths and responsive checks.

  python3 direct_failures.py [size_mb]

Abort mid-transfer, close the receiving tab, force ICE to fail (no proxied UDP,
so no path without TURN), and run text transfers at phone and desktop widths in
dark, light and reduced-motion modes. Starts its own server on port 8094.
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

PORT = 8094
BASE = f"http://127.0.0.1:{PORT}"
SIZE_MB = int(sys.argv[1]) if len(sys.argv) > 1 else 20
HERE = Path(__file__).resolve().parent
ROOT = Path(tempfile.mkdtemp(prefix="4dots-direct-fail-"))
RAM = Path("/dev/shm/4dots-direct-fail-ram")
SSD = ROOT / "drops"
FILE = ROOT / f"fail_{SIZE_MB}mb.bin"
ok = True


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label} {detail}")


async def wait_code(page):
    for _ in range(120):
        await page.wait_for_timeout(100)
        text = "".join((await page.inner_text("#direct-send-code")).split())
        if len(text) == 4 and text.isdigit():
            return text
    return ""


async def open_sender(browser, page_errors):
    page = await (await browser.new_context()).new_page()
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    await page.goto(BASE, wait_until="load")
    await page.wait_for_selector(".mode-row:not([hidden])")
    await page.click('.mode-switch[data-side="send"] [data-mode="direct"]')
    return page


async def open_receiver(browser, code, page_errors):
    page = await (await browser.new_context()).new_page()
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    await page.goto(f"{BASE}/#d{code}", wait_until="load")
    return page


async def wait_state(page, needle, tries=120):
    for _ in range(tries):
        await page.wait_for_timeout(100)
        try:
            if needle in await page.inner_text("#direct-receive-state"):
                return True
        except Exception:
            pass
    return False


async def main():
    for path in (ROOT, RAM):
        if path.exists():
            subprocess.run(["rm", "-rf", str(path)])
        path.mkdir(parents=True, exist_ok=True)
    SSD.mkdir(parents=True, exist_ok=True)
    with open(FILE, "wb") as fh:
        fh.write(os.urandom(SIZE_MB * 1024 * 1024))
    env = dict(os.environ,
               FOURDOTS_DATA=str(ROOT), FOURDOTS_PUBLIC=str(HERE / "public"),
               FOURDOTS_PORT=str(PORT), FOURDOTS_RAM_DIR=str(RAM), FOURDOTS_SSD_DIR=str(SSD),
               FOURDOTS_RAM_MIN_MB="1", FOURDOTS_RAM_MIN_FREE_MB="1", FOURDOTS_SWEEP_SECONDS="1")
    log = open(ROOT / "server.log", "wb")
    proc = subprocess.Popen([sys.executable, str(HERE / "server.py")], env=env,
                            stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            time.sleep(0.1)
            try:
                urllib.request.urlopen(f"{BASE}/api/config", timeout=2)
                break
            except Exception:
                continue

        async with async_playwright() as p:
            browser = await p.chromium.launch(args=["--no-sandbox", "--enable-precise-memory-info"])
            errors = []

            print("=== abort mid-transfer ===")
            sender = await open_sender(browser, errors)
            await sender.set_input_files("#file-input", str(FILE))
            await sender.wait_for_timeout(300)
            await sender.click("#send-btn")
            code = await wait_code(sender)
            receiver = await open_receiver(browser, code, errors)
            check("transfer starts", await wait_state(receiver, "Transferring"))
            await sender.wait_for_timeout(500)
            await sender.click('#direct-send [data-action="direct-cancel"]')
            check("sender returns to compose",
                  await sender.get_attribute(".view.active", "data-view") == "send-compose")
            check("recipient is told it failed", await wait_state(receiver, "Connection failed", tries=60),
                  await receiver.inner_text("#direct-receive-state"))
            check("recipient keeps the Server fallback",
                  await receiver.is_visible('#direct-receive [data-action="direct-fallback"]'))
            try:
                req = urllib.request.Request(f"{BASE}/api/direct/sessions/{code}/join", data=b"{}",
                                             method="POST", headers={"content-type": "application/json",
                                                                     "x-forwarded-for": "10.8.8.1"})
                urllib.request.urlopen(req, timeout=3)
                gone = False
            except urllib.error.HTTPError as err:
                gone = err.code in (404, 409)
            check("cancel removed the session", gone)
            await receiver.close()

            print("\n=== receiving tab disappears ===")
            sender = await open_sender(browser, errors)
            await sender.set_input_files("#file-input", str(FILE))
            await sender.wait_for_timeout(300)
            await sender.click("#send-btn")
            code = await wait_code(sender)
            receiver = await open_receiver(browser, code, errors)
            check("transfer starts", await wait_state(receiver, "Transferring"))
            await receiver.close()
            failed = False
            for _ in range(80):
                await sender.wait_for_timeout(100)
                if "Connection failed" in await sender.inner_text("#direct-send-state"):
                    failed = True
                    break
            check("sender reports the lost peer", failed, await sender.inner_text("#direct-send-state"))
            await sender.close()

            print("\n=== ICE blocked: no path, no relay ===")
            blocked_browser = await p.chromium.launch(args=[
                "--no-sandbox",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            ])
            sender = await open_sender(blocked_browser, errors)
            await sender.fill("#note", "this should not connect")
            await sender.click("#send-btn")
            code = await wait_code(sender)
            receiver = await open_receiver(browser, code, errors)
            failed = False
            for _ in range(250):
                await sender.wait_for_timeout(100)
                state = await sender.inner_text("#direct-send-state")
                if "Connection failed" in state:
                    failed = True
                    break
            check("ICE failure fails honestly (no silent relay)", failed,
                  await sender.inner_text("#direct-send-state"))
            check("Server fallback is offered after ICE failure",
                  await sender.is_visible('#direct-send [data-action="direct-fallback"]'))
            check("recipient also fails, not stuck",
                  await wait_state(receiver, "Connection failed", tries=100),
                  await receiver.inner_text("#direct-receive-state"))
            await blocked_browser.close()
            await sender.close()
            await receiver.close()

            print("\n=== responsive, themes, reduced motion ===")
            cases = [
                ("phone light", {"viewport": {"width": 390, "height": 844}, "color_scheme": "light"}),
                ("phone dark", {"viewport": {"width": 390, "height": 844}, "color_scheme": "dark"}),
                ("desktop light", {"viewport": {"width": 1280, "height": 800}, "color_scheme": "light"}),
                ("desktop dark reduced", {"viewport": {"width": 1280, "height": 800},
                                          "color_scheme": "dark", "reduced_motion": "reduce"}),
            ]
            for name, options in cases:
                send_ctx = await browser.new_context(**options)
                sender = await send_ctx.new_page()
                await sender.goto(BASE, wait_until="load")
                await sender.wait_for_selector(".mode-row:not([hidden])")
                await sender.click('.mode-switch[data-side="send"] [data-mode="direct"]')
                await sender.fill("#note", f"responsive {name}")
                await sender.click("#send-btn")
                code = await wait_code(sender)
                recv_ctx = await browser.new_context(**options)
                receiver = await recv_ctx.new_page()
                await receiver.goto(f"{BASE}/#d{code}", wait_until="load")
                seen = False
                for _ in range(150):
                    await receiver.wait_for_timeout(100)
                    try:
                        if f"responsive {name}" in await receiver.inner_text("#result-body"):
                            seen = True
                            break
                    except Exception:
                        pass
                overflow_send = await sender.evaluate(
                    "document.documentElement.scrollWidth - window.innerWidth")
                overflow_recv = await receiver.evaluate(
                    "document.documentElement.scrollWidth - window.innerWidth")
                check(f"{name}: transfer works and no horizontal overflow",
                      seen and overflow_send <= 1 and overflow_recv <= 1,
                      f"seen={seen} send {overflow_send}px, recv {overflow_recv}px, "
                      f"state={await receiver.inner_text('#direct-receive-state')}")
                await receiver.wait_for_timeout(900)  # let the result blocks settle
                await receiver.screenshot(path=f"{ROOT}/responsive-{name.replace(' ', '-')}.png",
                                          full_page=True)
                await send_ctx.close()
                await recv_ctx.close()

            check("no page errors", not errors, errors[:3])
            await browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()

    print("\nALL GREEN" if ok else "\nFAILURES ABOVE")
    sys.exit(0 if ok else 1)


asyncio.run(main())
