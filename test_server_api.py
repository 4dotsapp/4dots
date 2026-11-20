#!/usr/bin/env python3
"""Regression test for the existing Server-mode API.

Covers the contract the frontend already relies on: config, multi-part upload,
byte-identical download, burn-after-reading, revoke, expiry and rate limits.
Starts its own server on port 8093.
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

B = "http://127.0.0.1:8093"
ROOT = Path(tempfile.mkdtemp(prefix="4dots-server-api-"))
RAM = Path("/dev/shm/4dots-server-api-ram")
SSD = ROOT / "drops"
SERVER = Path(__file__).resolve().parent / "server.py"
ok = True


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label} {detail}")


def call(path, data=None, method=None, headers=None):
    h = {"user-agent": "4dots-server-test"}
    h.update(headers or {})
    body = None if data is None else (data if isinstance(data, bytes) else json.dumps(data).encode())
    req = urllib.request.Request(B + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def create(ttl, ip="10.1.0.1"):
    st, body, _ = call("/api/drops", {"ttl": ttl}, "POST",
                       {"content-type": "application/json", "x-forwarded-for": ip})
    assert st == 201, (st, body)
    return json.loads(body)


def upload(code, reservation, parts, ip="10.1.0.1"):
    for index, part in enumerate(parts):
        st, body, _ = call(f"/api/drops/{code}/parts/{index}", part, "PUT",
                           {"content-type": "application/octet-stream", "x-reservation": reservation,
                            "x-forwarded-for": ip})
        assert st == 201, (st, body)


def commit(code, reservation, ttl, burn, parts, ip="10.1.0.1"):
    return call(f"/api/drops/{code}/commit",
                {"ttl": ttl, "burn": burn, "parts": parts}, "POST",
                {"content-type": "application/json", "x-reservation": reservation,
                 "x-forwarded-for": ip})


for path in (ROOT, RAM):
    if path.exists():
        subprocess.run(["rm", "-rf", str(path)])
    path.mkdir(parents=True, exist_ok=True)
SSD.mkdir(parents=True, exist_ok=True)
env = dict(os.environ,
           FOURDOTS_DATA=str(ROOT), FOURDOTS_PUBLIC=str(SERVER.parent / "public"),
           FOURDOTS_PORT="8093", FOURDOTS_RAM_DIR=str(RAM), FOURDOTS_SSD_DIR=str(SSD),
           FOURDOTS_RAM_MIN_MB="1", FOURDOTS_RAM_MIN_FREE_MB="1", FOURDOTS_RAM_MAX_MB="32",
           FOURDOTS_SWEEP_SECONDS="1")
log = open(ROOT / "server.log", "wb")
proc = subprocess.Popen([sys.executable, str(SERVER)], env=env, stdout=log, stderr=subprocess.STDOUT)
try:
    for _ in range(60):
        time.sleep(0.1)
        try:
            if call("/api/config")[0] == 200:
                break
        except Exception:
            continue

    print("=== config ===")
    st, body, _ = call("/api/config")
    cfg = json.loads(body)
    check("config answers", st == 200)
    check("config keeps the existing keys and adds the Direct capability",
          {"maxBytes", "partBytes", "ttls", "kdfIterations"} <= set(cfg) and cfg["direct"] is True,
          sorted(cfg))
    check("three TTL choices", cfg["ttls"] == [600, 3600, 86400], cfg["ttls"])

    print("\n=== multi-part round trip ===")
    info = create(3600)
    code, reservation = info["code"], info["reservation"]
    parts = [b"NMB2" + os.urandom(512 * 1024), os.urandom(512 * 1024)]
    upload(code, reservation, parts)
    st, body, _ = commit(code, reservation, 3600, False, len(parts))
    check("commit succeeds", st == 201, st)
    result = json.loads(body)
    check("commit returns expiry and revoke token", result["expiresAt"] > 0 and bool(result["revokeToken"]))
    st, body, headers = call(f"/api/drops/{code}")
    check("download is byte-identical", st == 200 and body == b"".join(parts), st)
    check("pepper header is present", bool(headers.get("x-drop-pepper")))
    check("tier header is present", headers.get("x-drop-tier") in ("ram", "ssd"))
    st, body, _ = call(f"/api/drops/{code}")
    check("a non-burn drop can be read twice", st == 200 and body == b"".join(parts))

    print("\n=== burn after reading ===")
    info = create(3600)
    upload(info["code"], info["reservation"], [b"NMB2" + b"x" * 1024])
    commit(info["code"], info["reservation"], 3600, True, 1)
    st, body, headers = call(f"/api/drops/{info['code']}")
    check("first read works and says burn", st == 200 and headers.get("x-drop-burn") == "1")
    st, body, _ = call(f"/api/drops/{info['code']}")
    check("second read is gone", st == 404, st)

    print("\n=== revoke ===")
    info = create(3600)
    upload(info["code"], info["reservation"], [b"NMB2" + b"y" * 1024])
    st, body, _ = commit(info["code"], info["reservation"], 3600, False, 1)
    token = json.loads(body)["revokeToken"]
    st, _, _ = call(f"/api/drops/{info['code']}", None, "DELETE",
                    {"x-revoke-token": "wrong", "x-forwarded-for": "10.1.0.2"})
    check("a wrong revoke token is refused", st == 403, st)
    st, _, _ = call(f"/api/drops/{info['code']}", None, "DELETE",
                    {"x-revoke-token": token, "x-forwarded-for": "10.1.0.2"})
    check("the sender can revoke", st == 204, st)
    check("a revoked drop is gone", call(f"/api/drops/{info['code']}")[0] == 404)

    print("\n=== expiry ===")
    info = create(600)
    upload(info["code"], info["reservation"], [b"NMB2" + b"z" * 1024])
    commit(info["code"], info["reservation"], 600, False, 1)
    with sqlite3.connect(ROOT / "state.db") as db:
        db.execute("UPDATE drops SET expires_at=? WHERE code=?",
                   (int(time.time() * 1000) - 1000, info["code"]))
        db.commit()
    st, _, _ = call(f"/api/drops/{info['code']}")
    check("an expired drop is gone", st == 404, st)

    print("\n=== rate limits ===")
    statuses = []
    for _ in range(32):
        st, _, _ = call("/api/drops", {"ttl": 600}, "POST",
                        {"content-type": "application/json", "x-forwarded-for": "10.1.9.9"})
        statuses.append(st)
    check("code reservations are rate-limited", statuses[-1] == 429 and statuses.count(429) >= 1,
          statuses[-3:])
    # Server-mode opens keep their existing behaviour: a missing code is a 404
    # (the counter is recorded, but /api/drops is deliberately unchanged).
    wrong = []
    for _ in range(3):
        st, _, _ = call("/api/drops/0000", None, "GET", {"x-forwarded-for": "10.1.9.8"})
        wrong.append(st)
    check("a missing Server code stays a 404", wrong == [404, 404, 404], wrong)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()

print("\nALL GREEN" if ok else "\nFAILURES ABOVE")
sys.exit(0 if ok else 1)
