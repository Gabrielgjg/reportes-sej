// Reportes SEJ — funciona sin conexión.
// La app se guarda en el aparato; las peticiones al servidor nunca se guardan.
const CACHE = "reportes-sej-v8-4";
const ARCHIVOS = ["./", "./index.html", "./captura.html", "./direccion.html", "./v8-base.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];
// Diseño de las terminales (se guardan para funcionar sin conexión)
const EXTERNOS = [
  "https://cdn.tailwindcss.com",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"
];
const HOSTS_EXTERNOS = ["cdn.tailwindcss.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ARCHIVOS);
    await Promise.all(EXTERNOS.map(u => fetch(u, { mode: "no-cors" }).then(r => c.put(u, r)).catch(() => { })));
  }).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (HOSTS_EXTERNOS.includes(url.hostname)) {
    // Diseño externo: usa lo guardado y lo actualiza cuando hay internet
    e.respondWith(caches.open(CACHE).then(c => c.match(req, { ignoreVary: true }).then(g => {
      const red = fetch(req).then(r => { c.put(req, r.clone()); return r; }).catch(() => g);
      return g || red;
    })));
    return;
  }
  if (url.origin !== location.origin) return; // servidor de la escuela: siempre en línea

  if (req.mode === "navigate") {
    // Página: primero la versión nueva; si no hay internet, la guardada.
    e.respondWith(fetch(req).then(r => {
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(req, copia));
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(g => g || caches.match("./index.html"))));
    return;
  }
  // Archivos propios: primero la versión nueva; sin internet, la guardada.
  e.respondWith(fetch(req).then(r => {
    const copia = r.clone();
    caches.open(CACHE).then(c => c.put(req, copia));
    return r;
  }).catch(() => caches.match(req)));
});
