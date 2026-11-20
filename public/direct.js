// 4dots Direct: device-to-device over WebRTC DataChannels.
//
// The server only brokers SDP and ICE candidates over same-origin long polls.
// File bytes never touch it: the sealed NMB2 blob is sliced into 64 KiB
// DataChannel messages, with both bufferedAmount and an application-level
// credit window keeping memory flat. No TURN is ever configured, so the
// connection is either local, direct over the internet, or it fails.
import { seal, unseal, unbundle } from './crypto.js';

export const CHUNK = 64 * 1024;
const MAX_CHUNK = 256 * 1024;       // Chrome's SCTP maxMessageSize; older stacks cap lower
const HIGH_WATER = 4 * 1024 * 1024; // pause sending above this
const LOW_WATER = 1024 * 1024;      // resume on bufferedamountlow
const WINDOW = 64;                  // chunks the receiver has not acknowledged yet
const ACK_EVERY = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function directSupported() {
  return typeof RTCPeerConnection === 'function'
    && typeof RTCSessionDescription === 'function'
    && window.isSecureContext;
}

function isStunUrl(url) {
  // STUN only. A turn: URL must never be used: that would relay the content.
  return /^stuns?:/i.test(url);
}

/**
 * Reads /api/direct/config. Returns null when this deployment has no Direct
 * mode. `/api/config` advertises the capability, so the Cloudflare Worker
 * flavour (which does not implement Direct) is never asked for it at all.
 */
export async function loadDirectConfig(base = null) {
  if (base && base.direct !== true) return null;
  if (!base) {
    try {
      const probe = await fetch('/api/config', { cache: 'no-store' });
      const caps = probe.ok ? await probe.json().catch(() => null) : null;
      if (!caps || caps.direct !== true) return null;
    } catch {
      return null;
    }
  }
  let res;
  try {
    res = await fetch('/api/direct/config', { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || data.enabled !== true) return null;
  const stunUrls = (Array.isArray(data.stunUrls) ? data.stunUrls : []).filter(isStunUrl);
  return {
    ...data,
    stunUrls,
    chunk: Math.min(CHUNK, Number(data.chunkBytes) || CHUNK),
  };
}

async function request(path, { method = 'GET', body, token, signal } = {}) {
  const headers = { 'cache-control': 'no-cache' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-session-token'] = token;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('Network error. Check your connection.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Request failed (${res.status}).`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function createSession(ttl) {
  return request('/api/direct/sessions', { method: 'POST', body: { ttl } });
}

export function joinSession(code) {
  return request(`/api/direct/sessions/${code}/join`, { method: 'POST', body: {} });
}

export function postSignal(code, token, kind, data) {
  return request(`/api/direct/sessions/${code}/signal`, {
    method: 'POST',
    token,
    body: { kind, data },
  });
}

/** Closes the session from either peer. Best effort: the sweeper would get it anyway. */
export function endSession(code, token) {
  return fetch(`/api/direct/sessions/${code}`, {
    method: 'DELETE',
    headers: { 'x-session-token': token },
    keepalive: true,
  }).catch(() => {});
}

/**
 * Long-polls for the other peer's signals until stopped or the session ends.
 * The request itself times out after ~1 s on the server, so a vanished client
 * never pins a thread for long.
 */
export function pollSession({ code, token, since = 0, onEvents, onEnded, onError }) {
  let stopped = false;
  let controller = null;
  const loop = (async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`/api/direct/sessions/${code}/signal?since=${since}`, {
          headers: { 'x-session-token': token, 'cache-control': 'no-cache' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (stopped) break;
        if (res.status === 204) continue;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 404) {
            onEnded?.(data.error || 'That Direct session ended.');
          } else {
            onError?.(new Error(data.error || `Signalling failed (${res.status}).`));
          }
          break;
        }
        if (Array.isArray(data.events) && data.events.length) {
          since = Number(data.seq) || since;
          for (const event of data.events) {
            if (stopped) break;
            await onEvents?.(event);
          }
        }
      } catch (err) {
        if (stopped || err.name === 'AbortError') break;
        onError?.(err);
        await sleep(400);
      } finally {
        controller = null;
      }
    }
  })();
  loop.catch(() => {});
  return {
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}

/** An RTCPeerConnection with STUN only. TURN is filtered out, never configured. */
export function makePeer(stunUrls = []) {
  const iceServers = stunUrls.filter(isStunUrl).map((urls) => ({ urls }));
  return new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
}

/**
 * The largest message this browser's SCTP stack accepts, capped at 256 KiB.
 * Bigger messages mean fewer send() calls and less per-message overhead on a
 * fast LAN, while 64 KiB remains the floor for older stacks.
 */
export function preferredChunk(pc) {
  const max = Number(pc?.sctp?.maxMessageSize) || CHUNK;
  return Math.max(CHUNK, Math.min(MAX_CHUNK, max));
}

/** Some older WebRTC stacks have no RTCPeerConnection.connectionState. */
export function isPeerConnected(pc) {
  if (!pc) return false;
  if (pc.connectionState === 'connected') return true;
  return pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
}

/** Old Safari expects description/candidate objects, not plain JSON. */
export function remoteDescription(pc, init) {
  const value = typeof RTCSessionDescription === 'function' ? new RTCSessionDescription(init) : init;
  return pc.setRemoteDescription(value);
}

export function iceCandidate(init) {
  return typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(init) : init;
}

export function waitOpen(dc) {
  if (dc.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      dc.removeEventListener('open', onOpen);
      dc.removeEventListener('close', onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('The other device disconnected.')); };
    dc.addEventListener('open', onOpen, { once: true });
    dc.addEventListener('close', onClose, { once: true });
  });
}

function aborted(signal) {
  const err = new Error('cancelled');
  err.name = 'AbortError';
  err.cancelled = true;
  return err;
}

function drain(dc, signal) {
  if (dc.bufferedAmount <= HIGH_WATER) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const low = () => { if (dc.bufferedAmount <= LOW_WATER) finish(resolve); };
    const close = () => finish(() => reject(new Error('The other device disconnected.')));
    const abort = () => finish(() => reject(aborted(signal)));
    const finish = (fn) => {
      dc.removeEventListener('bufferedamountlow', low);
      dc.removeEventListener('close', close);
      signal?.removeEventListener('abort', abort);
      fn();
    };
    dc.addEventListener('bufferedamountlow', low);
    dc.addEventListener('close', close);
    signal?.addEventListener('abort', abort, { once: true });
    // The event may already have fired between the check and the listeners.
    if (dc.bufferedAmount <= LOW_WATER) finish(resolve);
    else if (dc.readyState !== 'open') finish(() => reject(new Error('The other device disconnected.')));
  });
}

/**
 * Sends a sealed blob as 64 KiB messages, honouring bufferedAmount and the
 * receiver's credit window. Resolves once the receiver confirms it decrypted
 * the bundle; rejects on abort, disconnect or a receiver-side error.
 */
export async function sendSealed(dc, sealed, { onSent = () => {}, signal, chunk = CHUNK } = {}) {
  const size = Math.max(1024, Math.min(MAX_CHUNK, Number(chunk) || CHUNK));
  dc.bufferedAmountLowThreshold = LOW_WATER;
  let credit = WINDOW;
  let wake = null;
  let settled = false;
  let fail;
  const failed = new Promise((_, reject) => { fail = reject; });
  failed.catch(() => {});
  let finish;
  const acknowledged = new Promise((resolve) => { finish = resolve; });

  const notify = () => { const fn = wake; wake = null; fn?.(); };
  const stop = (err) => {
    if (settled) return;
    settled = true;
    fail(err);
    notify();
  };
  const onMessage = (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.t === 'ack') {
      credit += Math.max(0, Number(message.n) || 0);
      notify();
    } else if (message.t === 'done') {
      finish();
    } else if (message.t === 'error') {
      stop(new Error(String(message.message || 'The other device could not decrypt the transfer.')));
    }
  };
  const onClose = () => stop(new Error('The other device disconnected.'));
  const onAbort = () => stop(aborted(signal));

  dc.addEventListener('message', onMessage);
  dc.addEventListener('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });

  const waitCredit = () => {
    if (credit > 0) return Promise.resolve();
    return new Promise((resolve) => { wake = resolve; });
  };

  try {
    if (dc.readyState !== 'open') throw new Error('The other device disconnected.');
    dc.send(JSON.stringify({ t: 'begin', size: sealed.size, chunk: size }));
    let offset = 0;
    while (offset < sealed.size) {
      if (signal?.aborted) throw aborted(signal);
      if (credit <= 0) {
        await Promise.race([waitCredit(), failed]);
        if (credit <= 0) continue;
      }
      await Promise.race([drain(dc, signal), failed]);
      const end = Math.min(sealed.size, offset + size);
      const chunk = await sealed.slice(offset, end).arrayBuffer();
      if (dc.readyState !== 'open') throw new Error('The other device disconnected.');
      dc.send(chunk);
      credit--;
      offset = end;
      onSent(offset, sealed.size);
    }
    await Promise.race([drain(dc, signal), failed]);
    dc.send(JSON.stringify({ t: 'end' }));
    await Promise.race([acknowledged, failed]);
    return { sent: sealed.size };
  } finally {
    settled = true;
    dc.removeEventListener('message', onMessage);
    dc.removeEventListener('close', onClose);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Turns the incoming DataChannel messages into a ReadableStream that unseal()
 * consumes directly. Returns the stream, a promise for the final size, and a
 * fail()/ack() pair for the caller.
 */
export function receiveSealed(dc, { onBegin, onBytes } = {}) {
  let controller = null;
  let total = 0;
  let got = 0;
  let sinceAck = 0;
  let ended = false;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });

  const stream = new ReadableStream({
    start(c) { controller = c; },
    // unseal() cancels after it has every byte. Keep the channel open so the
    // receiver can still send its "done" acknowledgement.
    cancel() {},
  });

  const ack = () => {
    if (!sinceAck) return;
    try { dc.send(JSON.stringify({ t: 'ack', n: sinceAck })); } catch { /* closing */ }
    sinceAck = 0;
  };
  const fail = (message) => {
    if (ended) return;
    ended = true;
    const err = new Error(message);
    try { controller.error(err); } catch { /* already closed */ }
    settle(err);
  };
  const onMessage = (event) => {
    if (ended) return;
    if (typeof event.data === 'string') {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'begin') {
        total = Math.max(0, Number(message.size) || 0);
        onBegin?.(total);
      } else if (message.t === 'end') {
        ended = true;
        ack();
        try { controller.close(); } catch { /* already closed */ }
        settle(null);
      }
      return;
    }
    const bytes = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : new Uint8Array(event.data.buffer ?? event.data);
    if (!bytes.byteLength) return;
    controller.enqueue(bytes);
    got += bytes.byteLength;
    onBytes?.(got, total);
    sinceAck++;
    if (sinceAck >= ACK_EVERY) ack();
  };
  const onClose = () => fail('The other device disconnected.');
  dc.binaryType = 'arraybuffer';
  dc.addEventListener('message', onMessage);
  dc.addEventListener('close', onClose);

  return {
    stream,
    done,
    ack,
    fail,
    close() {
      ended = true;
      dc.removeEventListener('message', onMessage);
      dc.removeEventListener('close', onClose);
    },
  };
}

/** Decrypts a received stream with the existing NMB2 path. */
export async function decryptTransfer(code, pepper, stream, onBytes) {
  const plain = await unseal(code, pepper, stream, onBytes);
  return unbundle(plain);
}

function isPrivateAddress(address) {
  if (!address) return false;
  const value = address.toLowerCase().replace(/%.*$/, '');
  if (value.includes(':')) {
    // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
    return value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value);
  }
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)          // link-local
    || (a === 100 && b >= 64 && b <= 127); // CGNAT 100.64/10
}

/**
 * Reads the real selected candidate pair. A host candidate is a direct local
 * path: a visible private address says "Local Wi-Fi"; a masked mDNS/empty
 * address still says "Local network" (it cannot name the network). srflx and
 * prflx candidates leave the LAN, so those are "Internet P2P".
 */
export async function describeConnection(pc) {
  let stats;
  try {
    stats = await pc.getStats();
  } catch {
    return { kind: 'unknown', label: 'Connecting…', pair: '' };
  }
  let pairId = '';
  stats.forEach((report) => {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pairId = report.selectedCandidatePairId;
    }
  });
  let pair = null;
  stats.forEach((report) => {
    if (report.type !== 'candidate-pair') return;
    if (pairId ? report.id === pairId : (report.nominated && report.state === 'succeeded')) {
      pair = report;
    }
  });
  if (!pair) return { kind: 'unknown', label: 'Connecting…', pair: '' };

  let local = null;
  stats.forEach((report) => {
    if (report.type === 'local-candidate' && report.id === pair.localCandidateId) local = report;
  });
  if (!local) return { kind: 'unknown', label: 'Connecting…', pair: pair.id };

  if (local.candidateType === 'relay') {
    return { kind: 'relay', label: 'Not direct (relayed)', pair: pair.id };
  }
  if (local.candidateType === 'host') {
    const address = String(local.address || '').trim();
    if (isPrivateAddress(address)) {
      // A visible private address proves the local hop.
      return { kind: 'local', label: 'Local Wi-Fi', pair: pair.id };
    }
    const looksLikeIp = /^[0-9a-f:.]+$/i.test(address) && !address.toLowerCase().endsWith('.local');
    if (!address || !looksLikeIp) {
      // Chrome hides host addresses behind mDNS names (".local") or empties
      // them. The candidate is still a host candidate, so the traffic is
      // direct and local, but the name cannot prove which network: say
      // "Local network", not "Internet P2P".
      return { kind: 'local', label: 'Local network', pair: pair.id };
    }
    // A publicly routable host address is direct, but not local.
    return { kind: 'internet', label: 'Internet P2P', pair: pair.id };
  }
  // srflx / prflx: the path leaves the local network.
  return { kind: 'internet', label: 'Internet P2P', pair: pair.id };
}

/** Watches the selected pair so the label follows a real path change. */
export function watchConnection(pc, onChange, interval = 2000) {
  let stopped = false;
  let last = '';
  const sample = async () => {
    if (stopped || pc.signalingState === 'closed') return;
    const info = await describeConnection(pc);
    const key = `${info.kind}:${info.pair}`;
    if (key !== last) {
      last = key;
      onChange(info);
    }
  };
  sample();
  const timer = setInterval(sample, interval);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
