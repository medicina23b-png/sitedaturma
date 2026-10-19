/**
 * Service Worker do app Medicina 23B.
 *
 * 1. Instalação/atualização: guarda o "esqueleto" do site (index.html,
 *    ícones, manifest) para o app abrir na hora, mesmo com internet ruim.
 *    O index.html é buscado primeiro na rede (sempre a versão mais nova) e só
 *    cai no cache se a rede falhar ou demorar demais. Os dados (cronograma,
 *    mural, notas...) sempre vêm do Firestore, nunca deste cache.
 * 2. Push: recebe as mensagens do Firebase Cloud Messaging enviadas pelo
 *    Worker da Cloudflare (push-worker/) e mostra a notificação no celular,
 *    mesmo com o app fechado.
 * 3. Toque na notificação: abre (ou traz pra frente) o app já na aba certa.
 *
 * Ao mudar este arquivo, troque a versão abaixo — é isso que faz os
 * aparelhos baixarem a atualização.
 */
const VERSAO = 'v3-2026-10-19';
const CACHE = 'medicina23b-' + VERSAO;
const ARQUIVOS_ESTATICOS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.ico',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_ESTATICOS)).catch(() => { /* ok falhar, não é crítico */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const chaves = await caches.keys();
    await Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (e) { /* ok */ } }
    await self.clients.claim();
  })());
});

// A página pede pra ativar uma versão nova na hora (ver index.html).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

// Rede com limite de tempo: se a internet estiver muito lenta, mostra o que
// tem no cache em vez de deixar a tela em branco esperando.
function comTempoLimite(promessa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promessa.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firestore/Auth/FCM (outros domínios) passam direto pela rede.
  if (url.origin !== self.location.origin) return;

  // Navegação (abrir o app): rede primeiro, cache como reserva.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const pre = event.preloadResponse ? await event.preloadResponse : null;
        const resp = pre || await comTempoLimite(fetch(req), 4000);
        if (resp && resp.ok) cache.put('./index.html', resp.clone()).catch(() => {});
        return resp;
      } catch (e) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Ícones e outros estáticos: cache primeiro (mudam raramente), atualizando
  // em segundo plano.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const emCache = await cache.match(req);
    const daRede = fetch(req).then((resp) => {
      if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
      return resp;
    }).catch(() => null);
    return emCache || (await daRede) || Response.error();
  })());
});

/* ---------------------------- Push ---------------------------- */
// O Worker manda mensagens só com "data" (sem "notification"), então é
// sempre este código que monta a notificação — igual em Android, iPhone e
// computador. Formato do FCM: { data: { titulo, corpo, url, tag, ... } }.
function lerPayload(event) {
  if (!event.data) return {};
  try {
    const j = event.data.json();
    const d = Object.assign({}, j.notification || {}, j.data || {}, (j.data && j.data.payload) ? JSON.parse(j.data.payload) : {});
    return d;
  } catch (e) {
    try { return { corpo: event.data.text() }; } catch (_) { return {}; }
  }
}

self.addEventListener('push', (event) => {
  const d = lerPayload(event);
  const titulo = d.titulo || d.title || 'Medicina 23B';
  const opcoes = {
    body: d.corpo || d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-maskable-192.png',
    tag: d.tag || undefined,          // mesma tag = substitui (evita duplicar com o aviso do app aberto)
    renotify: !!d.tag,
    data: { url: d.url || './' },
    vibrate: [80, 40, 80],
    timestamp: Date.now(),
  };
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destino = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of janelas) {
      if (c.url.startsWith(self.registration.scope)) {
        try { c.postMessage({ tipo: 'abrir', url: destino }); } catch (e) { /* ok */ }
        return c.focus();
      }
    }
    return self.clients.openWindow(destino);
  })());
});

// O navegador às vezes renova a inscrição de push sozinho; avisa a página
// aberta para registrar o token novo no Firestore.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    janelas.forEach((c) => { try { c.postMessage({ tipo: 'renovar-push' }); } catch (e) { /* ok */ } });
  })());
});
