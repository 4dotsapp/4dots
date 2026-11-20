#!/usr/bin/env python3
"""
4dots-compatible self-hosted backend with RAM-first (tmpfs) storage.

Speaks the same HTTP API as the upstream 4dots Cloudflare Worker, so the
4dots frontend works against it unchanged. Two things differ from the hosted
service, both of them in your favour:

  1. Ciphertext is streamed straight to storage instead of being relayed
     through a Worker and a third-party storage API. That removes the ~10x
     relay overhead of the hosted service.
  2. Storage is tiered. Short-lived drops live in RAM (a tmpfs), long-lived
     ones live on SSD, and the server migrates between the two on its own.

Storage tiers
-------------
  * 10 min / 1 hour  -> RAM tier  (fastest; volatile: a reboot or power loss
                        loses these drops. That is stated in the ToS.)
  * 24 hours         -> SSD tier  (survives reboots)
  * RAM tier active  -> only while at least FOURDOTS_RAM_MIN_MB of memory is
                        available. Below that, every RAM drop is migrated to
                        SSD and new short-lived drops go straight to SSD.

Migration is crash-safe: the copy is verified (size + SHA-256), written to a
temp file, fsync'd, atomically renamed, and only then is the metadata updated
and the RAM copy removed. A crash at any point leaves a readable drop.

Only the Python standard library is used.
"""
import argparse
import base64
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAGIC = b"NMB2"
TTLS = [600, 3600, 86400]
RAM_TTLS = (600, 3600)      # short-lived: allowed in RAM
SSD_ONLY_TTLS = (86400,)    # long-lived: always on SSD
SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
}
LIMITS = {  # kind -> (max, window seconds)
    "create": (30, 600),
    "miss": (12, 600),
    "signal": (600, 600),
}
# Direct mode: the server only carries SDP and ICE candidates between two peers.
# It never receives file bytes, so a Direct session is metadata only.
DIRECT_KINDS = ("offer", "answer", "candidate", "bye")
DIRECT_MAX_BODY = 64 * 1024          # one signalling message, SDP included
DIRECT_MAX_EVENTS = 512              # per session, so a peer cannot grow the row forever
DIRECT_POLL_SECONDS = 1.0            # a long poll holds its thread at most this long
DIRECT_POLL_STEP = 0.1
DIRECT_SWEEP_GRACE_SECONDS = 15 * 60  # an unjoined session this old is dropped
DEFAULT_STUN_URLS = "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302"
# A part file is written under its final name and only recorded in the database
# once the upload finishes, so an in-flight upload looks like an orphan to the
# sweeper. Never delete an unreferenced file until it has been idle this long.
DEFAULT_ORPHAN_GRACE_SECONDS = 6 * 3600
TIER_RAM = "ram"
TIER_SSD = "ssd"


def token(nbytes: int = 24) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(nbytes)).decode().rstrip("=")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mem_available_bytes() -> int:
    """MemAvailable from /proc/meminfo, in bytes. 0 when it cannot be read."""
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return 0


def mem_total_bytes() -> int:
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) * 1024
    except Exception:
        pass
    return 0


def fstype_for(path: Path) -> str:
    """Filesystem type of the mount that contains `path`."""
    best = ("", "")
    target = str(path.resolve() if path.exists() else path)
    try:
        with open("/proc/mounts") as fh:
            for line in fh:
                fields = line.split()
                if len(fields) < 3:
                    continue
                mountpoint = fields[1].replace("\\040", " ")
                if (target == mountpoint or target.startswith(mountpoint.rstrip("/") + "/")) \
                        and len(mountpoint) > len(best[0]):
                    best = (mountpoint, fields[2])
    except Exception:
        pass
    return best[1]


class Store:
    """SQLite metadata plus ciphertext parts in two storage tiers."""

    def __init__(self, root: Path, max_bytes: int, part_bytes: int,
                 ram_dir: Path, ssd_dir: Path, ram_min_bytes: int, ram_max_bytes: int,
                 ram_min_free_bytes: int = 64 * 1024 * 1024,
                 orphan_grace_seconds: int = DEFAULT_ORPHAN_GRACE_SECONDS):
        self.root = root
        self.orphan_grace_seconds = max(0, orphan_grace_seconds)
        self.max_bytes = max_bytes
        self.part_bytes = part_bytes
        self.ram_min_bytes = ram_min_bytes
        self.ram_max_bytes = ram_max_bytes
        self.ram_min_free_bytes = ram_min_free_bytes
        self.tiers = {TIER_RAM: ram_dir, TIER_SSD: ssd_dir}
        for path in self.tiers.values():
            path.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(root / "state.db", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS drops (
                   code TEXT PRIMARY KEY,
                   reservation TEXT,
                   pepper TEXT,
                   parts TEXT DEFAULT '{}',
                   tier TEXT DEFAULT 'ssd',
                   burn INTEGER DEFAULT 0,
                   ttl INTEGER,
                   expires_at INTEGER,
                   revoke_hash TEXT,
                   created_at INTEGER,
                   opened INTEGER DEFAULT 0,
                   committed INTEGER DEFAULT 0)"""
        )
        # Direct mode. A session is a code, a pepper and a pair of capability
        # hashes; the signals table holds only SDP and ICE candidates.
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS direct_sessions (
                   code TEXT PRIMARY KEY,
                   pepper TEXT,
                   sender_hash TEXT,
                   receiver_hash TEXT,
                   ttl INTEGER,
                   created_at INTEGER,
                   expires_at INTEGER,
                   joined_at INTEGER,
                   last_seq INTEGER DEFAULT 0,
                   closed_at INTEGER,
                   local_only INTEGER DEFAULT 0)"""
        )
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS direct_signals (
                   code TEXT,
                   seq INTEGER,
                   role TEXT,
                   kind TEXT,
                   data TEXT,
                   created_at INTEGER,
                   PRIMARY KEY (code, seq))"""
        )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS direct_signals_code ON direct_signals(code, seq)"
        )
        self._migrate_schema()
        self.db.commit()
        self.rate = {}
        self.rate_lock = threading.Lock()
        self.stats_lock = threading.Lock()
        self.migrations = 0
        self.migrated_bytes = 0

    def _migrate_schema(self) -> None:
        """Bring an older database up to the current columns."""
        have = {row[1] for row in self.db.execute("PRAGMA table_info(drops)")}
        for column, ddl in (("tier", "TEXT DEFAULT 'ssd'"),):
            if column not in have:
                self.db.execute(f"ALTER TABLE drops ADD COLUMN {column} {ddl}")
        have = {row[1] for row in self.db.execute("PRAGMA table_info(direct_sessions)")}
        if "closed_at" not in have:
            self.db.execute("ALTER TABLE direct_sessions ADD COLUMN closed_at INTEGER")
        if "local_only" not in have:
            self.db.execute("ALTER TABLE direct_sessions ADD COLUMN local_only INTEGER DEFAULT 0")

    # ── tiers ──
    def tier_dir(self, tier: str) -> Path:
        return self.tiers.get(tier, self.tiers[TIER_SSD])

    def ram_available(self) -> int:
        """Bytes of memory that may still be used by the RAM tier."""
        free = mem_available_bytes()
        return max(0, free - self.ram_min_bytes)

    def ram_ok(self) -> bool:
        """Is the RAM tier usable right now?"""
        ram_dir = self.tiers[TIER_RAM]
        if not ram_dir.exists():
            return False
        if fstype_for(ram_dir) != "tmpfs":
            return False  # not RAM at all: refuse to pretend
        if mem_available_bytes() < self.ram_min_bytes:
            return False
        try:
            usage = shutil.disk_usage(ram_dir)
            if usage.free < self.ram_min_free_bytes:
                return False
        except Exception:
            return False
        return True

    def tier_for_ttl(self, ttl: int) -> str:
        """Where a drop with this expiry belongs."""
        if ttl in SSD_ONLY_TTLS:
            return TIER_SSD
        if ttl in RAM_TTLS and self.ram_ok():
            return TIER_SSD if self.ram_used_bytes() >= self.ram_max_bytes else TIER_RAM
        return TIER_SSD

    def ram_used_bytes(self) -> int:
        """How much of the RAM tier is in use right now."""
        total = 0
        with self.lock:
            rows = self.db.execute("SELECT parts FROM drops WHERE tier=?", (TIER_RAM,)).fetchall()
        for (parts_json,) in rows:
            for part in self._parts(parts_json).values():
                if part.get("tier") == TIER_RAM:
                    total += int(part.get("size", 0))
        return total

    @staticmethod
    def _parts(parts_json) -> dict:
        parts = json.loads(parts_json or "{}")
        out = {}
        for index, value in parts.items():
            if isinstance(value, str):          # legacy format: name only
                out[index] = {"name": value, "tier": TIER_SSD, "size": 0}
            else:
                out[index] = value
        return out

    # ── rate limiting ──
    def blocked(self, kind: str, ip: str) -> int:
        limit, window = LIMITS[kind]
        now = time.time()
        with self.rate_lock:
            entry = self.rate.get((kind, ip))
            if not entry or entry[1] <= now:
                entry = [0, now + window]
            return 0 if entry[0] < limit else max(1, int(entry[1] - now))

    def hit(self, kind: str, ip: str) -> None:
        limit, window = LIMITS[kind]
        now = time.time()
        with self.rate_lock:
            entry = self.rate.get((kind, ip))
            if not entry or entry[1] <= now:
                entry = [0, now + window]
            entry[0] += 1
            self.rate[(kind, ip)] = entry

    # ── code allocation ──
    def reserve(self, ip: str, ttl: int) -> dict:
        now = int(time.time() * 1000)
        tier = self.tier_for_ttl(ttl)
        with self.lock:
            for _ in range(200):
                code = f"{secrets.randbelow(10000):04d}"
                row = self.db.execute(
                    "SELECT expires_at, committed FROM drops WHERE code=?", (code,)
                ).fetchone()
                if row and row[1] and row[0] and row[0] > now:
                    continue  # a live drop owns this code
                reservation, pepper = token(), token()
                self.db.execute(
                    "INSERT OR REPLACE INTO drops (code, reservation, pepper, parts, tier, burn,"
                    " ttl, expires_at, revoke_hash, created_at, opened, committed)"
                    " VALUES (?,?,?,'{}',?,0,NULL,NULL,NULL,?,0,0)",
                    (code, reservation, pepper, tier, now),
                )
                self.db.commit()
                return {"code": code, "reservation": reservation, "pepper": pepper, "tier": tier}
        raise ApiError(503, "No free codes right now.")

    def reservation(self, code: str, token_value: str):
        row = self.db.execute(
            "SELECT reservation, pepper, parts, tier, ttl, burn, expires_at, revoke_hash, committed"
            " FROM drops WHERE code=?", (code,)
        ).fetchone()
        if not row:
            return None
        stored, pepper, parts, tier, ttl, burn, expires_at, revoke_hash, committed = row
        if not stored or not hmac.compare_digest(stored, token_value):
            return None
        return {
            "pepper": pepper,
            "parts": self._parts(parts),
            "tier": tier or TIER_SSD,
            "ttl": ttl,
            "burn": bool(burn),
            "expires_at": expires_at,
            "revoke_hash": revoke_hash,
            "committed": committed,
        }

    def drop(self, code: str):
        return self.db.execute(
            "SELECT reservation, pepper, parts, tier, ttl, burn, expires_at, revoke_hash,"
            " committed, opened FROM drops WHERE code=?", (code,)
        ).fetchone()

    def note_part(self, code: str, index: int, name: str, size: int, tier: str) -> None:
        with self.lock:
            row = self.db.execute("SELECT parts FROM drops WHERE code=?", (code,)).fetchone()
            parts = self._parts(row[0]) if row else {}
            old = parts.get(str(index))
            parts[str(index)] = {"name": name, "tier": tier, "size": size}
            self.db.execute(
                "UPDATE drops SET parts=?, tier=? WHERE code=?",
                (json.dumps(parts), tier, code),
            )
            self.db.commit()
        if old and old.get("name") and old["name"] != name:
            (self.tier_dir(old.get("tier", TIER_SSD)) / old["name"]).unlink(missing_ok=True)

    def commit(self, code: str, ttl: int, burn: bool, parts: int) -> dict:
        now = int(time.time() * 1000)
        with self.lock:
            row = self.db.execute("SELECT parts FROM drops WHERE code=?", (code,)).fetchone()
            if not row:
                raise ApiError(404, "No drop matches that code.")
            known = self._parts(row[0])
            for i in range(parts):
                if str(i) not in known:
                    raise ApiError(400, "Part of the upload is missing. Please try again.")
            total = sum(int(known[str(i)].get("size", 0)) for i in range(parts))
            if total > self.max_bytes:
                raise ApiError(413, "That drop is too large.")
            revoke = token()
            self.db.execute(
                "UPDATE drops SET ttl=?, burn=?, expires_at=?, revoke_hash=?, committed=1 WHERE code=?",
                (ttl, 1 if burn else 0, now + ttl * 1000, sha256_text(revoke), code),
            )
            self.db.commit()
        # A 24-hour drop belongs on the SSD. If the client did not declare its
        # expiry up front, move it now.
        if ttl in SSD_ONLY_TTLS:
            self.migrate_to_ssd(code)
        return {"code": code, "expiresAt": now + ttl * 1000, "burn": burn, "revokeToken": revoke}

    def revoke(self, code: str, revoke_token: str) -> bool:
        row = self.db.execute("SELECT revoke_hash FROM drops WHERE code=?", (code,)).fetchone()
        if not row or not row[0] or not hmac.compare_digest(row[0], sha256_text(revoke_token)):
            return False
        self.delete(code)
        return True

    def mark_opened(self, code: str) -> None:
        with self.lock:
            self.db.execute("UPDATE drops SET opened=1 WHERE code=?", (code,))
            self.db.commit()

    def delete(self, code: str) -> None:
        row = self.db.execute("SELECT parts FROM drops WHERE code=?", (code,)).fetchone()
        if row:
            for part in self._parts(row[0]).values():
                name = part.get("name")
                if name:
                    (self.tier_dir(part.get("tier", TIER_SSD)) / name).unlink(missing_ok=True)
        with self.lock:
            self.db.execute("DELETE FROM drops WHERE code=?", (code,))
            self.db.commit()

    # ── RAM -> SSD migration ──
    def migrate_to_ssd(self, code: str) -> bool:
        """Move every RAM part of a drop to the SSD tier, safely.

        Order matters: copy and verify, fsync, atomically rename, then update the
        metadata, then unlink the RAM copy. A crash in the middle leaves a
        readable drop either way.
        """
        with self.lock:
            row = self.db.execute("SELECT parts FROM drops WHERE code=?", (code,)).fetchone()
            if not row:
                return False
            parts = self._parts(row[0])
            moved = False
            for index, part in list(parts.items()):
                if part.get("tier") != TIER_RAM:
                    continue
                name = part.get("name")
                if not name:
                    continue
                src = self.tiers[TIER_RAM] / name
                dst = self.tiers[TIER_SSD] / name
                if not src.exists():
                    # The RAM copy is gone (reboot): fall back to the SSD copy if
                    # it exists, otherwise the drop is dead.
                    if not dst.exists():
                        self.delete(code)
                        return False
                    part["tier"] = TIER_SSD
                    moved = True
                    continue
                try:
                    tmp = self.tiers[TIER_SSD] / (name + ".migrating")
                    with open(src, "rb") as fsrc, open(tmp, "wb") as fdst:
                        shutil.copyfileobj(fsrc, fdst, 1 << 20)
                        fdst.flush()
                        os.fsync(fdst.fileno())
                    if tmp.stat().st_size != src.stat().st_size or sha256_file(tmp) != sha256_file(src):
                        tmp.unlink(missing_ok=True)
                        continue  # verification failed: keep the RAM copy, retry later
                    os.replace(tmp, dst)
                    part["tier"] = TIER_SSD
                    moved = True
                    with self.stats_lock:
                        self.migrations += 1
                        self.migrated_bytes += dst.stat().st_size
                except OSError as exc:
                    if exc.errno != errno.ENOSPC:
                        continue
            if moved:
                self.db.execute("UPDATE drops SET parts=?, tier=? WHERE code=?",
                                (json.dumps(parts), TIER_SSD, code))
                self.db.commit()
            # Only drop the RAM copy once the metadata says it is on SSD.
            for index, part in parts.items():
                if part.get("tier") == TIER_SSD:
                    name = part.get("name")
                    if name:
                        (self.tiers[TIER_RAM] / name).unlink(missing_ok=True)
            self.db.execute("UPDATE drops SET tier=? WHERE code=?", (TIER_SSD, code))
            self.db.commit()
        return moved

    def sweep(self) -> dict:
        """Expire drops, honour the RAM policy, clean orphans. Runs every few seconds."""
        now = int(time.time() * 1000)
        moved = 0
        ram_low = not self.ram_ok()
        with self.lock:
            rows = self.db.execute(
                "SELECT code, expires_at, committed, created_at, ttl, tier, parts FROM drops"
            ).fetchall()
        for code, expires_at, committed, created_at, ttl, tier, parts_json in rows:
            parts = self._parts(parts_json)
            # A part whose file vanished (RAM wiped by a reboot) kills the drop.
            broken = False
            for part in parts.values():
                name = part.get("name")
                if not name:
                    continue
                path = self.tier_dir(part.get("tier", TIER_SSD)) / name
                if not path.exists() and not (self.tiers[TIER_SSD] / name).exists():
                    broken = True
            if broken:
                self.delete(code)
                continue
            if not committed:
                if now - created_at > 15 * 60_000:
                    self.delete(code)
                continue
            if expires_at and expires_at < now:
                self.delete(code)
                continue
            # Policy: 24-hour drops live on the SSD, and everything in RAM moves
            # to the SSD as soon as memory gets tight.
            if ttl in SSD_ONLY_TTLS and tier == TIER_RAM:
                if self.migrate_to_ssd(code):
                    moved += 1
                continue
            if ram_low and tier == TIER_RAM:
                if self.migrate_to_ssd(code):
                    moved += 1
        self.clean_orphans()
        expired_direct = self.sweep_direct()
        return {"migrated": moved, "directExpired": expired_direct}

    def clean_orphans(self) -> None:
        """Remove blob files no drop refers to any more."""
        with self.lock:
            rows = self.db.execute("SELECT parts FROM drops").fetchall()
        known = set()
        for (parts_json,) in rows:
            for part in self._parts(parts_json).values():
                if part.get("name"):
                    known.add(part["name"])
        now = time.time()
        for tier_dir in self.tiers.values():
            try:
                for entry in tier_dir.iterdir():
                    if not entry.is_file() or entry.name in known:
                        continue
                    # An upload in progress is not in `known` yet: leave it alone.
                    try:
                        if now - entry.stat().st_mtime < self.orphan_grace_seconds:
                            continue
                    except OSError:
                        continue
                    entry.unlink(missing_ok=True)
            except OSError:
                pass

    # ── direct sessions (metadata only) ──
    def _direct_row(self, code: str):
        # The connection is shared by handler threads; every read/write goes
        # through the same RLock as the rest of the store.
        with self.lock:
            return self.db.execute(
                "SELECT pepper, sender_hash, receiver_hash, ttl, created_at, expires_at,"
                " joined_at, last_seq, closed_at, local_only FROM direct_sessions WHERE code=?", (code,)
            ).fetchone()

    def _direct_forget(self, code: str) -> None:
        self.db.execute("DELETE FROM direct_signals WHERE code=?", (code,))
        self.db.execute("DELETE FROM direct_sessions WHERE code=?", (code,))

    def _direct_live(self, code: str, row) -> bool:
        if not row or not row[5] or row[5] < int(time.time() * 1000):
            return False
        return True

    def direct_create(self, ttl: int, local_only: bool = False) -> dict:
        """Mint a code, a pepper and a sender capability for a Direct session."""
        now = int(time.time() * 1000)
        with self.lock:
            for _ in range(200):
                code = f"{secrets.randbelow(10000):04d}"
                # One code must mean one thing: never shadow a live drop or a
                # reservation that is still uploading.
                drop = self.db.execute(
                    "SELECT expires_at, committed FROM drops WHERE code=?", (code,)
                ).fetchone()
                drop_live = bool(drop) and (drop[0] is None or drop[0] > now)
                direct = self._direct_row(code)
                if drop_live or self._direct_live(code, direct):
                    continue
                pepper, sender = token(), token()
                expires_at = now + ttl * 1000
                self._direct_forget(code)  # a stale session may share the code
                self.db.execute(
                    "INSERT INTO direct_sessions (code, pepper, sender_hash, receiver_hash,"
                    " ttl, created_at, expires_at, joined_at, last_seq, closed_at, local_only)"
                    " VALUES (?,?,?,NULL,?,?,?,NULL,0,NULL,?)",
                    (code, pepper, sha256_text(sender), ttl, now, expires_at,
                     1 if local_only else 0),
                )
                self.db.commit()
                return {"code": code, "pepper": pepper, "sessionToken": sender,
                        "ttl": ttl, "expiresAt": expires_at, "localOnly": bool(local_only)}
        raise ApiError(503, "No free codes right now.")

    def direct_join(self, code: str) -> dict | None:
        """Hand the pepper and a receiver capability to someone with the code."""
        now = int(time.time() * 1000)
        with self.lock:
            row = self._direct_row(code)
            if not self._direct_live(code, row):
                if row:
                    self._direct_forget(code)
                    self.db.commit()
                return None
            pepper, _, receiver_hash, ttl, _, expires_at, _, _, closed_at, local_only = row
            if closed_at is not None:
                return None
            if receiver_hash:
                raise ApiError(409, "Someone has already joined this Direct session.")
            receiver = token()
            self.db.execute(
                "UPDATE direct_sessions SET receiver_hash=?, joined_at=? WHERE code=?",
                (sha256_text(receiver), now, code),
            )
            seq = (row[7] or 0) + 1
            self.db.execute(
                "INSERT INTO direct_signals (code, seq, role, kind, data, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (code, seq, "receiver", "join", "{}", now),
            )
            self.db.execute("UPDATE direct_sessions SET last_seq=? WHERE code=?", (seq, code))
            self.db.commit()
            return {"pepper": pepper, "ttl": ttl, "expiresAt": expires_at,
                    "sessionToken": receiver, "seq": seq, "localOnly": bool(local_only)}

    def direct_role(self, code: str, token_value: str):
        row = self._direct_row(code)
        if not self._direct_live(code, row):
            return None
        if row[1] and hmac.compare_digest(row[1], sha256_text(token_value)):
            return "sender"
        if row[2] and hmac.compare_digest(row[2], sha256_text(token_value)):
            return "receiver"
        return None

    def direct_post(self, code: str, token_value: str, kind: str, data) -> int:
        now = int(time.time() * 1000)
        if kind not in DIRECT_KINDS:
            raise ApiError(400, "Unknown signalling message.")
        payload = json.dumps(data if data is not None else {}, separators=(",", ":"))
        if len(payload.encode()) > DIRECT_MAX_BODY:
            raise ApiError(413, "That signalling message is too large.")
        with self.lock:
            row = self._direct_row(code)
            if not self._direct_live(code, row) or row[8] is not None:
                raise ApiError(404, "That Direct session has expired.")
            if row[1] and hmac.compare_digest(row[1], sha256_text(token_value)):
                role = "sender"
            elif row[2] and hmac.compare_digest(row[2], sha256_text(token_value)):
                role = "receiver"
            else:
                raise ApiError(403, "That Direct session token is not valid.")
            # Only the sender may offer, only the receiver may answer.
            if kind == "offer" and role != "sender":
                raise ApiError(403, "Only the sender can post an offer.")
            if kind == "answer" and role != "receiver":
                raise ApiError(403, "Only the recipient can post an answer.")
            count = self.db.execute(
                "SELECT COUNT(*) FROM direct_signals WHERE code=?", (code,)
            ).fetchone()[0]
            if count >= DIRECT_MAX_EVENTS:
                raise ApiError(429, "This Direct session has too many signalling messages.")
            seq = (row[7] or 0) + 1
            self.db.execute(
                "INSERT INTO direct_signals (code, seq, role, kind, data, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (code, seq, role, kind, payload, now),
            )
            self.db.execute("UPDATE direct_sessions SET last_seq=? WHERE code=?", (seq, code))
            self.db.commit()
            return seq

    def direct_events(self, code: str, token_value: str, since: int) -> tuple[int, list]:
        """Long-poll for signals. Returns at most 256 events, or ([], last_seq)."""
        role = self.direct_role(code, token_value)
        if not role:
            row = self._direct_row(code)
            if not self._direct_live(code, row):
                raise ApiError(404, "That Direct session has expired.")
            raise ApiError(403, "That Direct session token is not valid.")
        deadline = time.monotonic() + DIRECT_POLL_SECONDS
        while True:
            with self.lock:
                row = self._direct_row(code)
                if not self._direct_live(code, row):
                    raise ApiError(404, "That Direct session has expired.")
                rows = self.db.execute(
                    "SELECT seq, role, kind, data FROM direct_signals"
                    " WHERE code=? AND seq>? ORDER BY seq LIMIT 256",
                    (code, max(0, since)),
                ).fetchall()
                last = row[7] or 0
            if rows:
                events = [{"seq": seq, "role": r, "kind": k, "data": json.loads(d)}
                          for seq, r, k, d in rows]
                return last, events
            if time.monotonic() >= deadline:
                return last, []
            time.sleep(DIRECT_POLL_STEP)

    def direct_delete(self, code: str, token_value: str) -> bool:
        # Both peers clean up. Deleting an already-gone session is a no-op, not
        # an error, so the loser of that race does not leave a failed request.
        if not self._direct_row(code):
            return True
        role = self.direct_role(code, token_value)
        if not role:
            return False
        with self.lock:
            # Keep a short tombstone instead of deleting the row outright: the
            # other peer may have a long poll in flight, and a 204 is a clean
            # "nothing more" where a 404 would show up as a failed request in
            # the browser console. The sweeper removes it seconds later.
            now = int(time.time() * 1000)
            self.db.execute("DELETE FROM direct_signals WHERE code=?", (code,))
            self.db.execute("UPDATE direct_sessions SET expires_at=?, closed_at=? WHERE code=?",
                            (now + 5000, now, code))
            self.db.commit()
        return True

    def sweep_direct(self) -> int:
        now = int(time.time() * 1000)
        with self.lock:
            stale = [row[0] for row in self.db.execute(
                "SELECT code FROM direct_sessions WHERE expires_at<?", (now,)
            ).fetchall()]
            # A session nobody joined has no value after a while either.
            stale += [row[0] for row in self.db.execute(
                "SELECT code FROM direct_sessions WHERE joined_at IS NULL AND created_at<?",
                (now - DIRECT_SWEEP_GRACE_SECONDS * 1000,),
            ).fetchall()]
            for code in set(stale):
                self._direct_forget(code)
            # Signals of a session that vanished for any other reason.
            self.db.execute(
                "DELETE FROM direct_signals WHERE code NOT IN (SELECT code FROM direct_sessions)")
            if stale:
                self.db.commit()
            return len(set(stale))

    def direct_status(self) -> dict:
        now = int(time.time() * 1000)
        with self.lock:
            count = self.db.execute(
                "SELECT COUNT(*) FROM direct_sessions WHERE expires_at>?", (now,)
            ).fetchone()[0]
        return {"sessions": count}

    def status(self) -> dict:
        available = mem_available_bytes()
        total = mem_total_bytes()
        ram_ok = self.ram_ok()
        with self.lock:
            counts = dict(self.db.execute(
                "SELECT tier, COUNT(*) FROM drops WHERE committed=1 GROUP BY tier").fetchall())
            ram_used = self.ram_used_bytes()
        return {
            "services": [
                {"id": "app", "name": "4dots", "status": "operational"},
                {"id": "storage", "name": "Encrypted storage (SSD)", "status": "operational", "ms": 0},
                {
                    "id": "ram",
                    "name": "Fast RAM tier",
                    "status": "operational" if ram_ok else "degraded",
                    "ms": 0,
                },
            ],
            "tiers": {
                "ram": {
                    "available": ram_ok,
                    "usedBytes": ram_used,
                    "memAvailableBytes": available,
                    "memTotalBytes": total,
                    "minFreeBytes": self.ram_min_bytes,
                    "drops": counts.get(TIER_RAM, 0),
                },
                "ssd": {"drops": counts.get(TIER_SSD, 0), "path": str(self.tiers[TIER_SSD])},
                "migrations": self.migrations,
                "migratedBytes": self.migrated_bytes,
            },
            "direct": self.direct_status(),
        }


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "4dots-selfhost"

    # ── plumbing ──
    def log_message(self, fmt, *args):
        line = fmt % args
        # A Direct code is a capability: keep it out of the logs, along with
        # anything a peer sends. Only the route and the status are recorded.
        line = re.sub(r"(/api/direct/sessions/)\d{4}", r"\1****", line)
        sys.stderr.write("%s - %s\n" % (self.address_string(), line))

    @property
    def store(self) -> Store:
        return self.server.store

    @property
    def ip(self) -> str:
        return (self.headers.get("cf-connecting-ip")
                or self.headers.get("x-forwarded-for", "").split(",")[0].strip()
                or self.client_address[0])

    def json(self, status: int, payload: dict, extra: dict | None = None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, err: ApiError) -> None:
        self.json(err.status, {"error": err.message}, err.headers)

    def read_static(self, path: str):
        root = Path(self.server.public_dir)
        root = root.resolve()
        rel = path.lstrip("/") or "index.html"
        target = (root / rel).resolve()
        if not str(target).startswith(str(root)):
            target = root / "index.html"
        if not target.is_file():
            # Clean URLs: /terms serves terms.html, like the upstream static host.
            if not Path(rel).suffix:
                candidate = (root / (rel + ".html")).resolve()
                if str(candidate).startswith(str(root)) and candidate.is_file():
                    target = candidate
        if not target.is_file():
            target = root / "index.html"
        if not target.is_file():
            raise ApiError(404, "Not found.")
        return target

    ASSET_VERSION_RE = re.compile(
        r'((?:src|href)="/(?:app\.js|styles\.css|config\.js))(?:\?[^"]*)?(")')
    IMPORT_RE = re.compile(r'(\bfrom\s*[\'"])(\./[^"\'?]+\.js)([\'"])')

    def script_fingerprint(self, root: Path) -> str:
        """One version for the ES-module graph: any JS change bumps app.js.

        app.js is the only module index.html can version directly. It imports
        direct.js, crypto.js and friends, so stamping app.js by its own mtime
        alone would let an edge cache keep a module graph with a new app.js and
        an old direct.js for hours.
        """
        digest = hashlib.sha256()
        try:
            files = sorted(root.glob("*.js"))
        except OSError:
            return "0"
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            digest.update(f"{path.name}:{stat.st_mtime_ns}:{stat.st_size};".encode())
        return digest.hexdigest()[:16]

    def version_module_imports(self, data: bytes, root: Path) -> bytes:
        """Add a content-addressed ?v= to every local ES-module import."""
        def stamp(match):
            rel = match.group(2)[2:]  # strip "./"
            try:
                stat = (root / rel).stat()
            except OSError:
                return match.group(0)
            return f"{match.group(1)}{match.group(2)}?v={stat.st_mtime_ns:x}-{stat.st_size:x}{match.group(3)}"

        return self.IMPORT_RE.sub(stamp, data.decode("utf-8")).encode("utf-8")

    def version_assets(self, data: bytes, root: Path) -> bytes:
        """Stamp /app.js and /styles.css with a version that changes on deploy.

        index.html is never cached, so every deploy publishes new asset URLs
        automatically: no hand-bumped ?v= key is needed, even behind an edge
        cache that keeps assets for hours.
        """
        js_version = self.script_fingerprint(root)

        def stamp(match):
            rel = match.group(1).split('"', 1)[1].lstrip("/")
            if rel == "config.js":
                # It is generated, so version it by the value it carries.
                return f"{match.group(1)}?v={self.server.kdf_iterations}{match.group(2)}"
            try:
                stat = (root / rel).stat()
            except OSError:
                return match.group(0)
            ver = js_version if rel == "app.js" else f"{stat.st_mtime_ns:x}-{stat.st_size:x}"
            return f"{match.group(1)}?v={ver}{match.group(2)}"

        return self.ASSET_VERSION_RE.sub(stamp, data.decode("utf-8")).encode("utf-8")

    def serve_static(self, path: str) -> None:
        target = self.read_static(path)
        stat = target.stat()
        data = target.read_bytes()
        if target.suffix == ".html" and target.name == "index.html":
            data = self.version_assets(data, target.parent)
        elif target.suffix == ".js":
            # A module must never be cached under a URL that outlives its
            # imports: stamp each local import with that file's own version.
            data = self.version_module_imports(data, target.parent)
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".webp": "image/webp",
            ".txt": "text/plain; charset=utf-8",
            ".xml": "application/xml",
            ".webmanifest": "application/manifest+json",
        }.get(target.suffix, "application/octet-stream")
        etag = (f'"{hashlib.sha256(data).hexdigest()[:16]}"'
                if target.suffix in (".html", ".js")
                else f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"')
        # Documents must revalidate on every load; assets may be reused for a
        # few minutes but are revalidated after that, so a deploy is never stuck
        # behind an edge cache for hours.
        cache = ("no-cache, must-revalidate" if target.suffix == ".html"
                 else "public, max-age=300, must-revalidate")
        inm = self.headers.get("if-none-match", "")
        if inm.strip() == "*" or etag in {item.strip() for item in inm.split(",")}:
            self.send_response(304)
            self.send_header("etag", etag)
            self.send_header("cache-control", cache)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.send_header("etag", etag)
        self.send_header("cache-control", cache)
        self.send_header(
            "content-security-policy",
            "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; "
            "form-action 'none'; frame-ancestors 'none'",
        )
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("referrer-policy", "no-referrer")
        self.send_header("cross-origin-opener-policy", "same-origin")
        self.send_header("permissions-policy", "camera=(), microphone=(), geolocation=()")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def serve_config_js(self) -> None:
        """Tiny script the frontend reads for the PBKDF2 cost. Kept out of the
        HTML so the strict upstream CSP (script-src 'self') still holds."""
        body = f"globalThis.__FOURDOTS_KDF_ITERATIONS = {self.server.kdf_iterations};".encode()
        self.send_response(200)
        self.send_header("content-type", "text/javascript; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        # It only carries the PBKDF2 count, but it must not be cached for hours:
        # a change has to reach browsers within a minute.
        self.send_header("cache-control", "public, max-age=60, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ── routes ──
    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("HEAD")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method: str):
        path = self.path.split("?")[0]
        self._body_consumed = False
        self._body_read = 0
        try:
            if path == "/config.js" and method in ("GET", "HEAD"):
                return self.serve_config_js()
            if path.startswith("/api/"):
                return self.api(method, path)
            if method in ("GET", "HEAD"):
                return self.serve_static(path)
            raise ApiError(405, "Method not allowed.")
        except ApiError as err:
            # A rejected request may still have an unread body. Drain it so the
            # client sees a clean error instead of a reset connection.
            if not self._body_consumed:
                self._drain_body()
            try:
                self.fail(err)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the client left while its error was being written
        except BrokenPipeError:
            pass
        except Exception as err:  # noqa: BLE001
            self.log_message("error: %r", err)
            try:
                self.fail(ApiError(500, "Something went wrong."))
            except Exception:
                pass

    def _drain_body(self) -> None:
        """Read and discard an unread request body so the socket stays sane."""
        length = self.headers.get("content-length")
        if not length or not length.isdigit():
            self.close_connection = True
            return
        remaining = min(int(length) - self._body_read, 256 * 1024 * 1024)
        if remaining <= 0:
            return
        try:
            self.connection.settimeout(10)
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
        except Exception:
            self.close_connection = True
        finally:
            try:
                self.connection.settimeout(None)
            except Exception:
                pass

    def read_json(self, limit: int = DIRECT_MAX_BODY) -> dict:
        """Read a small JSON request body. Signalling and session bodies are tiny."""
        length = self.headers.get("content-length")
        size = int(length) if length and length.isdigit() else 0
        if size > limit:
            raise ApiError(413, "That request is too large.")
        raw = self.rfile.read(size) if size else b""
        self._body_read += len(raw)
        self._body_consumed = True
        try:
            payload = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ApiError(400, "Bad request.")
        return payload if isinstance(payload, dict) else {}

    def api(self, method: str, path: str):
        store = self.store
        if path == "/api/config" and method == "GET":
            return self.json(200, {
                "maxBytes": store.max_bytes,
                "partBytes": store.part_bytes,
                "ttls": TTLS,
                "kdfIterations": self.server.kdf_iterations,
                # Capability flag. The Worker flavour omits it, so the shared
                # frontend leaves Direct mode hidden there.
                "direct": True,
            })
        if path == "/api/status" and method == "GET":
            return self.json(200, store.status())

        # ── Direct mode: signalling only, never file bytes ──
        if path == "/api/direct/config" and method == "GET":
            return self.json(200, {
                "enabled": True,
                "stunUrls": self.server.stun_urls,
                "chunkBytes": 64 * 1024,
                "maxBytes": store.max_bytes,
                "ttls": TTLS,
                "kdfIterations": self.server.kdf_iterations,
            })

        if path == "/api/direct/sessions" and method == "POST":
            wait = store.blocked("create", self.ip)
            if wait:
                raise ApiError(429, "Too many new sessions. Try again in a few minutes.",
                               {"retry-after": str(wait)})
            store.hit("create", self.ip)
            payload = self.read_json()
            ttl = payload.get("ttl")
            ttl = int(ttl) if isinstance(ttl, int) and ttl in TTLS else 3600
            return self.json(201, store.direct_create(ttl, payload.get("localOnly") is True))

        match = re.fullmatch(r"/api/direct/sessions/(\d{4})/join", path)
        if match and method == "POST":
            wait = store.blocked("miss", self.ip)
            if wait:
                raise ApiError(429, "Too many wrong codes. Try again in a few minutes.",
                               {"retry-after": str(wait)})
            self.read_json()
            info = store.direct_join(match.group(1))
            if not info:
                store.hit("miss", self.ip)
                raise ApiError(404, "No Direct session matches that code. "
                                    "It may have ended, or the sender is using Server mode.")
            return self.json(200, info)

        match = re.fullmatch(r"/api/direct/sessions/(\d{4})/signal", path)
        if match:
            code = match.group(1)
            token_value = self.headers.get("x-session-token", "")
            if method == "POST":
                wait = store.blocked("signal", self.ip)
                if wait:
                    raise ApiError(429, "Too many signalling messages.",
                                   {"retry-after": str(wait)})
                store.hit("signal", self.ip)
                payload = self.read_json()
                seq = store.direct_post(code, token_value,
                                        str(payload.get("kind", "")), payload.get("data"))
                return self.json(200, {"seq": seq})
            if method == "GET":
                since = 0
                for pair in self.path.partition("?")[2].split("&"):
                    key, _, value = pair.partition("=")
                    if key == "since" and value.isdigit():
                        since = int(value)
                last, events = store.direct_events(code, token_value, since)
                if not events:
                    self.send_response(204)
                    for key, value in SECURITY_HEADERS.items():
                        self.send_header(key, value)
                    self.end_headers()
                    return None
                return self.json(200, {"seq": last, "events": events})
            raise ApiError(405, "Method not allowed.")

        match = re.fullmatch(r"/api/direct/sessions/(\d{4})", path)
        if match and method == "DELETE":
            self.read_json()
            if not store.direct_delete(match.group(1), self.headers.get("x-session-token", "")):
                raise ApiError(403, "That Direct session token is not valid.")
            self.send_response(204)
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            return None

        if path == "/api/drops" and method == "POST":
            wait = store.blocked("create", self.ip)
            if wait:
                raise ApiError(429, "Too many new drops. Try again in a few minutes.",
                               {"retry-after": str(wait)})
            store.hit("create", self.ip)
            length = self.headers.get("content-length")
            raw = self.rfile.read(int(length)) if length and length.isdigit() else b""
            self._body_read += len(raw)
            self._body_consumed = True
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = {}
            ttl = payload.get("ttl")
            ttl = int(ttl) if isinstance(ttl, int) and ttl in TTLS else 3600
            info = store.reserve(self.ip, ttl)
            return self.json(201, {
                "code": info["code"],
                "reservation": info["reservation"],
                "pepper": info["pepper"],
                "partBytes": store.part_bytes,
                "tier": info["tier"],
            })

        match = re.fullmatch(r"/api/drops/(\d{4})/parts/(\d{1,2})", path)
        if match and method == "PUT":
            return self.put_part(match.group(1), int(match.group(2)))

        match = re.fullmatch(r"/api/drops/(\d{4})/commit", path)
        if match and method == "POST":
            return self.commit(match.group(1))

        match = re.fullmatch(r"/api/drops/(\d{4})", path)
        if match:
            code = match.group(1)
            if method == "GET":
                return self.open_drop(code)
            if method == "DELETE":
                if not store.revoke(code, self.headers.get("x-revoke-token", "")):
                    raise ApiError(403, "That delete link is not valid.")
                self.send_response(204)
                for key, value in SECURITY_HEADERS.items():
                    self.send_header(key, value)
                self.end_headers()
                return None
            raise ApiError(405, "Method not allowed.")

        raise ApiError(404, "Not found.")

    # ── upload one part, streamed to its tier ──
    def put_part(self, code: str, index: int) -> None:
        store = self.store
        token_value = self.headers.get("x-reservation", "")
        reservation = store.reservation(code, token_value)
        if not reservation:
            raise ApiError(409, "That code reservation expired. Please try again.")
        length = self.headers.get("content-length")
        length = int(length) if length and length.isdigit() else 0
        if length <= 0:
            raise ApiError(411, "Content-Length is required.")
        if length > store.part_bytes:
            raise ApiError(413, "That part is too large.")

        # The tier was chosen when the code was reserved. Re-check it now: RAM
        # may have run out in the meantime.
        tier = store.tier_for_ttl(reservation.get("ttl") or 3600)
        with store.lock:
            row = store.db.execute("SELECT tier FROM drops WHERE code=?", (code,)).fetchone()
            if row and row[0] == TIER_RAM and tier == TIER_SSD:
                store.db.execute("UPDATE drops SET tier=? WHERE code=?", (TIER_SSD, code))
                store.db.commit()
            elif row:
                tier = row[0]

        name = f"{code}-{index}-{secrets.token_hex(8)}.bin"
        target = store.tier_dir(tier) / name
        remaining = length
        written = 0
        head = b""
        try:
            with open(target, "wb", buffering=1024 * 256) as fh:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ApiError(400, "The upload was cut short.")
                    if len(head) < 4:
                        head += chunk[: 4 - len(head)]
                    written += len(chunk)
                    fh.write(chunk)
                    remaining -= len(chunk)
                    self._body_read += len(chunk)
                fh.flush()
                os.fsync(fh.fileno())
            self._body_consumed = True
        except ApiError:
            target.unlink(missing_ok=True)
            raise
        except Exception:
            target.unlink(missing_ok=True)
            raise

        if index == 0 and head[:4] != MAGIC:
            target.unlink(missing_ok=True)
            raise ApiError(400, "Expected an encrypted drop.")

        store.note_part(code, index, name, written, tier)
        self.json(201, {"ok": True})

    # ── commit the drop ──
    def commit(self, code: str) -> None:
        store = self.store
        reservation = store.reservation(code, self.headers.get("x-reservation", ""))
        if not reservation:
            raise ApiError(409, "That code reservation expired. Please try again.")
        length = self.headers.get("content-length")
        body = self.rfile.read(int(length)) if length and length.isdigit() else b""
        self._body_read += len(body)
        self._body_consumed = True
        try:
            payload = json.loads(body or b"{}")
        except json.JSONDecodeError:
            raise ApiError(400, "Bad request.")
        ttl = int(payload.get("ttl", 0))
        if ttl not in TTLS:
            raise ApiError(400, "Unsupported expiry.")
        parts = int(payload.get("parts", 0))
        if parts < 1 or parts > 64:
            raise ApiError(400, "Invalid part count.")
        result = store.commit(code, ttl, payload.get("burn") is True, parts)
        self.json(201, result)

    # ── download: stream the parts back to back ──
    def open_drop(self, code: str) -> None:
        store = self.store
        row = store.drop(code)
        if not row:
            store.hit("miss", self.ip)
            raise ApiError(404, "No drop matches that code. It may have expired or already been opened.")
        _, pepper, parts_json, tier, ttl, burn, expires_at, _, committed, opened = row
        if not committed:
            raise ApiError(404, "No drop matches that code. It may have expired or already been opened.")
        if expires_at and expires_at < int(time.time() * 1000):
            store.delete(code)
            raise ApiError(404, "No drop matches that code. It may have expired or already been opened.")
        if opened and burn:
            raise ApiError(404, "No drop matches that code. It may have expired or already been opened.")

        parts = store._parts(parts_json)
        ordered = [parts[str(i)] for i in range(len(parts)) if str(i) in parts]
        total = sum(int(part.get("size", 0)) for part in ordered)

        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(total))
        self.send_header("x-drop-pepper", pepper)
        self.send_header("x-drop-burn", "1" if burn else "0")
        self.send_header("x-drop-expires-at", str(expires_at or 0))
        self.send_header("x-drop-tier", tier or TIER_SSD)
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()

        delivered = 0
        try:
            for part in ordered:
                path = store.tier_dir(part.get("tier", TIER_SSD)) / part["name"]
                with open(path, "rb") as fh:
                    while True:
                        chunk = fh.read(256 * 1024)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        delivered += len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        store.mark_opened(code)
        # A burn drop only disappears once the whole payload actually reached the
        # client; a half-finished download leaves it in place.
        if burn and delivered == total:
            store.delete(code)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def sweeper(store: Store, stop: threading.Event, interval: int) -> None:
    while not stop.wait(interval):
        try:
            store.sweep()
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"sweep error: {exc!r}\n")


def main():
    parser = argparse.ArgumentParser(description="Self-hosted 4dots-compatible drop server")
    parser.add_argument("--host", default=os.environ.get("FOURDOTS_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("FOURDOTS_PORT", "8080")))
    parser.add_argument("--data", default=os.environ.get("FOURDOTS_DATA", "/data"))
    parser.add_argument("--public", default=os.environ.get("FOURDOTS_PUBLIC", "/app/public"))
    parser.add_argument("--max-mb", type=int, default=int(os.environ.get("FOURDOTS_MAX_MB", "1024")))
    parser.add_argument("--part-mb", type=int, default=int(os.environ.get("FOURDOTS_PART_MB", "64")))
    parser.add_argument("--ram-dir", default=os.environ.get("FOURDOTS_RAM_DIR", "/ram"))
    parser.add_argument("--ssd-dir", default=os.environ.get("FOURDOTS_SSD_DIR", ""))
    parser.add_argument("--ram-min-mb", type=int,
                        default=int(os.environ.get("FOURDOTS_RAM_MIN_MB", "2048")))
    parser.add_argument("--ram-max-mb", type=int,
                        default=int(os.environ.get("FOURDOTS_RAM_MAX_MB", "0")))
    parser.add_argument("--ram-min-free-mb", type=int,
                        default=int(os.environ.get("FOURDOTS_RAM_MIN_FREE_MB", "64")))
    parser.add_argument("--sweep-seconds", type=int,
                        default=int(os.environ.get("FOURDOTS_SWEEP_SECONDS", "15")))
    parser.add_argument("--orphan-grace-seconds", type=int,
                        default=int(os.environ.get("FOURDOTS_ORPHAN_GRACE_SECONDS", "21600")))
    parser.add_argument("--stun-urls",
                        default=os.environ.get("FOURDOTS_STUN_URLS", DEFAULT_STUN_URLS))
    args = parser.parse_args()

    # Direct mode is STUN only. A TURN URL here is ignored on purpose: 4dots
    # never relays file content, and a relay would stop the transfer being direct.
    stun_urls = [url.strip() for url in args.stun_urls.split(",")
                 if url.strip().lower().startswith("stun:")]

    root = Path(args.data)
    root.mkdir(parents=True, exist_ok=True)
    ssd_dir = Path(args.ssd_dir) if args.ssd_dir else (root / "drops")
    ram_dir = Path(args.ram_dir)

    total_mem = mem_total_bytes()
    ram_max = args.ram_max_mb * 1024 * 1024
    if not ram_max and total_mem:
        ram_max = int(total_mem * 0.4)  # never let the RAM tier eat the machine

    store = Store(root, args.max_mb * 1024 * 1024, args.part_mb * 1024 * 1024,
                  ram_dir, ssd_dir, args.ram_min_mb * 1024 * 1024, ram_max,
                  args.ram_min_free_mb * 1024 * 1024, args.orphan_grace_seconds)

    server = Server((args.host, args.port), Handler)
    server.store = store
    server.public_dir = args.public
    server.kdf_iterations = int(os.environ.get("FOURDOTS_KDF_ITERATIONS", "600000"))
    server.stun_urls = stun_urls

    stop = threading.Event()
    threading.Thread(target=sweeper, args=(store, stop, args.sweep_seconds), daemon=True).start()

    print(f"4dots self-host listening on http://{args.host}:{args.port}", flush=True)
    print(f"  data dir    : {root}", flush=True)
    print(f"  public dir  : {args.public}", flush=True)
    print(f"  RAM tier    : {ram_dir} (tmpfs: {fstype_for(ram_dir) == 'tmpfs'}, "
          f"needs >= {args.ram_min_mb} MB free memory, cap {ram_max // (1024*1024)} MB)", flush=True)
    print(f"  SSD tier    : {ssd_dir}", flush=True)
    print(f"  orphan grace: {args.orphan_grace_seconds}s", flush=True)
    print(f"  max {args.max_mb} MB per drop, parts of {args.part_mb} MB, "
          f"PBKDF2 {server.kdf_iterations} rounds", flush=True)
    print(f"  direct mode : signalling only, STUN {stun_urls or '(none: host candidates only)'}",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
