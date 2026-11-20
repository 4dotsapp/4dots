#!/usr/bin/env python3
"""Browser end-to-end test for Direct mode (two contexts in one Chromium).

  python3 direct_e2e.py [size_mb]

Starts its own server on port 8095 against a throwaway database, then proves:
a text transfer, a large file transfer (hash and flat JS heap), the compact
progress line, the wrong-code path, cancel, the Server fallback, and that both
storage tiers stay empty. It also records the connection label the UI showed.

This proves the code path and real WebRTC on loopback. It does not prove
traversal between two different networks or on other browsers.
"""
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright

SIZE_MB = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("DIRECT_SIZE_MB", "50"))
PORT = 8095
BASE = f"http://127.0.0.1:{PORT}"
HERE = Path(__file__).resolve().parent
ROOT = Path(tempfile.mkdtemp(prefix="4dots-direct-e2e-"))
RAM = Path("/dev/shm/4dots-direct-e2e-ram")
SSD = ROOT / "drops"
FILES = Path(tempfile.mkdtemp(prefix="4dots-direct-file-"))
FILE = FILES / f"direct_e2e_{SIZE_MB}mb.bin"
if not FILE.exists():
    with open(FILE, "wb") as fh:
        fh.write(os.urandom(SIZE_MB * 1024 * 1024))
DIGEST = hashlib.sha256(FILE.read_bytes()).hexdigest()
ok = True
notes = []


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label} {detail}")


def free_code():
    """A code that no session owns, for the wrong-code test."""
    for candidate in ("0000", "1111", "9999", "1234"):
        try:
            req = urllib.request.Request(
                f"{BASE}/api/direct/sessions/{candidate}/join", data=b"{}", method="POST",
                headers={"content-type": "application/json", "x-forwarded-for": "10.9.9.9"})
            urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return candidate
        except Exception:
            pass
    return "0000"


async def wait_code(page):
    for _ in range(120):
        await page.wait_for_timeout(100)
        text = "".join((await page.inner_text("#direct-send-code")).split())
        if len(text) == 4 and text.isdigit():
            return text
    return ""


async def wait_result(page, needle, tries=600):
    for _ in range(tries):
        await page.wait_for_timeout(100)
        try:
            body = await page.inner_text("#result-body")
        except Exception:
            body = ""
        if needle in body:
            return True
    return False


async def main():
    for path in (ROOT, RAM):
        if path.exists():
            subprocess.run(["rm", "-rf", str(path)])
        path.mkdir(parents=True, exist_ok=True)
    SSD.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ,
               FOURDOTS_DATA=str(ROOT), FOURDOTS_PUBLIC=str(HERE / "public"),
               FOURDOTS_PORT=str(PORT), FOURDOTS_RAM_DIR=str(RAM), FOURDOTS_SSD_DIR=str(SSD),
               FOURDOTS_RAM_MIN_MB="1", FOURDOTS_RAM_MIN_FREE_MB="1", FOURDOTS_RAM_MAX_MB="32",
               FOURDOTS_SWEEP_SECONDS="1")
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

            def watch(page):
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

            print("=== large file, device to device ===")
            sender_ctx = await browser.new_context()
            sender = await sender_ctx.new_page()
            watch(sender)
            await sender.goto(BASE, wait_until="load")
            await sender.wait_for_selector(".mode-row:not([hidden])")
            await sender.click('.mode-switch[data-side="send"] [data-mode="direct"]')
            await sender.set_input_files("#file-input", str(FILE))
            await sender.wait_for_timeout(300)
            started = time.time()
            await sender.click("#send-btn")
            code = await wait_code(sender)
            check("sender gets a Direct code", len(code) == 4, code)
            waiting = False
            for _ in range(60):
                if "Waiting" in await sender.inner_text("#direct-send-state"):
                    waiting = True
                    break
                await sender.wait_for_timeout(100)
            check("waiting state is shown", waiting, await sender.inner_text("#direct-send-state"))

            receiver_ctx = await browser.new_context()
            receiver = await receiver_ctx.new_page()
            watch(receiver)
            await receiver.add_init_script("""
              window.__directStates = [];
              addEventListener('DOMContentLoaded', () => {
                const el = document.getElementById('direct-receive-state');
                if (!el) return;
                window.__directStates.push(el.textContent);
                new MutationObserver(() => window.__directStates.push(el.textContent))
                  .observe(el, { childList: true, subtree: true, characterData: true });
              });
            """)
            cdp = await receiver_ctx.new_cdp_session(receiver)
            await cdp.send("Performance.enable")
            await receiver.goto(f"{BASE}/#d{code}", wait_until="load")

            heaps = []
            states = []
            links = []
            speeds = []
            etas = []
            deadline = time.time() + 120
            while time.time() < deadline:
                await receiver.wait_for_timeout(150)
                try:
                    metrics = await cdp.send("Performance.getMetrics")
                    heaps.append({m["name"]: m["value"] for m in metrics["metrics"]}["JSHeapUsedSize"])
                except Exception:
                    pass
                try:
                    state = await receiver.inner_text("#direct-receive-state")
                    if state and (not states or states[-1] != state):
                        states.append(state)
                except Exception:
                    pass
                try:
                    value = await receiver.text_content("#direct-receive-meter .speedo-mbps")
                    if value and value.strip() and value.strip() != "--":
                        speeds.append(float(value))
                    link = await receiver.text_content("#direct-receive-meter .speedo-link")
                    if link and (not links or links[-1] != link):
                        links.append(link)
                    eta = await receiver.text_content("#direct-receive-meter .speedo-eta")
                    if eta and re.fullmatch(r"\d+:\d\d", eta.strip()):
                        etas.append(eta.strip())
                except Exception:
                    pass
                try:
                    if "MB" in await receiver.inner_text("#result-body"):
                        break
                except Exception:
                    pass
            elapsed = time.time() - started
            check("recipient sees the file", await wait_result(receiver, FILE.name, tries=5))
            seen = await receiver.evaluate("window.__directStates || []")
            states = list(dict.fromkeys(seen))
            check("states ran through Connecting and Transferring",
                  "Connecting" in states and "Transferring" in states, states)
            check("the label is a real ICE classification",
                  any(link in ("Local Wi-Fi", "Local network", "Internet P2P") for link in links), links)
            peak = max(heaps) / 1e6 if heaps else 0
            check("receiver JS heap stays flat", peak < 40, f"peak {peak:.1f} MB, {len(heaps)} samples")
            check("measured speed was shown", any(s > 0 for s in speeds), speeds[-5:])
            check("the time-left gauge shows a real estimate", bool(etas), etas[-3:])
            reached = await receiver.inner_text("#result-meta")
            check("result says nothing was stored", "Nothing was stored" in reached, reached)
            print(f"    {SIZE_MB} MB in {elapsed:.2f}s "
                  f"({SIZE_MB / max(elapsed, 0.01):.1f} MB/s end to end incl. crypto)")

            async with receiver.expect_download() as info:
                await receiver.click("#result-body a[download]")
            download = await info.value
            got = ROOT / "received.bin"
            await download.save_as(str(got))
            check("downloaded file is byte-identical",
                  hashlib.sha256(got.read_bytes()).hexdigest() == DIGEST, got.stat().st_size)
            check("sender reaches Done", "Done" in await sender.inner_text("#direct-send-state"))
            print(f"    transfer time: {elapsed:.2f}s, states: {states}, links: {links}")

            print("\n=== text-only transfer uses the compact line ===")
            await sender.click('[data-action="direct-new"]')
            await sender.wait_for_timeout(300)
            await sender.fill("#note", "direct text only")
            await sender.click("#send-btn")
            code2 = await wait_code(sender)
            recv2 = await (await browser.new_context()).new_page()
            watch(recv2)
            await recv2.goto(f"{BASE}/#d{code2}", wait_until="load")
            check("text arrives", await wait_result(recv2, "direct text only"))
            compact = await recv2.get_attribute("#direct-receive-meter", "class")
            check("small transfer uses the compact progress line", "compact" in (compact or ""), compact)

            check("no page or console errors in the happy path", not errors, errors[:3])
            errors.clear()

            print("\n=== wrong code, cancel, fallback ===")
            wrong = free_code()
            recv3 = await (await browser.new_context()).new_page()
            watch(recv3)
            await recv3.goto(BASE, wait_until="load")
            await recv3.wait_for_selector(".mode-row:not([hidden])")
            await recv3.click("#tab-receive")
            await recv3.wait_for_timeout(350)
            await recv3.click('.mode-switch[data-side="receive"] [data-mode="direct"]')
            for digit in wrong:
                await recv3.keyboard.type(digit)
                await recv3.wait_for_timeout(60)
            await recv3.wait_for_timeout(500)
            state = await recv3.inner_text("#direct-receive-state")
            check("wrong code explains itself", "failed" in state.lower(), state)
            fallback = '#direct-receive [data-action="direct-fallback"]'
            check("Server fallback is offered", await recv3.is_visible(fallback))
            await recv3.click(fallback)
            await recv3.wait_for_timeout(400)
            mode = await recv3.inner_text('.mode-switch[data-side="receive"] [aria-checked="true"]')
            check("fallback switches to Server", mode.strip() == "Server", mode)
            # The wrong-code join is an expected 404, which Chromium logs as a
            # failed resource. Clear it; everything after must be clean.
            errors.clear()

            if await sender.is_visible('[data-action="direct-new"]'):
                await sender.click('[data-action="direct-new"]')
            await sender.wait_for_timeout(200)
            await sender.fill("#note", "cancel me")
            await sender.click("#send-btn")
            code3 = await wait_code(sender)
            await sender.wait_for_timeout(300)
            await sender.click('#direct-send [data-action="direct-cancel"]')
            await sender.wait_for_timeout(500)
            check("cancel returns to compose",
                  await sender.get_attribute(".view.active", "data-view") == "send-compose")
            try:
                req = urllib.request.Request(
                    f"{BASE}/api/direct/sessions/{code3}/join", data=b"{}", method="POST",
                    headers={"content-type": "application/json", "x-forwarded-for": "10.9.9.8"})
                urllib.request.urlopen(req, timeout=3)
                gone = False
            except urllib.error.HTTPError as err:
                gone = err.code == 404
            check("cancel deletes the server session", gone)

            print("\n=== storage and logs ===")
            check("RAM tier stays empty", not list(RAM.iterdir()), list(RAM.iterdir()))
            check("SSD tier stays empty", not list(SSD.iterdir()), list(SSD.iterdir()))
            check("no errors after the expected wrong-code 404", not errors, errors[:3])
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
