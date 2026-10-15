/**
 * Service Worker mínimo — existe principalmente para o Android/Chrome
 * considerar o site "instalável" (um dos requisitos do navegador, junto com
 * o manifest.json e os ícones). Guarda os arquivos estáticos (o próprio
 * index.html, ícones, manifest) para abrir mais rápido e funcionar por um
 * instante mesmo sem internet — os dados em si (cronograma, mural, notas
 * etc.) sempre vêm direto do Firestore/Cloud Functions, nunca do cache daqui.
 */
const CACHE = 'cronograma-shell-v1';
const ARQUIVOS_ESTATICOS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_ESTATICOS)).catch(() => { /* ok falhar, não é crítico */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Só intercepta GET para os arquivos do próprio site (navegação e estáticos).
// Qualquer chamada a Firestore/Cloud Functions/Storage do Firebase (outro
// domínio) passa direto pela rede, nunca pelo cache — os dados precisam
// estar sempre atualizados.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copia)).catch(() => { /* ok falhar */ });
        return resp;
      })
      .catch(() => caches.match(req).then((resp) => resp || caches.match('./index.html')))
  );
});
