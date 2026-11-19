#!/usr/bin/env python3
"""Measure a 4dots-compatible backend end to end, from the same machine.

  python3 bench.py <base_url> [size_mb] [rounds]

Reports the wall time for: reserve -> upload part -> commit, and for the
download leg. Run it against the hosted service and against your own
container and compare the numbers.
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099").rstrip("/")
SIZE_MB = int(sys.argv[2]) if len(sys.argv) > 2 else 30
ROUNDS = int(sys.argv[3]) if len(sys.argv) > 3 else 3
UA = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0 Safari/537.36"}
SIZE = SIZE_MB * 1024 * 1024


def call(url, data=None, method=None, headers=None):
    h = dict(UA); h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=300)
        return resp, resp.read()
    except urllib.error.HTTPError as e:
        return e, e.read()


def one_round(size):
    t0 = time.time()
    resp, body = call(f"{BASE}/api/drops", data=b"", method="POST", headers={"content-type": "application/json"})
    info = json.loads(body)
    code, tok = info["code"], info["reservation"]
    t_reserve = time.time() - t0

    payload = b"NMB2" + os.urandom(size)[4:]
    t1 = time.time()
    resp, body = call(f"{BASE}/api/drops/{code}/parts/0", data=payload, method="PUT",
                      headers={"content-type": "application/octet-stream", "x-reservation": tok})
    t_upload = time.time() - t1
    assert resp.status == 201, (resp.status, body[:200])

    t2 = time.time()
    resp, body = call(f"{BASE}/api/drops/{code}/commit",
                      data=json.dumps({"ttl": 600, "burn": False, "parts": 1}).encode(),
                      method="POST", headers={"content-type": "application/json", "x-reservation": tok})
    t_commit = time.time() - t2
    assert resp.status == 201, (resp.status, body[:200])

    t3 = time.time()
    got = 0
    r = urllib.request.urlopen(urllib.request.Request(f"{BASE}/api/drops/{code}", headers=UA), timeout=300)
    while True:
        c = r.read(1 << 20)
        if not c:
            break
        got += len(c)
    t_download = time.time() - t3
    assert got == size, f"downloaded {got} of {size}"

    print(f"  reserve {t_reserve*1000:6.0f} ms | upload {t_upload:5.2f}s ({size/1e6/t_upload:6.2f} MB/s) | "
          f"commit {t_commit*1000:5.0f} ms | download {t_download:5.2f}s ({size/1e6/t_download:6.2f} MB/s) | "
          f"total {t_reserve+t_upload+t_commit+t_download:5.2f}s")


print(f"{BASE}  ({SIZE_MB} MB per drop)")
for i in range(ROUNDS):
    print(f"round {i+1}:")
    one_round(SIZE)
