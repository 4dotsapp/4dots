// 4dots on Cloudflare Workers. Static files come straight from Workers Static
// Assets; this Worker handles /api/* and only ever sees ciphertext.
//
// A drop is uploaded in parts (Workers accept at most 100 MB per request), each
// stored as its own nimbo file, then committed. Downloads stream the parts back
// to back, so nothing is held in memory.
import { Registry } from './registry.js';
import { nimbo } from './nimbo.js';
import { HttpError, SECURITY_HEADERS, errorResponse, json, unwrap } from './http.js';

export { Registry };

const TTLS = [600, 3600, 86400];
const MAGIC = [0x4e, 0x4d, 0x42, 0x32]; // "NMB2": the browser's chunked encryption format
const MAX_PARTS = 64;
const SLACK = 1024 * 1024; // encryption overhead on top of the plaintext limit
const encoder = new TextEncoder();
const STATUS_TTL = 15_000; // a short cache so the status page can't hammer storage
let statusCache = null;

function settings(env) {
  const mib = (value, fallback) => Math.round((Number(value) || fallback) * 1024 * 1024);
  return { maxBytes: mib(env.MAX_UPLOAD_MB, 1024), partBytes: mib(env.PART_MB, 90) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Shares to the installed app are caught by the service worker. If one arrives
    // here instead, its contents must not reach the server unencrypted: just open the app.
    if (url.pathname === '/share' && request.method === 'POST') return Response.redirect(new URL('/?share', url), 303);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (!env.NIMBO_TOKEN) throw new HttpError(500, 'The server is missing its NIMBO_TOKEN secret.');
      return await route(request, env, ctx, url);
    } catch (err) {
      return errorResponse(err);
    }
  },
};

async function route(request, env, ctx, url) {
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const { maxBytes, partBytes } = settings(env);
  const { pathname: path } = url;
  const { method } = request;
  let match;

  if (path === '/api/config' && method === 'GET') {
    return json(200, { maxBytes, partBytes, ttls: TTLS });
  }
  if (path === '/api/status' && method === 'GET') {
    return status(env);
  }
  if (path === '/api/drops' && method === 'POST') {
    const { code, reservation } = unwrap(await registry.reserve(ip));
    return json(201, { code, reservation, pepper: await pepperFor(env, code), partBytes });
  }
  if ((match = path.match(/^\/api\/drops\/(\d{4})\/parts\/(\d{1,2})$/)) && method === 'PUT') {
    return putPart(request, env, ctx, registry, match[1], Number(match[2]), partBytes);
  }
  if ((match = path.match(/^\/api\/drops\/(\d{4})\/commit$/)) && method === 'POST') {
    return commit(request, registry, match[1], maxBytes);
  }
  if (path === '/api/admin/takedown' && method === 'POST') {
    return takedown(request, env, registry, ip);
  }
  if ((match = path.match(/^\/api\/drops\/(\d{4})$/))) {
    if (method === 'GET') return openDrop(env, ctx, registry, match[1], ip);
    if (method === 'DELETE') {
      unwrap(await registry.revoke(match[1], request.headers.get('x-revoke-token') ?? '', ip));
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    throw new HttpError(405, 'Method not allowed.');
  }
  throw new HttpError(404, 'Not found.');
}

async function putPart(request, env, ctx, registry, code, index, partBytes) {
  if (index >= MAX_PARTS) throw new HttpError(400, 'Too many parts.');
  const token = request.headers.get('x-reservation') ?? '';
  const { uploadId } = unwrap(await registry.checkReservation(code, token));
  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0) throw new HttpError(411, 'Content-Length is required.');
  if (length > partBytes) throw new HttpError(413, 'That part is too large.');

  const start = index === 0 ? await checkedStart(request.body) : undefined;
  // A fresh name per attempt, so a retried part never collides with a half-written one.
  const name = `${uploadId}-${index}-${crypto.randomUUID().slice(0, 8)}.bin`;
  const store = nimbo(env);
  try {
    await store.upload(name, request.body, length, start);
  } catch (err) {
    ctx.waitUntil(store.remove(name).catch(() => {}));
    throw err;
  }
  const noted = await registry.notePart(code, token, index, { name, size: length });
  if (noted.error) ctx.waitUntil(store.remove(name).catch(() => {}));
  unwrap(noted);
  return json(201, { ok: true });
}

/**
 * Checks the first bytes are an encrypted drop before anything goes to storage.
 * Returns the bytes it read; the rest stays in `body` for the upload to pipe on.
 */
async function checkedStart(body) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAGIC.length) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const start = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    start.set(chunk, offset);
    offset += chunk.length;
  }
  if (size < MAGIC.length || MAGIC.some((byte, i) => start[i] !== byte)) {
    reader.cancel().catch(() => {});
    throw new HttpError(400, 'Expected an encrypted drop.');
  }
  reader.releaseLock();
  return start;
}

async function commit(request, registry, code, maxBytes) {
  const token = request.headers.get('x-reservation') ?? '';
  const body = await request.json().catch(() => ({}));
  const ttl = Number(body.ttl);
  const parts = Number(body.parts);
  if (!TTLS.includes(ttl)) throw new HttpError(400, 'Unsupported expiry.');
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw new HttpError(400, 'Invalid part count.');
  const drop = unwrap(await registry.commit(code, token, { ttl, burn: body.burn === true, parts, maxBytes: maxBytes + SLACK }));
  return json(201, drop);
}

async function openDrop(env, ctx, registry, code, ip) {
  const drop = unwrap(await registry.open(code, ip));
  const store = nimbo(env);
  const release = () => (drop.burn ? registry.finishOpen(code, drop.openId, false) : null);

  // Fetch the first part before answering, so a storage failure is a clean error, not a cut-off download.
  let first;
  try {
    first = await store.download(drop.parts[0].name);
  } catch (err) {
    await release();
    throw err;
  }
  if (!first.ok) {
    await first.body?.cancel();
    await release();
    throw new HttpError(502, 'Storage couldn’t find this drop’s data.');
  }

  const total = drop.parts.reduce((sum, part) => sum + part.size, 0);
  const { readable, writable } = new FixedLengthStream(total);
  ctx.waitUntil((async () => {
    let delivered = false;
    try {
      for (let i = 0; i < drop.parts.length; i++) {
        const res = i === 0 ? first : await store.download(drop.parts[i].name);
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`part ${i}: HTTP ${res.status}`);
        }
        await res.body.pipeTo(writable, { preventClose: i < drop.parts.length - 1 });
      }
      delivered = true;
    } catch (err) {
      await writable.abort(err).catch(() => {});
    } finally {
      if (drop.burn) await registry.finishOpen(code, drop.openId, delivered);
    }
  })());

  return new Response(readable, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/octet-stream',
      'x-drop-pepper': await pepperFor(env, code),
      'x-drop-burn': drop.burn ? '1' : '0',
      'x-drop-expires-at': String(drop.expiresAt),
    },
  });
}

/* ───────────── status ───────────── */

// A tiny public health check for /status: the Worker is answering, and storage is
// reachable. Only up/down and latency are exposed — never the account details nimbo
// returns. Cached briefly so the page can poll without loading storage.
async function status(env) {
  const now = Date.now();
  if (!statusCache || now - statusCache.at >= STATUS_TTL) {
    const probe = await nimbo(env).health();
    const storage = probe.ok
      ? 'operational'
      : probe.status === 401 || probe.status === 403
        ? 'degraded'
        : 'down';
    statusCache = {
      at: now,
      body: {
        updated: new Date(now).toISOString(),
        services: [
          { id: 'app', name: '4dots', status: 'operational' },
          { id: 'storage', name: 'Encrypted storage', status: storage, ms: probe.ms },
        ],
      },
    };
  }
  return json(200, statusCache.body, { 'cache-control': 'public, max-age=15' });
}

/* ───────────── takedowns ───────────── */

// Deletes a reported drop by its code. Only enabled when the ADMIN_TOKEN secret is set.
async function takedown(request, env, registry, ip) {
  if (!env.ADMIN_TOKEN) throw new HttpError(404, 'Not found.');
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!(await sameSecret(given, env.ADMIN_TOKEN))) unwrap(await registry.adminDenied(ip));
  const body = await request.json().catch(() => ({}));
  const code = String(body.code ?? '');
  if (!/^\d{4}$/.test(code)) throw new HttpError(400, 'Enter a four-digit code.');
  return json(200, unwrap(await registry.takedown(code)));
}

async function sameSecret(given, expected) {
  const [a, b] = await Promise.all([given, expected].map((text) => crypto.subtle.digest('SHA-256', encoder.encode(text))));
  return crypto.subtle.timingSafeEqual(a, b);
}

/* ───────────── per-code pepper ───────────── */

// The pepper is mixed into the browser's key so storage alone can't brute-force a
// drop. It comes from DROP_SECRET, or is derived from the nimbo key (nimbo only
// stores a hash of the key, so it can't recompute this).
let secretKey = null;

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

async function pepperFor(env, code) {
  secretKey ??= (async () => {
    const raw = env.DROP_SECRET
      ? await crypto.subtle.digest('SHA-256', encoder.encode(env.DROP_SECRET))
      : await hmac(encoder.encode(env.NIMBO_TOKEN), '4dots:secret:v1');
    return new Uint8Array(raw);
  })();
  const sig = new Uint8Array(await hmac(await secretKey, `pepper:${code}`));
  return btoa(String.fromCharCode(...sig)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
