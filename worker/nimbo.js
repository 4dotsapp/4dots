// Client for the nimbo.fun REST API (https://nimbo.fun/docs).
// Only the Worker talks to nimbo; the API key never reaches the browser.
import { HttpError } from './http.js';

const encoder = new TextEncoder();

export function nimbo(env) {
  const baseUrl = env.NIMBO_BASE_URL || 'https://nimbo.fun';
  const folder = (env.NIMBO_FOLDER ?? 'drop').replace(/^\/+|\/+$/g, '');
  const auth = { authorization: `Bearer ${env.NIMBO_TOKEN}` };
  const fullPath = (name) => (folder ? `${folder}/${name}` : name);

  async function call(method, path, { query, json, body, headers, signal } = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const init = { method, headers: { ...auth, ...headers }, body, signal };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    try {
      return await fetch(url, init);
    } catch (err) {
      console.warn(`nimbo ${method} ${path}: ${err.message}`);
      throw new HttpError(502, 'Storage is unreachable right now. Try again in a moment.');
    }
  }

  return {
    async ensureFolder() {
      if (!folder) return;
      // Fails harmlessly when the folder already exists.
      const res = await call('POST', '/api/v1/files/folder', { json: { path: folder } });
      await res.body?.cancel();
    },

    /**
     * Streams one file to nimbo without buffering it. The multipart envelope is
     * written by hand around `body` so the request carries an exact length.
     * `start` holds bytes already read from `body`; `length` counts them too.
     */
    async upload(name, body, length, start = new Uint8Array(0)) {
      const boundary = `----4dots${crypto.randomUUID().replaceAll('-', '')}`;
      const envelope = encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${folder}\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n`
        + 'Content-Type: application/octet-stream\r\n\r\n',
      );
      const head = new Uint8Array(envelope.length + start.length);
      head.set(envelope);
      head.set(start, envelope.length);
      const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
      const { readable, writable } = new FixedLengthStream(envelope.length + length + tail.length);
      const writing = (async () => {
        let writer = writable.getWriter();
        await writer.write(head);
        writer.releaseLock();
        // Native to native, so piping the bulk of the file costs no CPU time.
        await body.pipeTo(writable, { preventClose: true });
        writer = writable.getWriter();
        await writer.write(tail);
        await writer.close();
      })();
      const [res] = await Promise.all([
        call('POST', '/api/v1/files/upload', {
          body: readable,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        }),
        writing,
      ]);
      if (!res.ok) throw await failure(res, 'upload');
      const problem = findFailure(await res.json().catch(() => null));
      if (problem) {
        console.warn(`nimbo upload: ${problem}`);
        throw /quota/i.test(problem) ? outOfStorage() : new HttpError(502, 'Storage refused the upload.');
      }
    },

    /** Raw response, so callers can stream the body straight on. */
    download(name) {
      return call('GET', '/api/v1/files/download', { query: { path: fullPath(name) } });
    },

    async remove(name) {
      const res = await call('DELETE', '/api/v1/files', { query: { path: fullPath(name) } });
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) throw await failure(res, 'delete');
    },

    // A quick, non-throwing reachability check for the status page. It reads only the
    // HTTP result and the round-trip time, never the account details in the response body.
    async health() {
      const started = Date.now();
      try {
        const res = await call('GET', '/api/v1/me', { signal: AbortSignal.timeout(5000) });
        await res.body?.cancel();
        return { ok: res.ok, status: res.status, ms: Date.now() - started };
      } catch {
        return { ok: false, status: 0, ms: Date.now() - started };
      }
    },
  };
}

// Storage won't take more data: the nimbo account's quota or the server's disk is
// full. It isn't the sender's fault and a retry won't clear it, so the message says
// so and the browser is told (by the 507) not to re-send the part.
export function outOfStorage() {
  return new HttpError(507, '4dots is out of storage right now. It’s not your file — please try again later.');
}

export async function failure(res, what) {
  const detail = await res.text().catch(() => '');
  console.warn(`nimbo ${what}: HTTP ${res.status} ${detail.slice(0, 200)}`);
  let code = '';
  try { code = String(JSON.parse(detail)?.code ?? ''); } catch {}
  // 403 (plan quota), 507 (server disk), and 413 all mean storage is full: parts are
  // capped well under nimbo's hard limit and the drop size is checked before upload,
  // so a 413 here is a quota refusal, not an oversized file.
  if (code === 'quota_exceeded' || res.status === 403 || res.status === 413 || res.status === 507) {
    return outOfStorage();
  }
  switch (res.status) {
    case 401:
      return new HttpError(502, 'Storage rejected the server’s API key.');
    case 429:
      return new HttpError(503, 'Storage is busy. Try again in a minute.', { 'retry-after': '60' });
    default:
      return new HttpError(502, 'Storage is unavailable right now.');
  }
}

// The docs describe upload results as per-file `ok: true | false` without a fixed
// envelope, so look for any failed entry rather than depending on one shape.
function findFailure(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 5) return null;
  if (data.ok === false) return String(data.code ?? data.error ?? data.message ?? 'upload failed');
  for (const value of Object.values(data)) {
    const problem = findFailure(value, depth + 1);
    if (problem) return problem;
  }
  return null;
}
