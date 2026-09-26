const CACHE = "cumads-cliente-v2";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png", "/mascot.jpg", "/mascot.webp"];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}));
});

self.addEventListener('activate', (e) => {
  // Apaga só os caches ANTIGOS. Antes eu apagava todos, inclusive o que
  // acabara de ser criado — o offline ficava sempre vazio.
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return;          // Firebase, fontes, etc.
  if(url.pathname.startsWith('/gerencial')) return;   // painel tem cache próprio

  // Busca na rede e guarda uma cópia; se a rede falhar, serve do cache.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if(resp && resp.status === 200 && resp.type === 'basic'){
          const copia = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia)).catch(()=>{});
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});
