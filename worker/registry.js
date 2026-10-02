// One Durable Object holds everything the API must remember between requests:
// open reservations, live drops, burn-after-reading locks, rate limits, and a
// queue of nimbo files to delete. Its alarm expires drops and works the queue.
//
// Storage keys: r:<code> reservation, d:<code> drop, l:<kind>:<ip> rate limit,
// q:<file> pending deletion, meta:folder whether the nimbo folder exists.
import { DurableObject } from 'cloudflare:workers';
import { nimbo } from './nimbo.js';

const RESERVATION_MS = 15 * 60_000; // extended by every uploaded part
const MAX_RESERVATIONS = 500;
const BURN_LOCK_MS = 10 * 60_000;
const DELETES_PER_ALARM = 40;
const LIMITS = {
  create: [30, 10 * 60_000],
  // Wrong codes: the main brake on guessing, since there are only 10,000 of them.
  miss: [12, 10 * 60_000],
};

const fail = (status, message, headers) => ({ error: { status, message, headers } });

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Registry extends DurableObject {
  get kv() {
    return this.ctx.storage.kv;
  }

  /* ───────────── rate limits ───────────── */

  #window(kind, ip) {
    const key = `l:${kind}:${ip}`;
    const now = Date.now();
    let entry = this.kv.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + LIMITS[kind][1] };
    return [key, entry];
  }

  /** Seconds until `ip` may try again, or 0. */
  #blocked(kind, ip) {
    const [, entry] = this.#window(kind, ip);
    return entry.count >= LIMITS[kind][0] ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
  }

  #hit(kind, ip) {
    const [key, entry] = this.#window(kind, ip);
    entry.count++;
    this.kv.put(key, entry);
  }

  #missLimit(ip) {
    const wait = this.#blocked('miss', ip);
    return wait
      ? fail(429, `Too many wrong codes. Try again in ${Math.ceil(wait / 60)} min.`, { 'retry-after': String(wait) })
      : null;
  }

  /* ───────────── deletion queue ───────────── */

  #queue(files) {
    for (const file of files) this.kv.put(`q:${file}`, Date.now());
  }

  #retire(code, drop) {
    this.kv.delete(`d:${code}`);
    this.#queue(drop.parts.map((part) => part.name));
  }

  #abandon(code, reservation) {
    this.kv.delete(`r:${code}`);
    this.#queue(Object.values(reservation.parts).map((part) => part.name));
  }

  #has(prefix) {
    for (const _ of this.kv.list({ prefix, limit: 1 })) return true;
    return false;
  }

  /** Arms the alarm for the next expiry, or soon if files are waiting to be deleted. */
  async #schedule(queueDelay = 1000) {
    const now = Date.now();
    let next = this.#has('q:') ? now + queueDelay : Infinity;
    for (const [, r] of this.kv.list({ prefix: 'r:' })) next = Math.min(next, r.expires);
    for (const [, d] of this.kv.list({ prefix: 'd:' })) next = Math.min(next, d.expiresAt);
    if (this.#has('l:')) next = Math.min(next, now + 30 * 60_000);
    if (next === Infinity) return;
    next = Math.max(next, now + 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  async alarm() {
    const now = Date.now();
    for (const [key, r] of [...this.kv.list({ prefix: 'r:' })]) if (r.expires <= now) this.#abandon(key.slice(2), r);
    for (const [key, d] of [...this.kv.list({ prefix: 'd:' })]) if (d.expiresAt <= now) this.#retire(key.slice(2), d);
    for (const [key, e] of [...this.kv.list({ prefix: 'l:' })]) if (e.resetAt <= now) this.kv.delete(key);

    const store = nimbo(this.env);
    let failed = false;
    for (const [key] of [...this.kv.list({ prefix: 'q:', limit: DELETES_PER_ALARM })]) {
      try {
        await store.remove(key.slice(2));
        this.kv.delete(key);
      } catch {
        failed = true; // storage trouble: keep it queued and back off
      }
    }
    await this.#schedule(failed ? 60_000 : 1000);
  }

  /* ───────────── API ───────────── */

  async reserve(ip) {
    const wait = this.#blocked('create', ip);
    if (wait) return fail(429, 'Too many new drops. Try again in a few minutes.', { 'retry-after': String(wait) });
    this.#hit('create', ip);

    if (!this.kv.get('meta:folder')) {
      await nimbo(this.env).ensureFolder().catch(() => {});
      this.kv.put('meta:folder', true);
    }

    const now = Date.now();
    let open = 0;
    for (const [, r] of this.kv.list({ prefix: 'r:' })) if (r.expires > now) open++;
    if (open >= MAX_RESERVATIONS) return fail(503, 'Too busy right now. Try again in a minute.');

    for (let attempt = 0; attempt < 40; attempt++) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10_000).padStart(4, '0');
      const reservation = this.kv.get(`r:${code}`);
      const drop = this.kv.get(`d:${code}`);
      if ((reservation && reservation.expires > now) || (drop && drop.expiresAt > now)) continue;
      if (reservation) this.#abandon(code, reservation);
      if (drop) this.#retire(code, drop);
      const fresh = { token: randomToken(), uploadId: randomHex(16), expires: now + RESERVATION_MS, parts: {} };
      this.kv.put(`r:${code}`, fresh);
      await this.#schedule();
      return { code, reservation: fresh.token };
    }
    return fail(503, 'No free codes right now. Try again shortly.');
  }

  #reservation(code, token) {
    const r = this.kv.get(`r:${code}`);
    return r && r.expires > Date.now() && sameString(r.token, token) ? r : null;
  }

  checkReservation(code, token) {
    const r = this.#reservation(code, token);
    return r ? { uploadId: r.uploadId } : fail(409, 'That code reservation expired. Please try again.');
  }

  async notePart(code, token, index, part) {
    const r = this.#reservation(code, token);
    if (!r) return fail(409, 'That code reservation expired. Please try again.');
    if (r.parts[index]) this.#queue([r.parts[index].name]); // a retried part replaces the earlier copy
    r.parts[index] = part;
    r.expires = Math.max(r.expires, Date.now() + RESERVATION_MS);
    this.kv.put(`r:${code}`, r);
    await this.#schedule();
    return { ok: true };
  }

  async commit(code, token, { ttl, burn, parts, maxBytes }) {
    const revokeToken = randomToken();
    const revokeHash = await sha256(revokeToken);
    const r = this.#reservation(code, token);
    if (!r) return fail(409, 'That code reservation expired. Please try again.');
    const list = [];
    for (let i = 0; i < parts; i++) {
      if (!r.parts[i]) return fail(400, 'Part of the upload is missing. Please try again.');
      list.push(r.parts[i]);
    }
    const total = list.reduce((sum, part) => sum + part.size, 0);
    if (total > maxBytes) return fail(413, 'That drop is too large.');
    // Parts beyond the declared count (from an earlier, longer attempt) are not needed.
    this.#queue(Object.entries(r.parts).filter(([i]) => Number(i) >= parts).map(([, part]) => part.name));

    const drop = { parts: list, burn, expiresAt: Date.now() + ttl * 1000, revokeHash, opening: null };
    this.kv.put(`d:${code}`, drop);
    this.kv.delete(`r:${code}`);
    await this.#schedule();
    return { code, expiresAt: drop.expiresAt, burn, revokeToken };
  }

  /**
   * Looks a code up for download. Burn-after-reading drops are locked to one
   * reader until finishOpen() reports whether the download completed.
   */
  async open(code, ip) {
    const limited = this.#missLimit(ip);
    if (limited) return limited;
    const now = Date.now();
    const drop = this.kv.get(`d:${code}`);
    const miss = () => {
      this.#hit('miss', ip);
      return fail(404, 'No drop matches that code. It may have expired or already been opened.');
    };
    if (!drop) return miss();
    if (drop.expiresAt <= now) {
      this.#retire(code, drop);
      await this.#schedule();
      return miss();
    }
    let openId = null;
    if (drop.burn) {
      if (drop.opening && drop.opening.at > now - BURN_LOCK_MS) return miss();
      openId = randomHex(8);
      drop.opening = { id: openId, at: now };
      this.kv.put(`d:${code}`, drop);
    }
    return { parts: drop.parts, burn: drop.burn, expiresAt: drop.expiresAt, openId };
  }

  async finishOpen(code, openId, delivered) {
    const drop = this.kv.get(`d:${code}`);
    if (!drop || !drop.burn || drop.opening?.id !== openId) return { ok: true };
    if (delivered) {
      this.#retire(code, drop);
      await this.#schedule();
    } else {
      drop.opening = null;
      this.kv.put(`d:${code}`, drop);
    }
    return { ok: true };
  }

  /** Removes a drop for a takedown or abuse report, without the sender's revoke token. */
  async takedown(code) {
    const drop = this.kv.get(`d:${code}`);
    const reservation = this.kv.get(`r:${code}`);
    if (drop) this.#retire(code, drop);
    if (reservation) this.#abandon(code, reservation);
    if (drop || reservation) await this.#schedule();
    return { removed: Boolean(drop && drop.expiresAt > Date.now()) };
  }

  /** A wrong admin key counts like a wrong code, so the key can't be guessed either. */
  adminDenied(ip) {
    const limited = this.#missLimit(ip);
    if (limited) return limited;
    this.#hit('miss', ip);
    return fail(401, 'That admin key isn’t right.');
  }

  async revoke(code, token, ip) {
    const limited = this.#missLimit(ip);
    if (limited) return limited;
    const hash = await sha256(String(token));
    const drop = this.kv.get(`d:${code}`);
    if (!drop || drop.expiresAt <= Date.now() || !sameString(drop.revokeHash, hash)) {
      this.#hit('miss', ip);
      return fail(404, 'Nothing to delete. The drop is already gone.');
    }
    this.#retire(code, drop);
    await this.#schedule();
    return { ok: true };
  }
}
