#!/usr/bin/env python3
"""Protocol test for Direct mode: sessions, signalling, auth, expiry, logging.

Owns a server process against a throwaway database and proves the backend never
stores file content: only metadata and SDP/ICE messages exist, and both storage
tiers stay empty.
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

B = "http://127.0.0.1:8096"
ROOT = Path(tempfile.mkdtemp(prefix="4dots-direct-"))
RAM = Path(os.environ.get("FOURDOTS_TEST_RAM") or "/dev/shm/4dots-direct-test")
SSD = ROOT / "drops"
SERVER = Path(__file__).resolve().parent / "server.py"
LOG = ROOT / "server.log"
ok = True


def check(label, condition, detail=""):
    global ok
    ok = ok and bool(condition)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label} {detail}")


def call(path, data=None, method=None, headers=None):
    h = {"user-agent": "4dots-direct-test"}
    h.update(headers or {})
    body = None if data is None else (data if isinstance(data, bytes) else json.dumps(data).encode())
    req = urllib.request.Request(B + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.read(), dict(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


def session(ttl=600, ip="10.0.0.1", local_only=False):
    st, body, _ = call("/api/direct/sessions", {"ttl": ttl, "localOnly": local_only}, "POST",
                       {"content-type": "application/json", "x-forwarded-for": ip})
    assert st == 201, (st, body)
    return json.loads(body)


def join(code, ip="10.0.0.2"):
    return call(f"/api/direct/sessions/{code}/join", {}, "POST",
                {"content-type": "application/json", "x-forwarded-for": ip})


def signal(code, token, kind, data, ip="10.0.0.1"):
    return call(f"/api/direct/sessions/{code}/signal", {"kind": kind, "data": data}, "POST",
                {"content-type": "application/json", "x-session-token": token,
                 "x-forwarded-for": ip})


def poll(code, token, since=0, ip="10.0.0.1"):
    return call(f"/api/direct/sessions/{code}/signal?since={since}", None, "GET",
                {"x-session-token": token, "x-forwarded-for": ip})


def files_in(path):
    return sorted(p.name for p in Path(path).iterdir()) if Path(path).exists() else []


for path in (ROOT, SSD, RAM):
    if path.exists():
        subprocess.run(["rm", "-rf", str(path)])
    path.mkdir(parents=True, exist_ok=True)

env = dict(os.environ,
           FOURDOTS_DATA=str(ROOT), FOURDOTS_PUBLIC=str(SERVER.parent / "public"),
           FOURDOTS_PORT="8096", FOURDOTS_RAM_DIR=str(RAM), FOURDOTS_SSD_DIR=str(SSD),
           FOURDOTS_RAM_MIN_MB="1", FOURDOTS_RAM_MIN_FREE_MB="1", FOURDOTS_RAM_MAX_MB="32",
           FOURDOTS_SWEEP_SECONDS="1",
           FOURDOTS_STUN_URLS="turn:relay.example:3478,stun:stun.example:3478")
with open(LOG, "wb") as log:
    proc = subprocess.Popen([sys.executable, str(SERVER)], env=env,
                            stdout=log, stderr=subprocess.STDOUT)
try:
    for _ in range(60):
        time.sleep(0.1)
        try:
            if call("/api/config")[0] == 200:
                break
        except Exception:
            continue
    else:
        raise RuntimeError("server did not start")

    print("=== config ===")
    st, body, _ = call("/api/direct/config")
    cfg = json.loads(body)
    check("config answers", st == 200)
    check("Direct is enabled", cfg.get("enabled") is True)
    base = json.loads(call("/api/config")[1])
    check("/api/config advertises Direct", base.get("direct") is True)
    check("STUN is exposed", cfg.get("stunUrls") == ["stun:stun.example:3478"], cfg.get("stunUrls"))
    check("TURN is never exposed", all(u.startswith("stun:") for u in cfg.get("stunUrls", [])))

    print("\n=== session creation and the join gate ===")
    info = session()
    code, pepper, sender = info["code"], info["pepper"], info["sessionToken"]
    check("code is four digits", len(code) == 4 and code.isdigit(), code)
    check("pepper and sender token are present", bool(pepper) and bool(sender))
    check("expiry is set", info["expiresAt"] > time.time() * 1000)
    wrong = "0000" if code != "0000" else "1111"
    st, body, _ = join(wrong, ip="10.0.1.1")
    check("wrong code is a generic 404", st == 404, st)
    st, body, _ = join(code)
    joined = json.loads(body)
    check("correct code joins", st == 200)
    check("join hands over the same pepper", joined.get("pepper") == pepper)
    check("join mints a receiver token", joined.get("sessionToken") and joined["sessionToken"] != sender)
    receiver = joined["sessionToken"]
    st, _, _ = join(code, ip="10.0.0.3")
    check("a second recipient is refused", st == 409, st)

    info = session(ip="10.0.5.1", local_only=True)
    st, body, _ = join(info["code"], ip="10.0.5.2")
    check("Local network only is carried to the recipient",
          info["localOnly"] is True and json.loads(body).get("localOnly") is True)
    call(f"/api/direct/sessions/{info['code']}", None, "DELETE",
         {"x-session-token": info["sessionToken"], "x-forwarded-for": "10.0.5.1"})

    print("\n=== signalling ===")
    marker = "SECRET-SDP-MARKER"
    st, body, _ = signal(code, sender, "offer", {"type": "offer", "sdp": marker})
    check("sender can post an offer", st == 200, st)
    st, body, _ = poll(code, receiver)
    events = json.loads(body)["events"] if st == 200 else []
    check("receiver sees the offer", any(e["kind"] == "offer" and e["data"]["sdp"] == marker for e in events))
    st, body, _ = signal(code, receiver, "answer", {"type": "answer", "sdp": "ANSWER"})
    check("receiver can post an answer", st == 200, st)
    st, body, _ = signal(code, sender, "candidate", {"candidate": "candidate:1 1 udp 1 10.0.0.1 5000 typ host"})
    check("either side can trickle candidates", st == 200, st)
    since = json.loads(body)["seq"]
    st, body, _ = poll(code, receiver, since=0)
    seqs = [e["seq"] for e in json.loads(body)["events"]]
    check("events are ordered", seqs == sorted(seqs), seqs)

    st, _, _ = signal(code, receiver, "offer", {"sdp": "x"})
    check("only the sender may offer", st == 403, st)
    st, _, _ = signal(code, sender, "answer", {"sdp": "x"})
    check("only the recipient may answer", st == 403, st)
    st, _, _ = signal(code, "not-a-token", "candidate", {})
    check("a bad token is refused", st == 403, st)
    st, _, _ = call(f"/api/direct/sessions/{code}/signal", {"kind": "candidate", "data": {}},
                    "POST", {"content-type": "application/json", "x-session-token": sender})
    check("an empty signalling message is accepted", st == 200, st)
    st, _, _ = signal(code, sender, "candidate", {"padding": "x" * 70_000})
    check("an oversized message is refused", st == 413, st)
    st, _, _ = signal(code, sender, "bogus", {})
    check("an unknown kind is refused", st == 400, st)

    print("\n=== long poll ===")
    started = time.monotonic()
    st, body, _ = poll(code, receiver, since=10_000, ip="10.0.2.1")
    elapsed = time.monotonic() - started
    check("an idle poll returns 204", st == 204, st)
    check("an idle poll holds about one second", 0.8 <= elapsed <= 2.0, f"{elapsed:.2f}s")

    print("\n=== no file content, no storage ===")
    check("RAM tier stays empty", files_in(RAM) == [], files_in(RAM))
    check("SSD tier stays empty", files_in(SSD) == [], files_in(SSD))

    print("\n=== delete is idempotent ===")
    st, _, _ = call(f"/api/direct/sessions/{code}", None, "DELETE",
                    {"x-session-token": receiver, "x-forwarded-for": "10.0.2.1"})
    check("recipient can cancel", st == 204, st)
    st, _, _ = poll(code, receiver, ip="10.0.2.1")
    check("a live poll in flight gets a clean 204, not a 404", st == 204, st)
    st, _, _ = call(f"/api/direct/sessions/{code}", None, "DELETE",
                    {"x-session-token": receiver, "x-forwarded-for": "10.0.2.1"})
    check("deleting it again is a no-op", st == 204, st)
    gone = False
    for _ in range(50):
        time.sleep(0.2)
        if poll(code, receiver, ip="10.0.2.1")[0] == 404:
            gone = True
            break
    check("the session is gone after the tombstone", gone)

    print("\n=== expiry and unjoined cleanup ===")
    info = session(ttl=600, ip="10.0.3.1")
    with sqlite3.connect(ROOT / "state.db") as db:
        db.execute("UPDATE direct_sessions SET expires_at=? WHERE code=?",
                   (int(time.time() * 1000) - 1000, info["code"]))
        db.commit()
    for _ in range(30):
        time.sleep(0.2)
        if poll(info["code"], info["sessionToken"])[0] == 404:
            break
    time.sleep(2)
    with sqlite3.connect(ROOT / "state.db") as db:
        left = db.execute("SELECT COUNT(*) FROM direct_sessions WHERE code=?",
                          (info["code"],)).fetchone()[0]
        signals = db.execute("SELECT COUNT(*) FROM direct_signals WHERE code=?",
                             (info["code"],)).fetchone()[0]
    check("an expired session disappears", left == 0, left)
    check("its signals are cleaned up", signals == 0, signals)

    info = session(ip="10.0.3.2")
    with sqlite3.connect(ROOT / "state.db") as db:
        db.execute("UPDATE direct_sessions SET created_at=? WHERE code=?",
                   (int(time.time() * 1000) - 20 * 60 * 1000, info["code"]))
        db.commit()
    time.sleep(3)
    with sqlite3.connect(ROOT / "state.db") as db:
        left = db.execute("SELECT COUNT(*) FROM direct_sessions WHERE code=?",
                          (info["code"],)).fetchone()[0]
    check("a session nobody joined is swept after 15 minutes", left == 0, left)

    print("\n=== rate limits ===")
    for i in range(13):
        st, _, _ = join("9999", ip="10.0.4.1")
    check("wrong Direct codes are rate-limited", st == 429, st)

    print("\n=== logs ===")
    time.sleep(0.2)
    log = LOG.read_text(errors="replace")
    check("the pepper never reaches the log", pepper not in log)
    check("Direct codes are redacted",
          f"/api/direct/sessions/{code}" not in log and "/api/direct/sessions/****" in log)
    check("SDP bodies never reach the log", marker not in log)
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()

print("\nALL GREEN" if ok else "\nFAILURES ABOVE")
sys.exit(0 if ok else 1)
