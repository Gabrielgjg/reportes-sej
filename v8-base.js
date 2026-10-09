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

// ============================================================
//  FOTOS DE EVIDENCIA
//  • Se comprimen en el aparato (≈1280 px, JPG) y pierden los datos ocultos (GPS, modelo).
//  • Mientras no se suben, viven en el aparato (IndexedDB), separadas por usuario.
//  • Ya subidas, el aparato conserva solo una miniatura.
// ============================================================
const SEJFotos = (() => {
  const MAX = 3, LADO = 1280, MINI = 240;
  const DB = `sejv8_fotos_${SEJ.usuario.usuario}`;
  let seleccion = []; // [{ id, datos, mini, ancho, alto }]
  let dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("fotos", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(modo, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("fotos", modo);
      const out = fn(t.objectStore("fotos"));
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const todas = () => tx("readonly", s => s.getAll());
  const poner = f => tx("readwrite", s => s.put(f));

  function cargarImagen(archivo) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }
  function aJpg(img, lado, calidad) {
    const k = Math.min(1, lado / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const datos = c.toDataURL("image/jpeg", calidad).split(",")[1];
    return { datos, ancho: c.width, alto: c.height };
  }
  async function comprimir(archivo) {
    const img = await cargarImagen(archivo);
    let f = aJpg(img, LADO, 0.72);
    if (f.datos.length > 340000) f = aJpg(img, LADO, 0.55);
    if (f.datos.length > 340000) f = aJpg(img, 1024, 0.55);
    const mini = aJpg(img, MINI, 0.6).datos;
    return { id: "F" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), datos: f.datos, mini, ancho: f.ancho, alto: f.alto };
  }

  // ---------- Selector en el formulario ----------
  let cont = null;
  function montar(elemento) {
    cont = elemento;
    pintarSeleccion();
  }
  function pintarSeleccion() {
    if (!cont) return;
    const miniaturas = seleccion.map((f, i) => `
      <div style="position:relative;width:64px;height:64px">
        <img src="data:image/jpeg;base64,${f.mini}" alt="Foto ${i + 1}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid #cbd5e1">
        <button type="button" data-quitar="${i}" aria-label="Quitar foto ${i + 1}" style="position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:0;background:#B42318;color:#fff;font-size:13px;line-height:22px;cursor:pointer">×</button>
      </div>`).join("");
    cont.innerHTML = `
      <div style="border:1px dashed #94a3b8;border-radius:8px;padding:.6rem .7rem;background:#f8fafc">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap">
          <span style="font-size:.75rem;font-weight:600;color:#475569">📷 Evidencia fotográfica (opcional, hasta ${MAX})</span>
          ${seleccion.length < MAX ? `<label style="font-size:.75rem;font-weight:700;color:#1D3557;cursor:pointer;border:1px solid #1D3557;border-radius:6px;padding:.25rem .6rem;background:#fff">
            Agregar foto<input type="file" accept="image/*" multiple hidden></label>` : ""}
        </div>
        ${seleccion.length ? `<div style="display:flex;gap:.6rem;margin-top:.6rem;flex-wrap:wrap">${miniaturas}</div>` : ""}
        <div data-estado style="font-size:.7rem;color:#64748b;margin-top:.35rem">${seleccion.length ? "Se guardarán con el reporte. Solo las verás tú y Dirección." : ""}</div>
      </div>`;
    const input = cont.querySelector('input[type="file"]');
    if (input) input.onchange = async () => {
      const archivos = [...input.files].slice(0, MAX - seleccion.length);
      cont.querySelector("[data-estado]").textContent = "Preparando foto…";
      for (const a of archivos) {
        try { seleccion.push(await comprimir(a)); } catch (e) { alert(e.message); }
      }
      if (input.files.length > archivos.length) alert(`Solo se permiten ${MAX} fotos por reporte.`);
      pintarSeleccion();
    };
    cont.querySelectorAll("[data-quitar]").forEach(b => b.onclick = () => { seleccion.splice(Number(b.dataset.quitar), 1); pintarSeleccion(); });
  }
  function limpiar() { seleccion = []; pintarSeleccion(); }

  // Al guardar el reporte: las fotos quedan en el aparato, pendientes de subir. Devuelve sus ids.
  function guardarSeleccion(reporte) {
    const lista = seleccion.slice();
    seleccion = []; pintarSeleccion();
    lista.forEach(f => poner({ id: f.id, reporteId: reporte.id, folio: reporte.folio, datos: f.datos, mini: f.mini, ancho: f.ancho, alto: f.alto, subida: false, creada: Date.now() }));
    return lista.map(f => f.id);
  }

  // ---------- Subida ----------
  async function subirUna(f) {
    const foto = { id: f.id, reporteId: f.reporteId, ancho: f.ancho, alto: f.alto };
    try {
      return await SEJ.api("subirFoto", { foto: Object.assign({ datos: f.datos }, foto) });
    } catch (e) {
      if (e.codigo !== "SIN_RED" || !navigator.onLine) throw e;
      // Vía lenta: en partes pequeñas (algunos aparatos desvían los envíos grandes)
      const partes = f.datos.match(/.{1,1800}/g);
      let ult = null;
      for (let i = 0; i < partes.length; i += 6) {
        const grupo = partes.slice(i, i + 6).map((parte, j) =>
          SEJ.api("subirFotoParte", { foto, n: i + j, total: partes.length, parte }));
        for (const r of await Promise.all(grupo)) if (r.completa) ult = r;
      }
      if (!ult) throw new SEJ.ErrorApi("La foto no terminó de subir.", "SIN_RED");
      return ult;
    }
  }
  async function subirPendientes(alAvanzar) {
    let lista;
    try { lista = (await todas()).filter(f => !f.subida); } catch (e) { return { subidas: 0, pendientes: 0 }; }
    let subidas = 0;
    for (const f of lista) {
      if (!navigator.onLine) break;
      if (alAvanzar) alAvanzar(subidas + 1, lista.length);
      try {
        const r = await subirUna(f);
        f.subida = true; f.datos = null; f.folio = r.folio || f.folio;
        await poner(f);
        subidas++;
      } catch (e) {
        if (e.codigo === "SIN_REPORTE") continue; // su reporte aún no sube
        if (e.codigo === "LIMITE" || e.codigo === "DATOS") { f.subida = true; f.error = e.message; await poner(f); continue; }
        break;
      }
    }
    return { subidas, pendientes: lista.length - subidas };
  }
  async function pendientes() { try { return (await todas()).filter(f => !f.subida).length; } catch (e) { return 0; } }

  // ---------- Fotos conocidas por reporte ----------
  const META = "sej_fotos_meta"; // lista que manda la nube (solo Dirección)
  function guardarMeta(lista) { localStorage.setItem(META, JSON.stringify(lista || [])); }
  function meta() { try { return JSON.parse(localStorage.getItem(META)) || []; } catch (e) { return []; } }
  function delReporte(rep) {
    const ids = new Set((rep.fotos || []).map(String));
    meta().forEach(m => { if (String(m.folio) === String(rep.folio) || String(m.reporteId) === String(rep.id)) ids.add(String(m.id)); });
    return [...ids];
  }
  function boton(rep) {
    const n = delReporte(rep).length;
    if (!n) return "";
    return `<button onclick="SEJFotos.abrir(${JSON.stringify(String(rep.folio || "")).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}, ${Number(rep.id) || 0})" title="Ver fotos de evidencia" class="text-[10px] bg-sky-50 text-sky-800 hover:bg-sky-600 hover:text-white font-bold px-2.5 py-1 rounded transition-colors flex items-center gap-1">📷 ${n}</button>`;
  }

  // ---------- Visor: una foto a la vez, con anterior / siguiente ----------
  let visor = null, lista = [], pos = 0, titulo = "";
  async function abrir(folio, reporteId) {
    const hist = JSON.parse(localStorage.getItem("sej_reports_history") || "[]");
    const rep = hist.find(r => String(r.folio) === String(folio) || r.id === reporteId) || { folio, id: reporteId };
    const ids = delReporte(rep);
    if (!ids.length) return;
    let locales = [];
    try { locales = await todas(); } catch (e) { }
    lista = ids.map(id => ({ id, local: locales.find(f => f.id === id) || null, datos: null }));
    pos = 0;
    titulo = `${rep.studentName ? rep.studentName + " · " : ""}Folio ${folio}`;
    crearVisor();
    mostrar();
  }
  function crearVisor() {
    if (visor) { visor.style.display = "flex"; return; }
    visor = document.createElement("div");
    visor.className = "no-print";
    visor.setAttribute("role", "dialog");
    visor.setAttribute("aria-label", "Fotos de evidencia");
    visor.style.cssText = "position:fixed;inset:0;z-index:100;background:rgba(10,15,25,.97);display:flex;flex-direction:column;color:#fff;font-family:'Segoe UI',Roboto,system-ui,sans-serif";
    visor.innerHTML = `
      <div style="display:flex;align-items:center;gap:.75rem;padding:.7rem 1rem">
        <div style="flex:1;min-width:0"><div data-t style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div><div data-c style="font-size:.85rem;opacity:.75"></div></div>
        <button data-cerrar aria-label="Cerrar" style="background:none;border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:8px;padding:.35rem .8rem;cursor:pointer">Cerrar ✕</button>
      </div>
      <div style="flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-height:0;padding:0 .5rem">
        <button data-ant aria-label="Foto anterior" style="position:absolute;left:.5rem;width:44px;height:44px;border-radius:50%;border:0;background:rgba(255,255,255,.18);color:#fff;font-size:1.4rem;cursor:pointer">‹</button>
        <div data-m style="opacity:.8"></div>
        <img data-i alt="" style="max-width:100%;max-height:100%;object-fit:contain;display:none;border-radius:4px">
        <button data-sig aria-label="Foto siguiente" style="position:absolute;right:.5rem;width:44px;height:44px;border-radius:50%;border:0;background:rgba(255,255,255,.18);color:#fff;font-size:1.4rem;cursor:pointer">›</button>
      </div>
      <div data-p style="text-align:center;font-size:.8rem;opacity:.7;padding:.6rem">Evidencia confidencial · solo para uso del plantel</div>`;
    document.body.appendChild(visor);
    visor.querySelector("[data-cerrar]").onclick = cerrar;
    visor.querySelector("[data-ant]").onclick = () => mover(-1);
    visor.querySelector("[data-sig]").onclick = () => mover(1);
    document.addEventListener("keydown", e => {
      if (!visor || visor.style.display === "none") return;
      if (e.key === "Escape") cerrar(); if (e.key === "ArrowLeft") mover(-1); if (e.key === "ArrowRight") mover(1);
    });
    let x0 = null;
    visor.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; }, { passive: true });
    visor.addEventListener("touchend", e => {
      if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) mover(dx < 0 ? 1 : -1);
    });
  }
  function cerrar() {
    if (!visor) return;
    visor.style.display = "none";
    lista.forEach(f => { f.datos = null; }); // no se guardan copias completas en memoria
    lista = [];
  }
  function mover(d) { if (lista.length > 1) { pos = (pos + d + lista.length) % lista.length; mostrar(); } }
  async function mostrar() {
    const f = lista[pos]; if (!f) return;
    const img = visor.querySelector("[data-i]"), msg = visor.querySelector("[data-m]");
    visor.querySelector("[data-t]").textContent = titulo;
    visor.querySelector("[data-c]").textContent = `Foto ${pos + 1} de ${lista.length}`;
    visor.querySelector("[data-ant]").style.display = visor.querySelector("[data-sig]").style.display = lista.length > 1 ? "" : "none";
    const ver = d => { img.src = "data:image/jpeg;base64," + d; img.style.display = ""; msg.textContent = ""; };
    img.style.display = "none";
    if (f.datos) return ver(f.datos);
    if (f.local && f.local.datos) return ver(f.local.datos);
    if (f.local && f.local.error) { msg.textContent = "Esta foto no se pudo guardar en la nube: " + f.local.error; return; }
    if (!navigator.onLine) {
      if (f.local && f.local.mini) { ver(f.local.mini); msg.textContent = ""; visor.querySelector("[data-c]").textContent += " · vista reducida (sin conexión)"; return; }
      msg.textContent = "Se necesita internet para ver esta foto."; return;
    }
    msg.textContent = "Cargando foto…";
    const pedida = f.id;
    try {
      const r = await SEJ.api("verFoto", { id: f.id });
      f.datos = r.datos;
      if (lista[pos] && lista[pos].id === pedida) ver(r.datos);
    } catch (e) {
      if (lista[pos] && lista[pos].id === pedida) {
        if (f.local && f.local.mini) { ver(f.local.mini); visor.querySelector("[data-c]").textContent += " · vista reducida"; }
        else msg.textContent = e.message;
      }
    }
  }

  return { montar, limpiar, guardarSeleccion, subirPendientes, pendientes, guardarMeta, delReporte, boton, abrir, cerrar };
})();

// ============================================================
//  PADRÓN DE ALUMNOS: buscar al alumno al capturar
//  • Se guarda en el aparato para funcionar sin internet (solo activos:
//    código, nombre, grado, grupo y tutor).
//  • Elegir al alumno llena grado, grupo y tutor.
//  • Si no está en la lista, se escribe a mano y Dirección/secretaría lo revisa.
// ============================================================
const SEJPadron = (() => {
  const CLAVE = "sej_padron";
  let datos = null, codigo = "", elegido = null, caja = null, activo = -1, resultados = [];
  const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function cargarLocal() {
    if (datos) return datos;
    try { datos = JSON.parse(localStorage.getItem(CLAVE)) || null; } catch (e) { datos = null; }
    return datos;
  }
  const alumnos = () => ((cargarLocal() || {}).alumnos || []).map(a => ({ codigo: a[0], nombre: a[1], grado: a[2], grupo: a[3], tutor: a[4], n: norm(a[1]) }));

  async function actualizar() {
    if (!navigator.onLine) return false;
    try {
      const d = await SEJ.api("padron", { version: (cargarLocal() || {}).version || "" });
      if (d.sinCambios) return false;
      datos = { version: d.version, alumnos: d.alumnos || [], sinPadron: !!d.sinPadron };
      localStorage.setItem(CLAVE, JSON.stringify(datos));
      return true;
    } catch (e) { return false; }
  }

  function buscar(texto) {
    const palabras = norm(texto).split(" ").filter(Boolean);
    if (!palabras.length) return [];
    return alumnos().filter(a => palabras.every(p => a.n.includes(p))).slice(0, 8);
  }

  function disparar(el) { el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); }

  function elegir(a) {
    const nombre = document.getElementById("studentName");
    const grado = document.getElementById("studentGrade");
    const grupo = document.getElementById("studentGroup");
    const tutor = document.getElementById("tutorName");
    nombre.value = a.nombre; codigo = a.codigo; elegido = a;
    if (a.grado && [...grado.options].some(o => o.value === a.grado)) { grado.value = a.grado; disparar(grado); }
    if (a.grupo) { grupo.value = a.grupo; disparar(grupo); }
    if (tutor && a.tutor) { tutor.value = a.tutor; disparar(tutor); }
    disparar(nombre);
    if (typeof window.calculateNextFolio === "function") window.calculateNextFolio();
    if (typeof window.calculateNextDirectionFolio === "function") window.calculateNextDirectionFolio();
    cerrarLista();
    pintarEstado();
  }

  function cerrarLista() { if (caja) caja.style.display = "none"; activo = -1; }

  function pintarLista(texto) {
    if (!caja) return;
    const hay = alumnos().length > 0;
    resultados = buscar(texto);
    if (!hay || !norm(texto)) { cerrarLista(); return; }
    caja.innerHTML = resultados.map((a, i) => `
      <div data-i="${i}" role="option" style="padding:.45rem .7rem;cursor:pointer;display:flex;justify-content:space-between;gap:.5rem;${i === activo ? "background:#EEF2FF" : ""}">
        <span style="font-size:.85rem">${esc(a.nombre)}</span>
        <span style="font-size:.75rem;color:#64748b;white-space:nowrap">${esc(a.grado)} ${esc(a.grupo)}</span>
      </div>`).join("") +
      `<div style="padding:.45rem .7rem;font-size:.72rem;color:#8A5A00;background:#FFF8E6;border-top:1px solid #f1e3bd">
        ${resultados.length ? "¿No aparece?" : "No está en la lista."} Escribe el nombre completo y se enviará a revisión con la secretaría.</div>`;
    caja.style.display = "block";
    caja.querySelectorAll("[data-i]").forEach(el => el.onmousedown = e => { e.preventDefault(); elegir(resultados[Number(el.dataset.i)]); });
  }

  function pintarEstado() {
    const e = document.getElementById("sejPadronEstado");
    if (!e) return;
    if (!alumnos().length) { e.textContent = ""; return; }
    e.innerHTML = codigoActual()
      ? `<span style="color:#2F7D4A">✓ Alumno del padrón (${esc(codigo)})</span>`
      : (norm(document.getElementById("studentName").value) ? `<span style="color:#8A5A00">No está en el padrón: se enviará a revisión</span>` : "");
  }

  function montar() {
    const input = document.getElementById("studentName");
    if (!input) return;
    // Los datos de ejemplo de la plantilla estorban al buscar
    if (input.value === "Ángel Gabriel Mendoza Ríos") input.value = "";
    const tutor = document.getElementById("tutorName");
    if (tutor && tutor.value === "Sra. Martha Elena Ríos Sánchez") tutor.value = "";
    input.placeholder = "Escribe para buscar al alumno…";
    input.setAttribute("autocomplete", "off");
    const cont = input.parentElement;
    cont.style.position = "relative";
    caja = document.createElement("div");
    caja.setAttribute("role", "listbox");
    caja.className = "no-print";
    caja.style.cssText = "display:none;position:absolute;left:0;right:0;top:100%;z-index:40;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 24px rgba(29,53,87,.18);margin-top:2px;max-height:300px;overflow:auto";
    cont.appendChild(caja);
    const estado = document.createElement("div");
    estado.id = "sejPadronEstado"; estado.className = "no-print";
    estado.style.cssText = "font-size:.7rem;margin-top:.2rem;min-height:1em";
    cont.parentElement.appendChild(estado);

    input.addEventListener("input", () => {
      if (elegido && input.value !== elegido.nombre) { codigo = ""; elegido = null; }
      activo = -1; pintarLista(input.value); pintarEstado();
    });
    input.addEventListener("focus", () => pintarLista(input.value));
    input.addEventListener("blur", () => setTimeout(cerrarLista, 150));
    input.addEventListener("keydown", e => {
      if (!caja || caja.style.display === "none" || !resultados.length) return;
      if (e.key === "ArrowDown") { activo = Math.min(resultados.length - 1, activo + 1); pintarLista(input.value); e.preventDefault(); }
      else if (e.key === "ArrowUp") { activo = Math.max(0, activo - 1); pintarLista(input.value); e.preventDefault(); }
      else if (e.key === "Enter" && activo >= 0) { elegir(resultados[activo]); e.preventDefault(); }
      else if (e.key === "Escape") cerrarLista();
    });
    actualizar().then(cambio => { if (cambio) pintarEstado(); });
    window.addEventListener("online", () => actualizar());
  }

  // El código solo vale si el nombre sigue siendo el del alumno elegido
  function codigoActual() {
    const n = document.getElementById("studentName");
    return (elegido && n && n.value === elegido.nombre) ? codigo : "";
  }
  function limpiar() {
    if (!codigoActual()) { codigo = ""; elegido = null; }
    pintarEstado();
  }

  return { montar, actualizar, codigoActual, limpiar, buscar, alumnos };
})();
