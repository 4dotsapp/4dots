// Client-side encryption. Plaintext never leaves the browser.
//
// Wire format: "NMB2" | salt (16) | nonce prefix (7) | reserved (1) | chunks…
// The plaintext is sealed in 4 MiB chunks with AES-256-GCM so a 1 GB drop never
// has to sit in memory at once. Chunk i uses nonce = prefix | i (u32) | last flag,
// so chunks can't be reordered, dropped, or the stream cut short unnoticed.
// Key: PBKDF2-SHA256(code + ":" + pepper, salt). The pepper comes from the server
// and is only handed to people who know the code, so storage can't brute-force it.

const MAGIC = new TextEncoder().encode('NMB2');
const HEADER = 28;
const CHUNK = 4 * 1024 * 1024;
const TAG = 16;
const ITERATIONS = 600_000;
const encoder = new TextEncoder();

async function deriveKey(code, pepper, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(`${code}:${pepper}`), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function nonce(prefix, index, last) {
  const iv = new Uint8Array(12);
  iv.set(prefix);
  new DataView(iv.buffer).setUint32(7, index);
  iv[11] = last ? 1 : 0;
  return iv;
}

/** Bundles a note and files into one Blob: u32 metadata length, metadata JSON, then file bytes. */
export function bundle(text, files) {
  const meta = encoder.encode(JSON.stringify({
    v: 1,
    text,
    files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
  }));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, meta.length);
  return new Blob([head, meta, ...files]);
}

/** Splits a decrypted bundle back into its note and files, as slices of the same Blob. */
export async function unbundle(plain) {
  const fail = () => new Error('This drop is malformed.');
  if (plain.size < 4) throw fail();
  const metaLength = new DataView(await plain.slice(0, 4).arrayBuffer()).getUint32(0);
  if (4 + metaLength > plain.size) throw fail();
  const meta = JSON.parse(await plain.slice(4, 4 + metaLength).text());

  let offset = 4 + metaLength;
  const files = [];
  for (const entry of Array.isArray(meta.files) ? meta.files : []) {
    const size = Number(entry.size);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > plain.size) throw fail();
    files.push({
      name: String(entry.name || 'file'),
      type: String(entry.type || ''),
      size,
      blob: plain.slice(offset, offset + size),
    });
    offset += size;
  }
  return { text: typeof meta.text === 'string' ? meta.text : '', files };
}

/** Encrypts a Blob chunk by chunk. Each sealed chunk goes straight into a Blob so the browser can page it out. */
export async function seal(code, pepper, plain, onProgress = () => {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prefix = crypto.getRandomValues(new Uint8Array(7));
  const key = await deriveKey(code, pepper, salt);
  const header = new Uint8Array(HEADER);
  header.set(MAGIC, 0);
  header.set(salt, 4);
  header.set(prefix, 20);

  const parts = [header];
  for (let index = 0, offset = 0; ; index++) {
    const end = Math.min(offset + CHUNK, plain.size);
    const last = end === plain.size;
    const chunk = await plain.slice(offset, end).arrayBuffer();
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(prefix, index, last), additionalData: MAGIC }, key, chunk);
    parts.push(new Blob([sealed]));
    onProgress(plain.size ? end / plain.size : 1);
    if (last) break;
    offset = end;
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}

/** Decrypts a download as it streams in. `onBytes` gets the running count of ciphertext bytes read. */
export async function unseal(code, pepper, stream, onBytes = () => {}) {
  const reader = stream.getReader();
  const queue = [];
  let queued = 0;
  let received = 0;
  let done = false;

  const fill = async (bytes) => {
    while (!done && queued < bytes) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      queue.push(result.value);
      queued += result.value.length;
      received += result.value.length;
      onBytes(received);
    }
  };
  const take = (bytes) => {
    const out = new Uint8Array(bytes);
    let filled = 0;
    while (filled < bytes) {
      const head = queue[0];
      const n = Math.min(head.length, bytes - filled);
      out.set(head.subarray(0, n), filled);
      filled += n;
      if (n === head.length) queue.shift();
      else queue[0] = head.subarray(n);
    }
    queued -= bytes;
    return out;
  };

  try {
    await fill(HEADER);
    if (queued < HEADER) throw new Error('This is not a 4dots drop.');
    const header = take(HEADER);
    if (!MAGIC.every((byte, i) => header[i] === byte)) throw new Error('This is not a 4dots drop.');
    const key = await deriveKey(code, pepper, header.subarray(4, 20));
    const prefix = header.subarray(20, 27);

    const parts = [];
    for (let index = 0; ; index++) {
      // A full chunk with more bytes after it can't be the last one.
      await fill(CHUNK + TAG + 1);
      const last = queued <= CHUNK + TAG;
      if (last && queued < TAG) throw new Error('This drop was cut short.');
      const sealed = take(last ? queued : CHUNK + TAG);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(prefix, index, last), additionalData: MAGIC }, key, sealed);
      parts.push(new Blob([plain]));
      if (last) return new Blob(parts);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
