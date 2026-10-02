// Receives what's shared to the installed app from the system share sheet. Shared
// files must stay on this device until the browser encrypts them, so they wait in
// Cache Storage and the app picks them up right after the redirect.
const SHARE_CACHE = '4dots-share';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Only the share endpoint needs this worker. Everything else goes straight to the
  // network, so having it installed never slows down loading the app.
  try {
    event.waitUntil(event.addRoutes?.([
      { condition: { urlPattern: new URLPattern({ pathname: '/share' }) }, source: 'fetch-event' },
      { condition: { urlPattern: new URLPattern({}) }, source: 'network' },
    ]).catch(() => {}));
  } catch {}
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/share') return;
  event.respondWith(receive(request));
});

async function receive(request) {
  const form = await request.formData();
  await caches.delete(SHARE_CACHE);
  const cache = await caches.open(SHARE_CACHE);

  // Apps often repeat the title or the link inside the text; keep each piece once.
  const parts = [];
  for (const key of ['title', 'text', 'url']) {
    const value = String(form.get(key) ?? '').trim();
    if (!value || parts.some((part) => part.includes(value))) continue;
    for (let i = parts.length - 1; i >= 0; i--) if (value.includes(parts[i])) parts.splice(i, 1);
    parts.push(value);
  }

  const files = form.getAll('files').filter((file) => file instanceof File && file.size);
  await Promise.all(files.map((file, i) => cache.put(`/share/file/${i}`, new Response(file))));
  const meta = {
    text: parts.join('\n'),
    files: files.map((file, i) => ({ key: `/share/file/${i}`, name: file.name, type: file.type, lastModified: file.lastModified })),
  };
  await cache.put('/share/meta', Response.json(meta));
  return Response.redirect('/?share', 303);
}
