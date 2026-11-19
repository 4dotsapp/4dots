#!/usr/bin/env python3
"""Test the RAM/SSD tiering: TTL policy, low-RAM fallback, safe migration.

Owns the server process so it can restart it under different memory pressure.
"""
import hashlib, json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error
from pathlib import Path

B = "http://127.0.0.1:8097"
UA = {"user-agent": "Mozilla/5.0"}
TEST_ROOT = Path(os.environ.get("FOURDOTS_TEST_DIR") or tempfile.mkdtemp(prefix="4dots-tiers-"))
RAM = Path(os.environ.get("FOURDOTS_TEST_RAM") or "/dev/shm/4dots-test")
SSD = TEST_ROOT / "drops"
DATA = TEST_ROOT
SERVER = os.environ.get("FOURDOTS_SERVER") or str(Path(__file__).resolve().parent / "server.py")

ok = True


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label} {detail}")


def call(url, data=None, method=None, headers=None):
    h = dict(UA); h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=60)
        return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.status, e.read(), dict(e.headers)


def start(ram_min_mb, ram_max_mb=32):
    env = dict(os.environ,
               FOURDOTS_DATA=str(DATA), FOURDOTS_PUBLIC=str(Path(__file__).resolve().parent / "public"),
               FOURDOTS_PORT="8097", FOURDOTS_RAM_DIR=str(RAM), FOURDOTS_SSD_DIR=str(SSD),
               FOURDOTS_RAM_MIN_MB=str(ram_min_mb), FOURDOTS_RAM_MIN_FREE_MB="1",
               FOURDOTS_RAM_MAX_MB=str(ram_max_mb), FOURDOTS_SWEEP_SECONDS="2")
    proc = subprocess.Popen([sys.executable, SERVER], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for _ in range(40):
        time.sleep(0.25)
        try:
            if call(f"{B}/api/config")[0] == 200:
                return proc
        except Exception:
            continue
    raise RuntimeError("server did not come up")


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def upload(ttl, payload, burn=False):
    st, body, _ = call(f"{B}/api/drops", data=json.dumps({"ttl": ttl}).encode(), method="POST",
                       headers={"content-type": "application/json"})
    info = json.loads(body)
    code, tok, tier = info["code"], info["reservation"], info.get("tier")
    st, body, _ = call(f"{B}/api/drops/{code}/parts/0", data=payload, method="PUT",
                       headers={"content-type": "application/octet-stream", "x-reservation": tok})
    assert st == 201, (st, body[:200])
    st, body, _ = call(f"{B}/api/drops/{code}/commit",
                       data=json.dumps({"ttl": ttl, "burn": burn, "parts": 1}).encode(),
                       method="POST", headers={"content-type": "application/json", "x-reservation": tok})
    assert st == 201, (st, body[:200])
    return code, tier


def download(code):
    st, body, headers = call(f"{B}/api/drops/{code}")
    return st, body, headers.get("x-drop-tier"), headers.get("content-length")


def files_in(path):
    return sorted(p.name for p in Path(path).iterdir()) if Path(path).exists() else []


if DATA.exists():
    subprocess.run(["rm", "-rf", str(DATA)])
DATA.mkdir(parents=True, exist_ok=True)
if RAM.exists():
    subprocess.run(["rm", "-rf", str(RAM)])
RAM.parent.mkdir(parents=True, exist_ok=True)
try:
    RAM.mkdir(parents=True, exist_ok=True)
except OSError:
    print(f"WARNING: cannot create the RAM tier at {RAM}; this test needs a tmpfs mount")
    raise SystemExit(2)

payload = b"NMB2" + os.urandom(3 * 1024 * 1024)
digest = hashlib.sha256(payload).hexdigest()

print("=== phase 1: memory available -> 10 min / 1 hour in RAM, 24 h on SSD ===")
proc = start(ram_min_mb=1)
try:
    code_1h, tier_1h = upload(3600, payload)
    code_24h, tier_24h = upload(86400, payload)
    code_10m, tier_10m = upload(600, payload)
    print(f"  reserve tiers: 10min={tier_10m}  1h={tier_1h}  24h={tier_24h}")
    check("10 minute drop -> RAM tier", tier_10m == "ram", tier_10m)
    check("1 hour drop -> RAM tier", tier_1h == "ram", tier_1h)
    check("24 hour drop -> SSD tier", tier_24h == "ssd", tier_24h)
    check("RAM tier holds exactly the two short drops", len(files_in(RAM)) == 2, files_in(RAM))
    check("SSD tier holds exactly the 24 hour drop", len(files_in(SSD)) == 1, files_in(SSD))
    st, body, tier, _ = download(code_1h)
    check("RAM drop downloads byte-identical", st == 200 and hashlib.sha256(body).hexdigest() == digest,
          f"{st} tier={tier}")
    st, body, tier, _ = download(code_24h)
    check("SSD drop downloads byte-identical", st == 200 and hashlib.sha256(body).hexdigest() == digest,
          f"{st} tier={tier}")
    ram_names = set(files_in(RAM))
finally:
    stop(proc)

print("\n=== phase 2: memory pressure -> every RAM drop migrates to SSD, nothing breaks ===")
proc = start(ram_min_mb=4096)  # above what the machine has: RAM tier is unavailable
try:
    deadline = time.time() + 60
    while time.time() < deadline and files_in(RAM):
        time.sleep(1)
    print(f"  RAM tier now : {files_in(RAM)}")
    print(f"  SSD tier now : {files_in(SSD)}")
    check("RAM tier is empty after the squeeze", not files_in(RAM))
    check("SSD tier holds all three drops", len(files_in(SSD)) == 3, files_in(SSD))
    check("migrated files kept their names", ram_names.issubset(set(files_in(SSD))), ram_names)

    st, body, tier, _ = download(code_1h)
    check("migrated 1 hour drop still downloads byte-identical",
          st == 200 and hashlib.sha256(body).hexdigest() == digest, f"{st} tier={tier}")
    st, body, tier, _ = download(code_10m)
    check("migrated 10 minute drop still downloads byte-identical",
          st == 200 and hashlib.sha256(body).hexdigest() == digest, f"{st} tier={tier}")
    st, body, tier, _ = download(code_24h)
    check("24 hour drop untouched", st == 200 and hashlib.sha256(body).hexdigest() == digest,
          f"{st} tier={tier}")

    print("\n=== phase 3: with memory still tight, a 1 hour upload goes straight to SSD ===")
    code_new, tier_new = upload(3600, payload)
    check("new 1 hour drop -> SSD tier while memory is tight", tier_new == "ssd", tier_new)
    check("new drop landed in the SSD tier", len(files_in(SSD)) == 4, files_in(SSD))
    st, body, tier, _ = download(code_new)
    check("new SSD drop downloads byte-identical",
          st == 200 and hashlib.sha256(body).hexdigest() == digest, f"{st} tier={tier}")
finally:
    stop(proc)

print("\n=== phase 4: RAM comes back -> new short drops use RAM again ===")
proc = start(ram_min_mb=1)
try:
    code_back, tier_back = upload(3600, payload)
    check("short drop -> RAM tier again", tier_back == "ram", tier_back)
    st, body, tier, _ = download(code_back)
    check("RAM drop downloads byte-identical",
          st == 200 and hashlib.sha256(body).hexdigest() == digest, f"{st} tier={tier}")
finally:
    stop(proc)

print("\nALL GREEN" if ok else "\nFAILURES ABOVE")
sys.exit(0 if ok else 1)
