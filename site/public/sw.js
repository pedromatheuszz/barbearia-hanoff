/**
 * Barbearia Hanoff — Service Worker
 * - Páginas: rede primeiro (conteúdo sempre atual), cópia salva se estiver sem internet.
 * - Arquivos com hash do build (/assets/): cache primeiro (o nome muda a cada versão).
 * - Imagens (/images/, sem hash): mostra a cópia salva e atualiza em segundo plano,
 *   para uma logo ou ícone novo aparecer sem precisar trocar a versão do cache.
 * - A API (/api/) nunca é guardada: horários livres mudam a cada agendamento.
 */
const VERSION = 'hanoff-v5';
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const CORE_PAGES = ['/', '/agendamento/', '/manifest.json'];
const CORE_IMAGES = ['/images/logo-hanoff.svg', '/images/favicon.svg', '/images/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(PAGES).then((cache) => cache.addAll(CORE_PAGES)),
    caches.open(STATIC).then((cache) => cache.addAll(CORE_IMAGES)),
  ]).catch(() => {}).then(() => self.skipWaiting()));
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

  const save = (response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(STATIC).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(save)));
    return;
  }

  if (url.pathname.startsWith('/images/')) {
    const fresh = fetch(request).then(save);
    event.waitUntil(fresh.catch(() => {}));
    // procura só no cache de arquivos (onde a cópia nova é gravada)
    event.respondWith(caches.open(STATIC).then((cache) => cache.match(request)).then((hit) => hit || fresh));
  }
});
