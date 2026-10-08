// ============================================================
//  Reportes SEJ v8 — base compartida de las terminales
//  • Revisa que haya sesión válida (si no, regresa al inicio de sesión)
//  • Conecta con el servidor usando el pase de la sesión
//  • Separa los datos guardados en el aparato por usuario
// ============================================================
"use strict";

const SEJ = (() => {
  const LS = window.localStorage;
  const leer = k => { try { return JSON.parse(LS.getItem(k)); } catch (e) { return null; } };
  const cfg = leer("sejv8_config");
  const ses = leer("sejv8_sesion");
  const pagina = location.pathname.split("/").pop() || "index.html";
  const permitidos = { "captura.html": ["prefectura", "gabinete"], "direccion.html": ["direccion"] };

  const valida = cfg && cfg.url && ses && ses.token && new Date(ses.expira) > new Date() &&
    ses.usuario && !ses.usuario.debeCambiar &&
    (!permitidos[pagina] || permitidos[pagina].includes(ses.usuario.rol));
  if (!valida) {
    location.replace("index.html");
    throw new Error("Sin sesión válida");
  }

  const usuario = ses.usuario;
  const ROL = {
    prefectura: { etiqueta: "Prefectura", sep: "-" },
    gabinete: { etiqueta: "Gabinete psicopedagógico", sep: "-" },
    direccion: { etiqueta: "Dirección", sep: "X" }
  }[usuario.rol];

  // Claves "sej_..." de las terminales → "sejv8_<usuario>_..." (no se mezclan con la v7 ni entre usuarios)
  const ns = k => (typeof k === "string" && k.startsWith("sej_")) ? `sejv8_${usuario.usuario}_${k.slice(4)}` : k;

  function guardarSesion() { try { LS.setItem("sejv8_sesion", JSON.stringify(ses)); } catch (e) { } }

  class ErrorApi extends Error { constructor(m, c) { super(m); this.codigo = c; } }

  // Si en este aparato Google desvía los envíos POST, se usa directo la vía GET (una sola petición en vez de dos).
  async function enviar(url, cuerpo) {
    const json = JSON.stringify(cuerpo);
    if (LS.getItem("sejv8_via") === "get" && json.length < 3000) {
      return (await fetch(url + "?p=" + encodeURIComponent(json))).json();
    }
    let d = await (await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: json })).json();
    if (d && d.codigo === "V7_DESACTIVADA") {
      LS.setItem("sejv8_via", "get");
      d = await (await fetch(url + "?p=" + encodeURIComponent(json))).json();
    }
    return d;
  }

  async function api(accion, datos = {}) {
    if (!navigator.onLine) throw new ErrorApi("No hay conexión a internet.", "SIN_RED");
    const cuerpo = Object.assign({ accion, token: ses.token }, datos);
    let d;
    try {
      d = await enviar(cfg.url, cuerpo);
    } catch (e) {
      throw new ErrorApi("No se pudo conectar con el servidor. Revisa tu internet.", "SIN_RED");
    }
    if (!d.ok) {
      if (d.codigo === "SESION_INVALIDA") {
        LS.removeItem("sejv8_sesion");
        alert("Tu sesión terminó. Inicia sesión de nuevo; lo que tengas sin enviar se conserva en este aparato.");
        location.replace("index.html");
      }
      if (d.codigo === "USUARIO_BAJA") { usuario.activo = false; guardarSesion(); }
      throw new ErrorApi(d.error || "Ocurrió un error.", d.codigo);
    }
    return d;
  }

  // Último número usado por prefijo (iniciales + grado + grupo), para numerar sin conexión
  function contador(prefijo) { return Number((ses.contadores || {})[prefijo]) || 0; }
  function registrarFolio(folio) {
    const sep = ROL.sep === "-" ? "-" : "X";
    const m = String(folio || "").match(sep === "-" ? /^(.+)-(\d{5})$/ : /^(.+?)X(\d{5})$/);
    if (!m) return;
    ses.contadores = ses.contadores || {};
    ses.contadores[m[1]] = Math.max(contador(m[1]), Number(m[2]));
    guardarSesion();
  }
  async function actualizarContadores() {
    const d = await api("contadores");
    const previos = ses.contadores || {};
    ses.contadores = d.contadores || {};
    Object.keys(previos).forEach(k => { ses.contadores[k] = Math.max(Number(ses.contadores[k]) || 0, Number(previos[k]) || 0); });
    guardarSesion();
  }

  return { cfg, ses, usuario, ROL, ns, api, ErrorApi, LS, contador, registrarFolio, actualizarContadores, guardarSesion };
})();

// Todas las lecturas y escrituras de las terminales pasan por aquí.
// eslint-disable-next-line no-shadow-restricted-names
const localStorage = {
  getItem: k => SEJ.LS.getItem(SEJ.ns(k)),
  setItem: (k, v) => SEJ.LS.setItem(SEJ.ns(k), v),
  removeItem: k => SEJ.LS.removeItem(SEJ.ns(k))
};

// Barra superior común: usuario, estado de conexión y acceso a "Mi cuenta"
function sejBarra(destinoCuenta, textoCuenta) {
  const b = document.createElement("div");
  b.className = "no-print";
  b.innerHTML = `
    <div style="background:#1D3557;color:#fff;font-family:'Segoe UI',Roboto,system-ui,sans-serif">
      <div style="max-width:80rem;margin:0 auto;display:flex;align-items:center;gap:.75rem;padding:.55rem 1rem;flex-wrap:wrap">
        <b style="flex:1;min-width:10rem">Reportes SEJ · ${SEJ.ROL.etiqueta}</b>
        <span id="sejRed" style="font-size:.8rem;padding:.1rem .55rem;border-radius:99px;background:rgba(255,255,255,.15)"></span>
        <span style="font-size:.9rem">${String(SEJ.usuario.nombre).replace(/[&<>"']/g, "")} (${SEJ.usuario.iniciales})</span>
        <a href="${destinoCuenta}" style="color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:8px;padding:.3rem .7rem;text-decoration:none;font-size:.9rem">${textoCuenta}</a>
      </div>
    </div>`;
  document.body.prepend(b);
  const red = () => {
    const e = document.getElementById("sejRed");
    e.textContent = navigator.onLine ? "En línea" : "Sin conexión: lo que guardes se enviará después";
    e.style.background = navigator.onLine ? "rgba(255,255,255,.15)" : "#E9A23B";
    e.style.color = navigator.onLine ? "#fff" : "#2B1B00";
  };
  red();
  window.addEventListener("online", red);
  window.addEventListener("offline", red);
}

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
