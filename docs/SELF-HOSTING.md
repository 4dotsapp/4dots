# Self-hosting 4dots

This guide is for the self-hosted backend: a single-file Python server
(`server.py`, standard library only) that speaks the same API as the upstream
Cloudflare Worker and writes ciphertext straight to your disk. It uses the
upstream 4dots frontend ([MIT](../LICENSE-4dots-frontend)) unchanged apart from
the small hooks described below.

The point: the hosted 4dots.app is not slow because of your connection. It is
slow because every byte you send is relayed twice before it is stored, and that
relay tops out around **2–5 MB/s** no matter how fast your link is. Writing
straight to local storage removes the relay.

---

## 1. What 4dots.app actually does

Reading the upstream source (`worker/index.js`, `worker/nimbo.js`, `public/app.js`,
`public/crypto.js`), the hosted service is a Cloudflare Worker in front of
[nimbo.fun](https://nimbo.fun) storage:

```
your browser                     Cloudflare                nimbo.fun
     │                                │                         │
     │ 1. POST /api/drops             │                         │
     │    → {code, reservation, pepper}│                         │
     │                                │                         │
     │ 2. encrypt locally             │                         │
     │    PBKDF2-SHA256(code:pepper, 600 000 rounds)             │
     │    AES-256-GCM, 4 MiB chunks   │                         │
     │                                │                         │
     │ 3. PUT /api/drops/{code}/parts/0  (up to 90 MB)          │
     │──────────────────────────────► │                         │
     │                                │ 4. streams the body to  │
     │                                │    nimbo, wrapped in a  │
     │                                │    hand-built multipart │
     │                                │    envelope  ─────────► │
     │                                │                    5. writes it to storage
     │ 6. 201 {ok:true}                │◄───────────────────────│
     │◄─────────────────────────────── │                         │
     │ 7. POST /api/drops/{code}/commit → drop is live           │
```

Downloading is the same shape in reverse: the Worker pulls each part back out of
nimbo and pipes it through a `FixedLengthStream` to your browser.

Things worth knowing:

- **Encryption is entirely client-side.** The server only ever sees ciphertext,
  and the four-digit code plus a per-code pepper (a server secret) form the key.
  You can read the whole format in `public/crypto.js`.
- **The whole file is encrypted before the first byte is uploaded.** `seal()` runs
  to completion in `app.js`, then `uploadParts()` starts. There is no overlap
  between "encrypt" and "upload".
- **PBKDF2 at 600 000 rounds** happens before every send *and* every receive.
- **The Worker is a proxy, not a storage layer.** `worker/nimbo.js` re-uploads
  your ciphertext to nimbo's API; the bytes are copied through the Workers runtime
  and then written by nimbo. On the way back, nimbo → Worker → browser.
- **Storage is a third party.** nimbo.fun stores the ciphertext under random
  names, and its quota is what makes the public instance run out of space
  (the app then answers `507`).

## 2. Where the time goes (measured, not guessed)

All numbers from the same machine, same browser, same 30 MB file, interleaved so
link noise affects both sides equally.

| Path | Upload 30 MB | Download 30 MB |
|---|---|---|
| Direct to Cloudflare (`speed.cloudflare.com`), no 4dots | **0.58 s** (36 MB/s) | **0.22 s** (96 MB/s) |
| Through 4dots.app (Worker → nimbo → Worker) | **6.3 – 14.2 s** (2.2 – 5.0 MB/s) | **3.1 – 3.3 s** (9.4 – 10 MB/s) |
| Through this container (straight to disk) | **0.11 s** (275 MB/s) | **0.03 s** |

The first row is the important one: your browser can already push 30 MB to a
Cloudflare edge in well under a second from this machine. Everything 4dots.app
adds on top of that — 6 to 14 seconds — is the relay.

So on a link that can do 150 Mb/s (≈19 MB/s), the network is *not* your
bottleneck. 4dots' own relay is, at roughly a tenth of what your connection can
deliver. Your 8 seconds for 30 MB (3.75 MB/s) matches the measured relay
ceiling almost exactly.

Round trip through the hosted service, same file:

```
reserve 729 ms | upload 6.99 s | commit 535 ms | download 3.12 s | total 11.37 s
```

Browser-side costs, on top of the network:

| Step | Cost |
|---|---|
| `seal()` 30 MB (PBKDF2 600k + AES-GCM in 4 MiB chunks) | ≈ 1.0 s on desktop, more on a phone |
| PBKDF2 600 000 rounds alone | ≈ 0.6 s |
| Whole file encrypted before the first byte leaves | no upload/encrypt overlap |

## 3. What this container changes

Nothing about the crypto, nothing about the UI, nothing about the API. The
frontend is upstream's, unmodified except for one line that lets the server tell
`crypto.js` how many PBKDF2 rounds to use.

The server here:

- streams the ciphertext **straight to a file on your disk** — no proxy, no
  second copy, no third-party storage;
- keeps metadata in a small SQLite file next to it;
- implements the same endpoints, so the stock 4dots UI works against it unchanged.

Endpoints (identical to the Worker):

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/config` | `{maxBytes, partBytes, ttls, kdfIterations}` |
| `GET` | `/api/status` | health, used by the stock `/status` page |
| `POST` | `/api/drops` | reserves a 4-digit code, returns `{code, reservation, pepper, partBytes}` |
| `PUT` | `/api/drops/{code}/parts/{n}` | header `x-reservation`, `Content-Length` required, body must start with `NMB2` |
| `POST` | `/api/drops/{code}/commit` | header `x-reservation`, body `{ttl, burn, parts}` |
| `GET` | `/api/drops/{code}` | streams the ciphertext back, headers `x-drop-pepper`, `x-drop-burn`, `x-drop-expires-at` |
| `DELETE` | `/api/drops/{code}` | header `x-revoke-token` |

## 4. Running it

### Docker (recommended)

```sh
git clone https://github.com/4dotsapp/4dots.git
cd 4dots
cp .env.example .env
# edit .env: FOURDOTS_DATA_DIR (SSD tier + state.db) and, if needed, the network
docker network inspect 4dots_default >/dev/null 2>&1 || docker network create 4dots_default
docker compose up -d --build
```

`compose.yaml` runs one service, `fourdots`, on internal port 8080. It has two
volumes:

- `${FOURDOTS_DATA_DIR}:/data` — the SSD tier (`/data/drops`) and `state.db`;
- a tmpfs at `/ram` — the RAM tier, sized by `FOURDOTS_RAM_DISK_MB`.

It joins an external network, `FOURDOTS_NETWORK` (default `4dots_default`), where
a tunnel or reverse proxy can reach it by the container name `4dots`. Put a TLS
terminator or tunnel in front; the image does not terminate TLS itself.

### Without Docker

Python 3.10+ is the only requirement — the server is standard library only.

```sh
python3 server.py --port 8080 --data ./data --public ./public
```

### Your server is remote and behind CGNAT

If the machine has no public IPv4 or no open ports, any of these work
without port forwarding:

- **Cloudflare Tunnel** — the container makes an outbound connection, no inbound
  port needed:
  A locally-managed tunnel uses a config file plus credentials, not a token
  connector. The config is the shape this deployment runs:

  ```yaml
  tunnel: <tunnel-id>
  credentials: /etc/cloudflared/credentials.json
  ingress:
    - hostname: drop.example.com
      service: http://4dots:8080
    - service: http_status:404
  ```

  ```sh
  docker run --rm --network 4dots_default \
    -v /path/to/cloudflared:/etc/cloudflared:ro \
    cloudflare/cloudflared:latest \
    tunnel --no-autoupdate --config /etc/cloudflared/config.yml run
  ```

  If you prefer Cloudflare's token-managed mode, use
  `cloudflared tunnel --no-autoupdate run --token <TOKEN>` and configure the
  public hostname in the dashboard instead.
- **Tailscale** — `tailscale funnel` or just the tailnet address for your own devices.
- **A reverse SSH tunnel** to a small VPS you already have.

### Fronting it with nginx instead of Caddy

```nginx
server {
    listen 443 ssl http2;
    server_name drop.example.com;

    client_max_body_size 2G;      # big drops
    proxy_request_buffering off;  # stream the body through, do not buffer it
    proxy_buffering off;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
    }
}
```

`proxy_request_buffering off` matters: with the default on, nginx writes your
whole ciphertext to a temp file before forwarding it, which adds latency and
disk churn for no benefit.

## 4b. RAM-first storage tiers

The server keeps short-lived drops in **RAM** (a tmpfs) and long-lived ones on the
**SSD**, and moves between them on its own:

| Drop lifetime | Where it lives |
|---|---|
| 10 minutes | RAM tier (`/ram` in the container, a tmpfs) |
| 1 hour | RAM tier |
| 24 hours | SSD tier (`/data/drops` in the container, under `FOURDOTS_DATA_DIR` on the host) |

The RAM tier is only used while at least **2 GB** of memory is free
(`FOURDOTS_RAM_MIN_MB`). When free memory drops below that:

- every drop held in RAM is migrated to the SSD (the sweeper runs every
  `FOURDOTS_SWEEP_SECONDS`, 15 s by default);
- new 10-minute and 1-hour drops are written to the SSD as well;
- when memory recovers, short-lived drops go back to RAM.

Migration is crash-safe and lossless:

1. copy the ciphertext to the SSD tier, into a temp file;
2. verify the size **and the SHA-256** of the copy;
3. `fsync` and atomically `rename` it into place;
4. update the metadata (the file name never changes);
5. only then remove the RAM copy.

A crash at any point leaves a readable drop: the metadata is the source of truth
and the RAM copy is never deleted before the metadata says the file is on the SSD.
Codes, file names, sizes, expiry and bytes are identical before and after.

The expiry is declared by the frontend when it reserves a code (`POST /api/drops`
with `{"ttl": 3600}`), so the tier is decided before the first byte is uploaded. A
24-hour drop that somehow landed in RAM is moved to the SSD at commit time.

RAM is volatile. A reboot, a power cut or a container restart destroys the RAM tier;
those drops simply expire without a trace, and the codes stop working. 24-hour
drops live on the SSD and survive. The ToS, privacy policy and status page say so.

```sh
# which tier holds what
docker exec 4dots ls -l /ram /data/drops
curl -s http://127.0.0.1:8080/api/status | python3 -m json.tool   # includes "tiers"
```

`test_tiers.py` proves the whole policy end to end (TTL routing, migration under
memory pressure, byte-identical downloads, and recovery).

## 5. Tuning

| Knob | Default | Notes |
|---|---|---|
| `FOURDOTS_KDF_ITERATIONS` | `600000` | PBKDF2 rounds. Dropping to `100000` saves ~0.5 s per send *and* per receive on a phone. Both sides read the value from the same server, so they always agree. Do not change it while a drop is in flight. |
| `FOURDOTS_PART_MB` | `64` | Upload part size. Larger parts mean fewer round trips; parallel parts did **not** help on the hosted service (measured 4 parallel parts were *slower*). |
| `FOURDOTS_MAX_MB` | `1024` | Largest drop. |
| `FOURDOTS_RAM_DIR` | `/ram` | RAM tier root. It must be a real tmpfs or the RAM tier is refused. |
| `FOURDOTS_SSD_DIR` | `/data/drops` | SSD tier root. |
| `FOURDOTS_RAM_MIN_MB` | `2048` | Free memory that must remain available before the RAM tier is used. |
| `FOURDOTS_RAM_MAX_MB` | `0` (40% of RAM) | Cap on the RAM tier. |
| `FOURDOTS_SWEEP_SECONDS` | `15` | How often the tier policy and the expiry sweep run. |
| `FOURDOTS_ORPHAN_GRACE_SECONDS` | `21600` | Do not delete unreferenced blob files younger than this. An upload in progress is not in the metadata yet, so it looks like an orphan. |
| `FOURDOTS_STUN_URLS` | `stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302` | Direct mode: comma-separated STUN URLs. `turn:`/`turns:` entries are ignored; there is no relay. |
| `FOURDOTS_DATA_DIR` | `./data` | Host directory mounted at `/data` (SSD tier and `state.db`). Read by Compose from `.env`. |
| `FOURDOTS_NETWORK` | `4dots_default` | External Docker network shared with the tunnel. Read by Compose from `.env`. |

If you also want to cut the encryption time itself, the next step would be
encrypting chunks in parallel Web Workers instead of one at a time; that is a
frontend change, not a server one.

### Direct mode

The self-hosted backend also offers a Direct mode. It is on whenever the
frontend can reach `/api/direct/config`; the upstream Cloudflare Worker does not
implement that endpoint, so its copy of the same frontend stays Server-only and
hides the choice.

- **Signalling only.** `POST /api/direct/sessions` mints a code and a pepper;
  `POST .../join`, `POST .../signal` and the ~1 s `GET .../signal` long poll
  exchange SDP and ICE candidates; `DELETE ...` cancels. Sessions live in two
  SQLite tables, `direct_sessions` and `direct_signals`, and the sweeper removes
  expired ones. No file bytes ever reach the server, and nothing is written to
  the RAM or SSD tiers.
- **Requirements.** A secure context (HTTPS, or `localhost`) and a reachable
  STUN server. Both peers must stay online for the whole transfer; there is no
  stored copy and no 24-hour recovery.
- **No TURN.** Setting a `turn:` URL in `FOURDOTS_STUN_URLS` has no effect: the
  server drops non-STUN entries and the browser is never given a relay. If the
  two networks cannot meet directly, the transfer fails and the UI offers Server
  mode; if a relay pair ever appeared, the UI reports it as not direct instead
  of pretending.
- **What the server sees.** Both peers' IP addresses in the ICE candidates, the
  session code, timestamps and token hashes. It does not log the code (it is
  redacted as `****`), the pepper, SDP bodies or file names. A public STUN
  server also sees each client's IP; point `FOURDOTS_STUN_URLS` at your own if
  you prefer.

## 6. Checking the numbers on your own box

```sh
python3 bench.py https://4dots.app 30 3     # the hosted upstream service
python3 bench.py http://127.0.0.1:8080 30 3  # your container
```

`e2e_test.py` (in the repository root) drives the real UI in a headless
browser: it attaches a file, sends it, reads the four-digit code back, then
opens the drop in a fresh browser context and checks the file comes back
intact.

## 7. Security notes

- The server only ever receives ciphertext. The four-digit code and the pepper
  are the only secrets, and the pepper never leaves the server.
- A four-digit code is 10 000 possibilities. Rate limits are on by default
  (30 new drops and 12 wrong codes per IP per 10 minutes). Treat a drop as
  "private for a few minutes", not as a vault.
- Put it behind TLS. The frontend is served with the same strict CSP, `nosniff`,
  `no-referrer` and `frame-ancestors 'none'` as upstream.
- Whoever runs the server holds the pepper. That is the same trade-off the
  upstream service makes; run it yourself and it is your secret, not theirs.
- The `data/` directory holds the ciphertext. It is deleted when the drop
  expires, when it burns, or when you delete it early.

## 8. Static files and caching

`server.py` serves the frontend itself and sets cache headers:

- HTML documents: `no-cache, must-revalidate`, so a deploy is visible on the next
  load and an edge cache cannot hold a stale page;
- JS/CSS/images: `public, max-age=300, must-revalidate` plus an `ETag` from the
  file's size and mtime, answering `304` to a matching `If-None-Match`;
- `/config.js` (the PBKDF2 count): `public, max-age=60, must-revalidate`.

`index.html` is rewritten when it is served: the `/app.js` and `/styles.css`
URLs are stamped with the file's current mtime and size, and `/config.js` with
the PBKDF2 count. Every deploy therefore publishes new asset URLs automatically,
without a hand-bumped `?v=` key. That matters when a CDN in front applies its own
long asset TTL: the HTML is `no-cache` and always fresh, and a changed asset is a
new cache key. The `?v=` in the repository is only a placeholder.

## 9. Licence

- `public/` — the upstream 4dots frontend, MIT, © the 4dots authors (see
  [`LICENSE-4dots-frontend`](../LICENSE-4dots-frontend)).
- `server.py`, `bench.py`, `e2e_test.py`, `test_tiers.py`, `Dockerfile` and
  `compose.yaml` — MIT, under the repository's [`LICENSE`](../LICENSE).
