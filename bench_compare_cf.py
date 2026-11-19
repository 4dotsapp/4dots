#!/usr/bin/env python3
"""Interleaved A/B: raw Cloudflare vs the 4dots worker->nimbo relay, same bytes, same link."""
import json, os, time, urllib.request, urllib.error, statistics

UA = {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}
SIZE = 20 * 1024 * 1024
ROUNDS = 3


def raw_get(url, headers=None):
    h = dict(UA); h.update(headers or {})
    resp = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=300)
    n = 0
    while True:
        c = resp.read(1 << 20)
        if not c:
            break
        n += len(c)
    return n


def raw_put(url, data):
    h = dict(UA); h["content-type"] = "application/octet-stream"
    resp = urllib.request.urlopen(urllib.request.Request(url, data=data, method="POST", headers=h), timeout=300)
    return resp.read()


def api(url, data=None, method=None, headers=None):
    h = dict(UA); h.update(headers or {})
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=300)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.status, e.read()


def fourdots_upload(size):
    st, body = api("https://4dots.app/api/drops", data=b"", method="POST", headers={"content-type": "application/json"})
    info = json.loads(body)
    code, tok = info["code"], info["reservation"]
    payload = b"NMB2" + os.urandom(size)[4:]
    t0 = time.time()
    st, b = api(f"https://4dots.app/api/drops/{code}/parts/0", data=payload, method="PUT",
                headers={"content-type": "application/octet-stream", "x-reservation": tok})
    up = time.time() - t0
    assert st == 201, (st, b[:200])
    api(f"https://4dots.app/api/drops/{code}/commit", data=json.dumps({"ttl": 600, "burn": False, "parts": 1}).encode(),
        method="POST", headers={"content-type": "application/json", "x-reservation": tok})
    return code, up


def fourdots_download(code):
    t0 = time.time()
    n = raw_get(f"https://4dots.app/api/drops/{code}")
    return n, time.time() - t0


res = {"cf_up": [], "dots_up": [], "cf_down": [], "dots_down": []}
payload = b"NMB2" + os.urandom(SIZE)[4:]

for i in range(ROUNDS):
    t0 = time.time(); raw_put("https://speed.cloudflare.com/__up", payload); dt = time.time() - t0
    res["cf_up"].append(dt); print(f"round {i+1}: raw CF upload      {dt:6.2f}s  {SIZE/1e6/dt:6.2f} MB/s")

    code, up = fourdots_upload(SIZE)
    res["dots_up"].append(up); print(f"round {i+1}: 4dots upload      {up:6.2f}s  {SIZE/1e6/up:6.2f} MB/s")

    t0 = time.time(); raw_get(f"https://speed.cloudflare.com/__down?bytes={SIZE}"); dt = time.time() - t0
    res["cf_down"].append(dt); print(f"round {i+1}: raw CF download    {dt:6.2f}s  {SIZE/1e6/dt:6.2f} MB/s")

    n, dt = fourdots_download(code)
    res["dots_down"].append(dt); print(f"round {i+1}: 4dots download    {dt:6.2f}s  {n/1e6/dt:6.2f} MB/s")
    print()

print("=== medians ===")
for k, v in res.items():
    m = statistics.median(v)
    print(f"  {k:12s} median {m:6.2f}s  ({SIZE/1e6/m:6.2f} MB/s)   all={[round(x,2) for x in v]}")
print(f"\n  relay overhead (upload): 4dots is {statistics.median(res['cf_up'])/statistics.median(res['dots_up']):.1f}x slower than direct CF")
print(f"  relay overhead (download): 4dots is {statistics.median(res['cf_down'])/statistics.median(res['dots_down']):.1f}x slower than direct CF")
