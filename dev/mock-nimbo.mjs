// In-memory stand-in for the nimbo.fun API, covering the endpoints 4dots uses.
// Lets you run the app locally without touching real storage: `npm run dev`.
import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export function startMockNimbo(port = 0) {
  const files = new Map(); // full path -> { bytes, type }

  const clean = (path) => String(path ?? '').replace(/^\/+|\/+$/g, '');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!/^Bearer nimbo_\S+$/.test(req.headers.authorization ?? '')) {
      return send(401, { error: 'Missing or invalid token' });
    }
    try {
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/v1/me') {
        const used = [...files.values()].reduce((n, f) => n + f.bytes.length, 0);
        return send(200, { user: { id: 'mock' }, plan: 'mock', storage: { usedBytes: String(used), freeBytes: null } });
      }
      if (route === 'POST /api/v1/files/folder') {
        const body = await new Response(Readable.toWeb(req)).json();
        return send(200, { ok: true, path: clean(body.path) });
      }
      if (route === 'POST /api/v1/files/upload') {
        const form = await new Request('http://mock', {
          method: 'POST',
          headers: req.headers,
          body: Readable.toWeb(req),
          duplex: 'half',
        }).formData();
        const folder = clean(form.get('path'));
        const results = [];
        for (const file of form.getAll('file')) {
          const path = folder ? `${folder}/${file.name}` : file.name;
          files.set(path, { bytes: Buffer.from(await file.arrayBuffer()), type: file.type });
          results.push({ ok: true, name: file.name, path, size: String(file.size) });
        }
        if (!results.length) return send(400, { error: 'Missing file' });
        return send(200, { results });
      }
      if (route === 'GET /api/v1/files/download') {
        const file = files.get(clean(url.searchParams.get('path')));
        if (!file) return send(404, { error: 'File not found' });
        res.writeHead(200, {
          'content-type': file.type || 'application/octet-stream',
          'content-length': file.bytes.length,
        });
        // Stream in small chunks like a real server would.
        return Readable.from(chunked(file.bytes)).pipe(res);
      }
      if (route === 'GET /api/v1/files') {
        const folder = clean(url.searchParams.get('path'));
        const prefix = folder ? `${folder}/` : '';
        const list = [...files]
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
          .map(([path, file]) => ({ name: path.slice(prefix.length), path, size: String(file.bytes.length) }));
        return send(200, { path: folder, folders: [], files: list });
      }
      if (route === 'DELETE /api/v1/files') {
        if (!files.delete(clean(url.searchParams.get('path')))) return send(404, { error: 'Path not found' });
        return send(200, { ok: true });
      }
      send(404, { error: 'Not found' });
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, files, close: () => server.close() });
    });
  });
}

function* chunked(bytes, size = 64 * 1024) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mock = await startMockNimbo(Number(process.env.MOCK_PORT) || 4010);
  console.log(`mock nimbo listening on ${mock.url}`);
}
