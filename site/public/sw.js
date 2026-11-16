/**
 * Barbearia Hanoff — Service Worker
 * - Páginas: rede primeiro (conteúdo sempre atual), cópia salva se estiver sem internet.
 * - Arquivos com hash do build (/assets/) e imagens: cache primeiro.
 * - A API (/api/) nunca é guardada: horários livres mudam a cada agendamento.
 */
const VERSION = 'hanoff-v4';
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const CORE = ['/', '/agendamento/', '/manifest.json', '/images/logo-hanoff.svg', '/images/favicon.svg', '/images/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PAGES).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('hanoff-') && ![PAGES, STATIC].includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(PAGES).then((cache) => cache.put(url.pathname, copy));
          }
          return response;
        })
        .catch(() => caches.match(url.pathname).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/images/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(STATIC).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
});
