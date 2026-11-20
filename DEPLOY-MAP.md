# Deployment map

This is the operator's map for the self-hosted 4dots instance: where everything
lives, how the pieces connect, and how to run and roll it back. It deliberately
contains no hostnames, addresses, usernames, tokens or credentials.

The same deployment is described for end users in [README.md](README.md); the
longer engineering write-up is in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## The two machines

**The laptop** holds the working copy of this repository, the GitHub CLI
credentials and the SSH access to the server. Use it to commit, push, review and
cut releases.

**The Debian server** runs the app and the tunnel. Current toolchain:

| Tool | Version |
|---|---|
| Docker | 26.1.5 |
| Docker Compose | 2.26.1 |
| Python | 3.13.5 |
| git | 2.47.3 |

It has **no `gh`** and no GitHub credentials. It is reached with a `debian` shell
alias (a non-interactive `ssh` wrapper).

Two transfer details follow from that alias:

- `scp`, `rsync` and `git clone debian:/…` **do not work** — a bash alias is not
  an SSH host.
- Stream files instead:

```sh
debian 'cat > /tmp/file' < ./file          # upload
debian 'cat /tmp/file' > ./file            # download (binary-safe)
```

Never put a password in a command, a file, a log or a report. If a command would
prompt for one, stop and ask the operator.

## The live app

| Thing | Value |
|---|---|
| App directory (server) | `~/4dots` (the git checkout; also the data directory) |
| Container | `4dots` |
| Compose project | `4dots-ram` |
| Compose file | `~/4dots/compose.yaml` |
| Network | `4dots_default` (external; shared with the tunnel) |
| Port | `8080` inside the network, no host publish |
| Image | built locally as `4dots-ram-fourdots` |
| Data | `~/4dots/drops/` and `~/4dots/state.db` on the host, mounted at `/data` |

`compose.yaml` deliberately sets `name: 4dots-ram`. Do not remove it: without it,
Compose would adopt the old stack's project label (`4dots`) and a later
`docker compose down` could remove the wrong containers.

The app joins the network named by `FOURDOTS_NETWORK` (default `4dots_default`)
as an external network. The tunnel container is on that network and resolves the
app by its container name, `4dots`.

## Storage tiers

| Drop lifetime | Tier | Where |
|---|---|---|
| 10 minutes | RAM | tmpfs at `/ram` in the container |
| 1 hour | RAM | tmpfs at `/ram` in the container |
| 24 hours | SSD | `/data/drops` in the container = `~/4dots/drops` on the host |

Metadata (codes, expiry, tiers, part names) lives in `~/4dots/state.db` (SQLite,
WAL mode, `synchronous=FULL`).

Policy, enforced by the sweeper every `FOURDOTS_SWEEP_SECONDS` (15 s):

- the RAM tier is used only while at least `FOURDOTS_RAM_MIN_MB` (2048 MB) of
  memory is available;
- below that floor, every RAM drop is migrated to the SSD and new short-lived
  drops are written to the SSD;
- when memory recovers, short-lived drops use RAM again;
- migration is copy → verify size and SHA-256 → `fsync` → atomic rename →
  update metadata → remove the RAM copy. Codes, names, sizes and bytes do not
  change. A crash leaves a readable drop.

RAM is volatile: a reboot, power cut, `docker restart 4dots` or a re-create
destroys every RAM-tier drop. Those codes stop working. 24-hour drops survive.
The terms, privacy page and status page tell users this.

## Direct mode

The backend also brokers Direct sessions: two browsers connect over a WebRTC
data channel and the file never reaches the server. This does not change the
storage tiers.

- Signalling endpoints live under `/api/direct/*` on the same `4dots` container
  and port. They exchange SDP and ICE candidates over long polls of about one
  second; there is no WebSocket server.
- Metadata lives in the same `state.db`, in `direct_sessions` and
  `direct_signals`. The sweeper deletes expired sessions, sessions nobody joined
  after 15 minutes, and orphan signals.
- No Direct session writes to `/ram` or `/data/drops`. Only Server mode uses the
  tiers.
- The server sees both peers' IP addresses in the ICE candidates while a
  session is open. Codes are redacted in logs (`/api/direct/sessions/****`);
  peppers, SDP bodies and file names are never logged.
- STUN is the only ICE server. TURN is refused by both the backend and the
  frontend, so a failed direct path is reported, never silently relayed.
- Both peers must stay online. A Direct session is metadata in `state.db`, so a
  restart does not delete it, and the DataChannel itself does not depend on the
  server; a long poll interrupted by the restart retries on its own. There is no
  stored copy to lose because there is no stored copy.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `FOURDOTS_HOST` | `0.0.0.0` | Listen address inside the container. |
| `FOURDOTS_PORT` | `8080` | Listen port. |
| `FOURDOTS_DATA` | `/data` | Data root inside the container. |
| `FOURDOTS_PUBLIC` | `/app/public` | Static frontend directory. |
| `FOURDOTS_MAX_MB` | `1024` | Largest drop, in MB. |
| `FOURDOTS_PART_MB` | `64` | Upload part size, in MB. |
| `FOURDOTS_KDF_ITERATIONS` | `600000` | PBKDF2 rounds, served to the frontend via `/config.js`. Do not change mid-flight. |
| `FOURDOTS_RAM_DIR` | `/ram` | RAM tier root. Must be a real tmpfs or the RAM tier is refused. |
| `FOURDOTS_SSD_DIR` | `/data/drops` | SSD tier root. |
| `FOURDOTS_RAM_MIN_MB` | `2048` | Free memory that must remain before the RAM tier is used. |
| `FOURDOTS_RAM_MAX_MB` | `0` | Cap on the RAM tier; `0` means 40 % of total memory. |
| `FOURDOTS_RAM_MIN_FREE_MB` | `64` | Absolute free-memory guard used when picking the RAM mount. |
| `FOURDOTS_SWEEP_SECONDS` | `15` | Tier/expiry sweep interval. |
| `FOURDOTS_ORPHAN_GRACE_SECONDS` | `21600` | Unreferenced files younger than this are assumed to be uploads in flight and are not deleted. |
| `FOURDOTS_STUN_URLS` | `stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302` | Direct mode: comma-separated STUN URLs. `turn:` entries are ignored; there is no relay. |

Compose also reads two values from `.env` (never committed):

| Variable | Example | Meaning |
|---|---|---|
| `FOURDOTS_DATA_DIR` | `~/4dots` | Host directory mounted at `/data`. Defaults to `./data`. |
| `FOURDOTS_RAM_DISK_MB` | `1024` | tmpfs size, in MB. |
| `FOURDOTS_NETWORK` | `4dots_default` | External Docker network shared with the tunnel. |

The tmpfs size is deliberately conservative: 40 % of total memory would be a
larger cap, but the box also runs other services and the 2 GB RAM floor must stay
satisfiable.

## The tunnel

| Thing | Value |
|---|---|
| Container | `4dots-tunnel-1` |
| Image | `cloudflare/cloudflared` |
| Configuration | `/mnt/storage/4dots/cloudflared/config.yml` (mounted read-only at `/etc/cloudflared`) |
| Credentials | `/mnt/storage/4dots/cloudflared/credentials.json` — **never commit, never copy into the repo** |
| Ingress | `http://4dots:8080` |
| Fallback rule | `http_status:404` |

This is a locally-managed tunnel: the container runs
`cloudflared tunnel --config /etc/cloudflared/config.yml run`, not a token
connector. Do not replace it with a `--token` connector: that switches the tunnel
to Cloudflare's remote-managed configuration and can take the site down.

To change the origin, edit the single `service:` line in `config.yml` and restart
the container:

```sh
sed -i 's|service: http://4dots:8080|service: http://other:8080|' \
  /mnt/storage/4dots/cloudflared/config.yml
docker restart 4dots-tunnel-1
```

Any service name in the rule must be resolvable on the `4dots_default` network.

## The old deployment (rollback)

The previous Cloudflare Worker relay is still on disk and can be restarted:

| Thing | Value |
|---|---|
| Code and compose | `/mnt/storage/4dots/` |
| Container | `4dots-slow-version-backup` (Exited, restart policy `no`) |
| Image | `4dots-app:latest` |
| Original port | `127.0.0.1:8000` |
| Network aliases | `app`, `4dots-app-1` on `4dots_default` and `nimbo_default` |
| Captured config | `~/4dots-backup-inspect.json`, `~/4dots-backup-compose.yaml`, `~/4dots-backup-cloudflared-config.yml` |

The old compose file was edited in place so a future `docker compose up` there
would create `4dots-slow-version-backup` with `restart: "no"`, not resurrect
`4dots-app-1`. The pristine original is the `-backup-compose.yaml` copy.

**Never run `docker compose down` in `/mnt/storage/4dots`.** It would delete the
old stack and the tunnel container/credentials. Stop and rename only.

### Rollback

```sh
# 1. stop the new stack
cd ~/4dots && docker compose down

# 2. put the old container back
docker update --restart=unless-stopped 4dots-slow-version-backup
docker start 4dots-slow-version-backup
curl -s http://127.0.0.1:8000/api/config

# 3. point the tunnel back at the old alias
sed -i 's|service: http://4dots:8080|service: http://app:8000|' \
  /mnt/storage/4dots/cloudflared/config.yml
docker restart 4dots-tunnel-1
```

The old container's `app` alias is preserved on `4dots_default`, so the original
ingress rule works again. Reverting is deliberately two small changes.

## Daily commands

```sh
cd ~/4dots

docker compose ps                     # state of the app
docker compose logs --tail=100 fourdots
docker compose up -d --build fourdots # rebuild after a code change
docker compose restart fourdots       # RAM drops are lost; SSD drops survive
docker exec 4dots ls -l /ram /data/drops
docker exec 4dots df -h /ram /data/drops
curl -s http://127.0.0.1:8080/api/status   # needs a published port or exec
docker exec 4dots python -c \
  "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/api/status').read().decode())"
docker inspect 4dots-slow-version-backup --format '{{.HostConfig.RestartPolicy.Name}}'
docker stats --no-stream 4dots
```

Public checks (from the laptop, so the tunnel is exercised):

```sh
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://4dots.app/
curl -sS https://4dots.app/api/status | python3 -m json.tool
curl -sS https://4dots.app/api/config
curl -sI https://4dots.app/app.js | grep -i -E 'cache-control|etag|cf-cache-status'
```

## Static files and caching

`server.py` serves the frontend itself:

- HTML documents: `cache-control: no-cache, must-revalidate`, so a deploy is
  visible on the next load.
- JS/CSS/images: `public, max-age=300, must-revalidate` with an ETag derived from
  size and mtime; a matching `If-None-Match` gets `304`.
- `/config.js` (the PBKDF2 count): `public, max-age=60, must-revalidate`.

`index.html` is rewritten at serve time: `/app.js` and `/styles.css` are stamped
with their current mtime and size, `/config.js` with the PBKDF2 count. A deploy
therefore changes the asset URLs automatically; nothing has to be bumped by hand.
This is the reliable guard when a CDN in front applies its own long TTL.

The reference deployment sits behind Cloudflare, whose zone-level cache setting
currently rewrites the origin's `max-age` to 14400 s and can keep an old URL at
the edge for four hours. The auto-stamped URLs sidestep that; the unversioned
`/app.js` may still be a stale edge HIT until its TTL expires, but the page does
not request it. A cache purge, or setting Browser Cache TTL to "Respect Existing
Headers", needs a Cloudflare API token with cache/settings permissions — the
tunnel's own credential does not have them.

## Hard rules

1. Never `docker compose down` in `/mnt/storage/4dots`.
2. Keep `name: 4dots-ram` in `compose.yaml` and keep the external network.
   Changing the project name makes Compose adopt the old stack's containers.
3. Never `docker rm -v` a container that owns a volume with real data.
4. Never reboot the server. Restart only the containers you own.
5. No secrets in git or in reports: `.env`, `credentials.json`, `state.db`,
   `drops/`, `*.pem`, `*.key`, `DEPLOY-MAP.private.md`. All are ignored.
6. Commits belong to the active GitHub account, using its
   `<id>+<login>@users.noreply.github.com` address. No AI attribution or
   trailers.
7. The server has no `gh`: commit on the server (or a laptop checkout), then push
   from the laptop. The bundle workflow below avoids putting credentials on the
   server.
8. Verify, do not assume. Every claim in a report needs command output.

## GitHub and releases

The public repository is **https://github.com/4dotsapp/4dots**. The self-hosted
deployment lives on `main` alongside the upstream Worker app; the Worker files
(`worker/`, `package.json`, `wrangler.jsonc`, `docs/`) are still there and still
deployable.

The server has no GitHub credentials, so the workflow is:

```sh
# on the server: commit
cd ~/4dots
git add -A
git -c user.name="…" -c user.email="…@users.noreply.github.com" commit -m "…"

# on the laptop: fetch the history as a bundle and push
debian 'cd ~/4dots && git bundle create /tmp/4dots.bundle --all'
debian 'cat /tmp/4dots.bundle' > /tmp/4dots.bundle
rm -rf /tmp/4dots-push
git clone /tmp/4dots.bundle /tmp/4dots-push
cd /tmp/4dots-push
git remote add origin https://github.com/4dotsapp/4dots.git
git push origin HEAD:refs/heads/<branch>
```

Never force-push `main` and never rewrite upstream history. If the branch has no
shared ancestry with `main`, merge upstream into it first (or open a PR from a
branch based on `main`) so a squash cannot drop upstream files. Release tags are
annotated and pushed from the laptop; `gh release create` publishes the notes.
`gh auth status` must show the account that owns the repository before pushing.

## Behaviour notes

- Maximum drop: 1 GB. Upload parts: 64 MB. Expiry choices: 10 minutes, 1 hour,
  24 hours.
- Rate limits per IP: 30 code reservations and 12 wrong-code attempts per
  10 minutes.
- The image reveal on the Receive tab waits for `img.decode()` (raced with a 4 s
  timeout) before inserting the bitmap; the placeholder is a `--hairline` hatch
  with a `sweep` band. Do not move the `<img>` into the document before the
  decode completes — that reintroduces the half-painted JPEG.
- Burn-after-reading drops are deleted only after the whole payload reaches the
  client; a failed download leaves the drop in place.
- The orphan sweeper never deletes unreferenced files younger than
  `FOURDOTS_ORPHAN_GRACE_SECONDS`; an in-flight upload looks like an orphan.
- The status page reads `/api/status`; it includes `tiers.ram`, `tiers.ssd`,
  `tiers.migrations` and `tiers.migratedBytes`.
