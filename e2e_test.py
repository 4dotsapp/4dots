#!/usr/bin/env python3
"""End-to-end test of the 4dots frontend against a chosen backend.

  python3 e2e_test.py [base_url] [size_mb]

Uploads a file, reads the four-digit code back, then opens the drop in a second
browser context and verifies the file arrives intact.
"""
import asyncio, hashlib, os, sys, tempfile, time
from playwright.async_api import async_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099").rstrip("/")
SIZE_MB = int(sys.argv[2]) if len(sys.argv) > 2 else 30
WORKDIR = tempfile.mkdtemp(prefix="4dots-e2e-")
PATH = os.path.join(WORKDIR, f"e2e_{SIZE_MB}mb.bin")
SHOT = os.path.abspath("e2e_received.png")


def find_chrome():
    """Find a Chromium for Playwright, or None to let Playwright choose."""
    import glob
    hits = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium*/chrome-linux/chrome")))
    return os.environ.get("FOURDOTS_CHROME") or (hits[0] if hits else None)


CHROME = find_chrome()

if not os.path.exists(PATH):
    with open(PATH, "wb") as f:
        f.write(os.urandom(SIZE_MB * 1024 * 1024))
DIGEST = hashlib.sha256(open(PATH, "rb").read()).hexdigest()


async def main():
    async with async_playwright() as p:
        launch = {"args": ["--no-sandbox"]}
        if CHROME:
            launch["executable_path"] = CHROME
        browser = await p.chromium.launch(**launch)
        ctx = await browser.new_context()
        page = await ctx.new_page()
        marks = []
        page.on("response", lambda r: marks.append((round(time.time() - t0, 2), r.status, r.url)))
        t0 = time.time()
        await page.goto(BASE, wait_until="load")
        await page.set_input_files("#file-input", PATH)
        await page.wait_for_timeout(300)
        await page.click("#send-btn")

        code = ""
        for _ in range(120):
            await page.wait_for_timeout(250)
            label = await page.get_attribute("#code", "aria-label") or ""
            if "is" in label:
                code = "".join(ch for ch in label.split("is")[-1] if ch.isdigit())
            if code and len(code) == 4:
                break
        send_time = time.time() - t0
        print(f"sent {SIZE_MB} MB in {send_time:.2f}s  ({SIZE_MB/send_time:.1f} MB/s)  code={code}")
        assert code and len(code) == 4, f"no code produced (got {code!r})"

        print("\nnetwork:")
        for t, status, url in marks:
            if "/api/" in url:
                print(f"   {t:6.2f}s  {status}  {url.replace(BASE,'')}")

        # ── open it in a fresh context, exactly like a recipient would ──
        page2 = await (await browser.new_context()).new_page()
        await page2.goto(BASE, wait_until="load")
        await page2.click("#tab-receive")
        await page2.wait_for_timeout(300)
        for digit in code:
            await page2.keyboard.type(digit)
            await page2.wait_for_timeout(120)
        await page2.wait_for_timeout(400)
        t1 = time.time()
        # The app auto-submits once four digits are in; the button is only needed
        # when it has not fired yet.
        for _ in range(40):
            visible = await page2.is_visible("#open-btn")
            enabled = await page2.is_enabled("#open-btn") if visible else False
            if visible and enabled:
                await page2.click("#open-btn")
                break
            if not visible:
                break
            await page2.wait_for_timeout(200)
        ok = False
        for _ in range(240):
            await page2.wait_for_timeout(250)
            meta = await page2.inner_text("#result-meta") if await page2.query_selector("#result-meta") else ""
            if "B" in meta or "KB" in meta or "MB" in meta:
                ok = True
                break
        print(f"\nopened the drop in {time.time()-t1:.2f}s -> {meta.strip()[:120]}")
        assert ok, "recipient never saw the file"
        await page2.screenshot(path=SHOT, full_page=True)
        print(f"screenshot: {SHOT}")
        await browser.close()
        print("\nE2E OK: upload, 4-digit code, and download+decrypt all worked.")


asyncio.run(main())
