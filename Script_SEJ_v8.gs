// ============================================================
//  SCRIPT SEJ v8 — REPORTES CON USUARIOS Y PERMISOS
//  Weird Games Mx
//
//  Etapa 1 (motor): usuarios creados por Dirección, inicio de sesión,
//  permisos por rol, folios sin choques y trabajo sin conexión.
//
//  Reglas de privacidad:
//   • Prefectura y Gabinete solo pueden enviar sus reportes y notas,
//     y solo reciben las notas de SUS propios reportes.
//   • Solo Dirección puede leer todo y administrar usuarios.
//   • Las contraseñas se guardan cifradas (nunca en texto).
//
//  INSTALACIÓN DE PRUEBA: pegar en el Apps Script de una COPIA del Sheet,
//  poner abajo el ID de esa copia, ejecutar configurarInicial() una vez
//  y publicar como Aplicación web (Ejecutar como: Yo / Acceso: Cualquier usuario).
// ============================================================

// Opcional: si el script se abrió desde el Sheet (Extensiones → Apps Script),
// puede quedarse así y usará ese Sheet automáticamente.
const SHEET_ID = "PEGA_AQUI_EL_ID_DEL_SHEET";
const VERSION = "8.3";

// true  = las terminales v6/v7 siguen funcionando con este script (transición).
// false = solo la app nueva con usuarios. Es lo más privado.
const PERMITIR_TERMINALES_V7 = false;

// true = un prefecto que borró su aparato puede volver a descargar SUS reportes.
// false = no los recupera; quedan solo en el Sheet (lo que pediste).
const PERMITIR_RECUPERAR_PROPIOS = false;

const DIAS_SESION = 30;          // días que la app funciona sin volver a iniciar sesión
const ITERACIONES_HASH = 300;    // cifrado de contraseñas
const INTENTOS_MAX = 5;          // intentos fallidos antes de bloquear
const MINUTOS_BLOQUEO = 15;

const HOJA = {
  REPORTES: "Reportes",
  DIRECCION: "ReportesDireccion",
  SEGUIMIENTOS: "Seguimientos",
  USUARIOS: "Usuarios",
  SESIONES: "Sesiones",
  BITACORA: "Bitacora",
  FOTOS: "Fotos"
};

const FOTOS_POR_REPORTE = 3;
const FOTO_MAX_BYTES = 600 * 1024;   // las fotos llegan comprimidas (100-300 KB)

const CAMPOS_FORMATO = [
  "format", "schoolName", "schoolCct", "schoolTurn", "studentName", "studentGrade",
  "studentGroup", "eventDate", "tutorName", "eventDescription", "actionApplied",
  "eventTime", "witnesses", "interventionPlan", "appointmentDate", "appointmentTime",
  "missingTasks", "tutorAgreement", "timestamp", "customTitle", "customSubtitle", "customContent"
];

const COLS = {};
COLS[HOJA.REPORTES] = ["id", "folio", "prefecto"].concat(CAMPOS_FORMATO,
  ["area", "usuario", "folioProvisional", "capturado"]);
COLS[HOJA.DIRECCION] = ["id", "folio", "directivo"].concat(CAMPOS_FORMATO,
  ["usuario", "folioProvisional", "capturado"]);
COLS[HOJA.SEGUIMIENTOS] = ["id", "folio", "autor", "rol", "fecha", "nota", "origen", "timestamp", "usuario"];
COLS[HOJA.USUARIOS] = ["usuario", "nombre", "iniciales", "rol", "activo", "debeCambiar",
  "salt", "hash", "creado", "creadoPor", "bajaEn", "ultimoAcceso"];
COLS[HOJA.SESIONES] = ["tokenHash", "usuario", "creada", "expira", "revocada", "dispositivo"];
COLS[HOJA.BITACORA] = ["fecha", "usuario", "accion", "detalle"];
COLS[HOJA.FOTOS] = ["id", "reporteId", "folio", "usuario", "driveId", "bytes", "ancho", "alto", "timestamp"];

const ROLES = {
  prefectura: { etiqueta: "Prefectura", hoja: HOJA.REPORTES, campoNombre: "prefecto", sep: "-" },
  gabinete: { etiqueta: "Gabinete psicopedagógico", hoja: HOJA.REPORTES, campoNombre: "prefecto", sep: "-" },
  direccion: { etiqueta: "Dirección", hoja: HOJA.DIRECCION, campoNombre: "directivo", sep: "X" }
};

const CAMPOS_FECHA = ["eventDate", "appointmentDate"];
const CAMPOS_HORA = ["eventTime", "appointmentTime"];

// ============================================================
//  PRIMERA CONFIGURACIÓN — ejecutar UNA vez desde el editor
//  (elige "configurarInicial" en la lista de funciones y pulsa Ejecutar).
//  La contraseña temporal aparece en el Registro de ejecución.
// ============================================================
function configurarInicial() {
  const PRIMER_DIRECTIVO = {
    usuario: "direccion",          // con este usuario se entra
    nombre: "Nombre del Director(a)",
    iniciales: "DIR"               // 2 a 4 letras, únicas
  };

  const ss = abrir();
  Object.keys(COLS).forEach(h => obtenerHoja(ss, h));

  const hayDireccion = leerTabla(HOJA.USUARIOS).objs.some(u => u.rol === "direccion");
  if (hayDireccion) {
    Logger.log("Ya existe un usuario de Dirección. No se creó otro.");
    return;
  }
  const temporal = crearUsuarioInterno(PRIMER_DIRECTIVO.usuario, PRIMER_DIRECTIVO.nombre,
    PRIMER_DIRECTIVO.iniciales, "direccion", "configuracion");
  Logger.log("Usuario creado: " + PRIMER_DIRECTIVO.usuario);
  Logger.log("Contraseña temporal: " + temporal + "  (se pedirá cambiarla al entrar)");
}

// ============================================================
//  ENTRADAS
// ============================================================

// App nueva: todas las peticiones llegan por POST con un JSON.
function doPost(e) {
  let p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return respuesta({ ok: false, codigo: "PETICION_INVALIDA", error: "Petición inválida." });
  }
  return respuesta(enrutar(p));
}

// Terminales v6/v7 (GET). Solo funcionan si PERMITIR_TERMINALES_V7 = true.
function doGet(e) {
  const prm = (e && e.parameter) || {};
  if (prm.accion === "ping") return respuesta({ ok: true, version: VERSION });
  // Respaldo de la app nueva: si el navegador convierte el POST en GET
  // (pasa con algunas sesiones de Google abiertas), la petición llega aquí en "p".
  if (prm.p) {
    let p;
    try { p = JSON.parse(prm.p); } catch (err) {
      return respuesta({ ok: false, codigo: "PETICION_INVALIDA", error: "Petición inválida." });
    }
    return respuesta(enrutar(p));
  }
  if (!PERMITIR_TERMINALES_V7) {
    return respuesta({ ok: false, codigo: "V7_DESACTIVADA",
      error: "Este sistema ahora requiere la app con usuario y contraseña." });
  }
  return respuesta(legacy(prm));
}

const PUBLICAS = { ping: () => ({ ok: true, version: VERSION }), login: accLogin };
const CON_SESION = {
  sesion: accSesion, logout: accLogout, cambiarPassword: accCambiarPassword,
  contadores: accContadores, guardarReporte: accGuardarReporte,
  guardarSeguimiento: accGuardarSeguimiento, misReportes: accMisReportes,
  misSeguimientos: accMisSeguimientos, subirFoto: accSubirFoto, subirFotoParte: accSubirFotoParte,
  verFoto: accVerFoto
};
const SOLO_DIRECCION = {
  leerTodo: accLeerTodo, listarUsuarios: accListarUsuarios, crearUsuario: accCrearUsuario,
  actualizarUsuario: accActualizarUsuario, restablecerPassword: accRestablecerPassword,
  historialSinAsignar: accHistorialSinAsignar, asignarHistorial: accAsignarHistorial,
  leerBitacora: accLeerBitacora
};
// Lo único que puede hacer un usuario dado de baja: entregar lo que capturó antes.
const TRAS_BAJA = ["guardarReporte", "guardarSeguimiento", "subirFoto", "subirFotoParte", "logout", "sesion"];
// Lo único permitido mientras no cambie su contraseña temporal.
const CON_TEMPORAL = ["sesion", "cambiarPassword", "logout"];

function enrutar(p) {
  try {
    const accion = String(p.accion || "");
    if (PUBLICAS[accion]) return PUBLICAS[accion](p);

    const fn = CON_SESION[accion] || SOLO_DIRECCION[accion];
    if (!fn) return { ok: false, codigo: "ACCION_DESCONOCIDA", error: "Acción no reconocida." };

    const yo = validarSesion(p.token);
    if (!yo) return { ok: false, codigo: "SESION_INVALIDA", error: "Tu sesión terminó. Inicia sesión de nuevo." };

    if (!yo.activo && TRAS_BAJA.indexOf(accion) < 0) {
      return { ok: false, codigo: "USUARIO_BAJA", error: "Tu usuario fue dado de baja." };
    }
    if (yo.debeCambiar && CON_TEMPORAL.indexOf(accion) < 0) {
      return { ok: false, codigo: "DEBE_CAMBIAR", error: "Primero cambia tu contraseña temporal." };
    }
    if (SOLO_DIRECCION[accion] && yo.rol !== "direccion") {
      return { ok: false, codigo: "SIN_PERMISO", error: "No tienes permiso para esto." };
    }
    return fn(p, yo);
  } catch (err) {
    return { ok: false, codigo: "ERROR", error: String(err && err.message || err) };
  }
}

// ============================================================
//  SESIÓN
// ============================================================
function accLogin(p) {
  const usuario = normUsuario(p.usuario);
  const password = String(p.password || "");
  if (!usuario || !password) return { ok: false, codigo: "DATOS", error: "Escribe usuario y contraseña." };

  const cache = CacheService.getScriptCache();
  const claveFallos = "fallos_" + usuario;
  const fallos = Number(cache.get(claveFallos) || 0);
  if (fallos >= INTENTOS_MAX) {
    return { ok: false, codigo: "BLOQUEADO",
      error: "Demasiados intentos. Espera " + MINUTOS_BLOQUEO + " minutos o pide a Dirección restablecer tu contraseña." };
  }

  const t = leerTabla(HOJA.USUARIOS);
  const idx = t.objs.findIndex(u => u.usuario === usuario);
  const u = idx >= 0 ? t.objs[idx] : null;
  if (!u || hashPassword(password, u.salt) !== u.hash) {
    cache.put(claveFallos, String(fallos + 1), MINUTOS_BLOQUEO * 60);
    return { ok: false, codigo: "CREDENCIALES", error: "Usuario o contraseña incorrectos." };
  }
  if (!esVerdadero(u.activo)) {
    return { ok: false, codigo: "USUARIO_BAJA", error: "Tu usuario fue dado de baja." };
  }
  cache.remove(claveFallos);

  const token = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
  const ahora = new Date();
  const expira = new Date(ahora.getTime() + DIAS_SESION * 86400000);
  conBloqueo(() => {
    agregarFila(HOJA.SESIONES, {
      tokenHash: "t" + sha(token), usuario: usuario, creada: ahora.toISOString(),
      expira: expira.toISOString(), revocada: "", dispositivo: String(p.dispositivo || "").slice(0, 120)
    });
    ponerCelda(t, idx, "ultimoAcceso", ahora.toISOString());
  });
  bitacora(usuario, "login", "");

  const yo = usuarioPublico(u);
  return { ok: true, token: token, expira: expira.toISOString(), usuario: yo,
    contadores: yo.debeCambiar ? {} : calcularContadores(yo) };
}

function accSesion(p, yo) {
  return { ok: true, usuario: yo, contadores: (yo.activo && !yo.debeCambiar) ? calcularContadores(yo) : {} };
}

function accLogout(p) {
  conBloqueo(() => revocarSesiones(s => s.tokenHash === "t" + sha(String(p.token || ""))));
  return { ok: true };
}

function accCambiarPassword(p, yo) {
  const actual = String(p.actual || "");
  const nueva = String(p.nueva || "");
  if (nueva.length < 6) return { ok: false, codigo: "DATOS", error: "La contraseña nueva debe tener al menos 6 caracteres." };
  if (nueva === actual) return { ok: false, codigo: "DATOS", error: "La contraseña nueva debe ser distinta." };

  return conBloqueo(() => {
    const t = leerTabla(HOJA.USUARIOS);
    const idx = t.objs.findIndex(u => u.usuario === yo.usuario);
    if (hashPassword(actual, t.objs[idx].salt) !== t.objs[idx].hash) {
      return { ok: false, codigo: "CREDENCIALES", error: "La contraseña actual no es correcta." };
    }
    const salt = nuevoSalt();
    ponerCelda(t, idx, "salt", salt);
    ponerCelda(t, idx, "hash", hashPassword(nueva, salt));
    ponerCelda(t, idx, "debeCambiar", false);
    // Cierra las demás sesiones; la actual sigue abierta.
    const actualHash = "t" + sha(String(p.token || ""));
    revocarSesiones(s => s.usuario === yo.usuario && s.tokenHash !== actualHash);
    bitacora(yo.usuario, "cambiarPassword", "");
    const u = Object.assign({}, yo, { debeCambiar: false });
    return { ok: true, usuario: u, contadores: calcularContadores(u) };
  });
}

// Devuelve el usuario de la sesión o null.
function validarSesion(token) {
  token = String(token || "");
  if (token.length < 40) return null;
  const h = "t" + sha(token);
  const cache = CacheService.getScriptCache();
  let usuario = cache.get("ses_" + h);

  if (!usuario) {
    const s = leerTabla(HOJA.SESIONES).objs.find(x => x.tokenHash === h);
    if (!s || esVerdadero(s.revocada) || new Date(s.expira) < new Date()) return null;
    usuario = s.usuario;
    cache.put("ses_" + h, usuario, 21600);
  }
  const u = leerTabla(HOJA.USUARIOS).objs.find(x => x.usuario === usuario);
  return u ? usuarioPublico(u) : null;
}

function revocarSesiones(filtro) {
  const t = leerTabla(HOJA.SESIONES);
  const cache = CacheService.getScriptCache();
  t.objs.forEach((s, i) => {
    if (!esVerdadero(s.revocada) && filtro(s)) {
      ponerCelda(t, i, "revocada", true);
      cache.remove("ses_" + s.tokenHash);
    }
  });
}

// ============================================================
//  FOLIOS
//  Prefectura/Gabinete: INICIALES + grado + grupo + "-" + 5 dígitos (MY1C-00004)
//  Dirección:           INICIALES + grado + grupo + "X" + 5 dígitos (DIR1CX00004)
// ============================================================
function regexFolio(iniciales, rol) {
  const sep = ROLES[rol].sep;
  return new RegExp("^(" + iniciales + "\\d+[A-ZÑ]+?)" + (sep === "-" ? "-" : "X") + "(\\d{5})$");
}

// Último número usado por este usuario en cada grado/grupo. Solo números, nada de datos.
function calcularContadores(yo) {
  const re = regexFolio(yo.iniciales, yo.rol);
  const out = {};
  leerTabla(ROLES[yo.rol].hoja).objs.forEach(r => {
    const m = String(r.folio || "").match(re);
    if (m) out[m[1]] = Math.max(out[m[1]] || 0, Number(m[2]));
  });
  return out;
}

function armarFolio(prefijo, rol, n) {
  return prefijo + ROLES[rol].sep + ("00000" + n).slice(-5);
}

function accContadores(p, yo) {
  return { ok: true, contadores: calcularContadores(yo) };
}

// ============================================================
//  REPORTES
// ============================================================
function accGuardarReporte(p, yo) {
  const r = p.reporte || {};
  const id = String(r.id || "");
  const folio = String(r.folio || "").toUpperCase();
  if (!id || !folio) return { ok: false, codigo: "DATOS", error: "El reporte no tiene id o folio." };

  const m = folio.match(regexFolio(yo.iniciales, yo.rol));
  if (!m) return { ok: false, codigo: "SIN_PERMISO", error: "El folio " + folio + " no corresponde a tus iniciales." };

  const capturado = String(r.capturado || fechaDeId(id) || "");
  if (!yo.activo && !(capturado && yo.bajaEn && new Date(capturado) <= new Date(yo.bajaEn))) {
    return { ok: false, codigo: "USUARIO_BAJA", error: "Tu usuario fue dado de baja." };
  }

  const rol = ROLES[yo.rol];
  return conBloqueo(() => {
    const t = leerTabla(rol.hoja);

    // ¿Ya se había recibido? (reintento, aunque haya cambiado de folio)
    const previo = t.objs.find(x => String(x.id) === id && x.usuario === yo.usuario);
    if (previo) {
      return { ok: true, duplicado: true, folio: String(previo.folio),
        folioProvisional: String(previo.folioProvisional || "") };
    }

    // ¿El folio ya lo usa otro reporte? Se renumera al siguiente libre.
    let folioFinal = folio, folioProvisional = "";
    const ocupados = {};
    t.objs.forEach(x => { ocupados[String(x.folio)] = true; });
    if (ocupados[folio]) {
      let n = Number(m[2]);
      do { n++; folioFinal = armarFolio(m[1], yo.rol, n); } while (ocupados[folioFinal]);
      folioProvisional = folio;
    }

    const fila = {};
    t.headers.forEach(col => { fila[col] = textoSeguro(r[col]); });
    fila.id = id;
    fila.folio = folioFinal;
    fila[rol.campoNombre] = yo.nombre;
    if (rol.hoja === HOJA.REPORTES) fila.area = rol.etiqueta;
    fila.usuario = yo.usuario;
    fila.folioProvisional = folioProvisional;
    fila.capturado = capturado;
    if (!r.timestamp) fila.timestamp = new Date().toISOString();
    agregarFila(rol.hoja, fila, t.headers);

    return { ok: true, folio: folioFinal, folioProvisional: folioProvisional, renumerado: !!folioProvisional };
  });
}

function accMisReportes(p, yo) {
  if (!PERMITIR_RECUPERAR_PROPIOS && yo.rol !== "direccion") {
    return { ok: true, reportes: [], deshabilitado: true };
  }
  const t = leerTabla(ROLES[yo.rol].hoja, true);
  return { ok: true, reportes: t.objs.filter(x => x.usuario === yo.usuario) };
}

// Folios que pertenecen al usuario (sus propios reportes).
function misFolios(yo) {
  const mapa = {}; // folio o folioProvisional → folio definitivo
  leerTabla(ROLES[yo.rol].hoja).objs.forEach(x => {
    if (x.usuario !== yo.usuario) return;
    mapa[String(x.folio)] = String(x.folio);
    if (x.folioProvisional) mapa[String(x.folioProvisional)] = String(x.folio);
  });
  return mapa;
}

// ============================================================
//  NOTAS DE SEGUIMIENTO
// ============================================================
function accGuardarSeguimiento(p, yo) {
  const n = p.nota || {};
  const id = String(n.id || "");
  let folio = String(n.folio || "").toUpperCase();
  const texto = String(n.nota || "").trim();
  if (!id || !folio || !texto) return { ok: false, codigo: "DATOS", error: "Faltan datos de la nota." };

  if (!yo.activo) {
    const cap = String(n.fecha || fechaDeId(id) || "");
    if (!(cap && yo.bajaEn && new Date(cap) <= new Date(yo.bajaEn))) {
      return { ok: false, codigo: "USUARIO_BAJA", error: "Tu usuario fue dado de baja." };
    }
  }

  // Prefectura y Gabinete solo anotan sus reportes; Dirección, cualquiera que exista.
  if (yo.rol === "direccion") {
    const existe = [HOJA.REPORTES, HOJA.DIRECCION].some(h =>
      leerTabla(h).objs.some(x => String(x.folio) === folio));
    if (!existe) return { ok: false, codigo: "SIN_REPORTE", error: "El folio " + folio + " aún no está en la nube." };
  } else {
    const mios = misFolios(yo);
    if (!mios[folio]) return { ok: false, codigo: "SIN_REPORTE", error: "El reporte " + folio + " aún no está en la nube o no es tuyo." };
    folio = mios[folio]; // si el reporte se renumeró, la nota sigue al folio definitivo
  }

  return conBloqueo(() => {
    const t = leerTabla(HOJA.SEGUIMIENTOS);
    if (t.objs.some(x => String(x.id) === id)) return { ok: true, duplicado: true, folio: folio };
    agregarFila(HOJA.SEGUIMIENTOS, {
      id: id, folio: folio, autor: yo.nombre, rol: ROLES[yo.rol].etiqueta,
      fecha: textoSeguro(n.fecha || new Date().toISOString()), nota: textoSeguro(texto),
      origen: yo.rol, timestamp: new Date().toISOString(), usuario: yo.usuario
    }, t.headers);
    return { ok: true, folio: folio };
  });
}

function accMisSeguimientos(p, yo) {
  if (yo.rol === "direccion") {
    return { ok: true, seguimientos: leerTabla(HOJA.SEGUIMIENTOS, true).objs };
  }
  const mios = misFolios(yo);
  const notas = leerTabla(HOJA.SEGUIMIENTOS, true).objs.filter(x => mios[String(x.folio)]);
  return { ok: true, seguimientos: notas };
}

// ============================================================
//  DIRECCIÓN
// ============================================================
function accLeerTodo(p, yo) {
  bitacora(yo.usuario, "leerTodo", "");
  return {
    ok: true,
    reportes: leerTabla(HOJA.REPORTES, true).objs,
    reportesDireccion: leerTabla(HOJA.DIRECCION, true).objs,
    seguimientos: leerTabla(HOJA.SEGUIMIENTOS, true).objs,
    fotos: leerTabla(HOJA.FOTOS).objs.map(f => ({ id: String(f.id), reporteId: String(f.reporteId), folio: String(f.folio),
      usuario: f.usuario, ancho: f.ancho, alto: f.alto }))
  };
}

// ============================================================
//  FOTOS DE EVIDENCIA
//  Se guardan en una carpeta PRIVADA de Drive (no se comparte ni tiene enlaces).
//  En el Sheet solo queda la referencia. Las ve quien capturó el reporte y Dirección.
// ============================================================

// Ejecutar UNA vez desde el editor para autorizar Drive y crear la carpeta.
function configurarFotos() {
  const carpeta = carpetaFotos();
  obtenerHoja(abrir(), HOJA.FOTOS);
  Logger.log("Carpeta de evidencias lista (privada): " + carpeta.getName() + " — " + carpeta.getUrl());
}

function carpetaFotos() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("CARPETA_FOTOS");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  const carpeta = DriveApp.createFolder("Reportes SEJ - Evidencias (privado)");
  try { carpeta.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE); } catch (e) { }
  props.setProperty("CARPETA_FOTOS", carpeta.getId());
  return carpeta;
}

// Reporte del usuario por su id (el folio puede haber cambiado al renumerarse)
function reporteDe(yo, reporteId) {
  return leerTabla(ROLES[yo.rol].hoja).objs.find(r => String(r.id) === String(reporteId) && r.usuario === yo.usuario) || null;
}

function guardarFotoInterno(yo, f, base64) {
  const id = String(f.id || "");
  if (!/^F[\w-]{6,60}$/.test(id)) return { ok: false, codigo: "DATOS", error: "Identificador de foto inválido." };
  const rep = reporteDe(yo, f.reporteId);
  if (!rep) return { ok: false, codigo: "SIN_REPORTE", error: "El reporte de esta foto aún no está en la nube." };

  let bytes;
  try { bytes = Utilities.base64Decode(String(base64 || "")); } catch (e) { return { ok: false, codigo: "DATOS", error: "La foto llegó dañada." }; }
  if (!bytes.length || bytes.length > FOTO_MAX_BYTES) return { ok: false, codigo: "DATOS", error: "La foto es demasiado grande." };
  if (!((bytes[0] & 255) === 0xFF && (bytes[1] & 255) === 0xD8)) return { ok: false, codigo: "DATOS", error: "Solo se aceptan fotos JPG." };

  return conBloqueo(() => {
    const t = leerTabla(HOJA.FOTOS);
    const previa = t.objs.find(x => String(x.id) === id);
    if (previa) return { ok: true, duplicado: true, id: id, folio: String(previa.folio) };
    const delReporte = t.objs.filter(x => String(x.reporteId) === String(rep.id) && x.usuario === yo.usuario).length;
    if (delReporte >= FOTOS_POR_REPORTE) return { ok: false, codigo: "LIMITE", error: "Este reporte ya tiene " + FOTOS_POR_REPORTE + " fotos." };

    const blob = Utilities.newBlob(bytes, "image/jpeg", rep.folio + "_" + id + ".jpg");
    const archivo = carpetaFotos().createFile(blob);
    agregarFila(HOJA.FOTOS, {
      id: id, reporteId: String(rep.id), folio: String(rep.folio), usuario: yo.usuario, driveId: archivo.getId(),
      bytes: bytes.length, ancho: Number(f.ancho) || "", alto: Number(f.alto) || "", timestamp: new Date().toISOString()
    }, t.headers);
    return { ok: true, id: id, folio: String(rep.folio) };
  });
}

function accSubirFoto(p, yo) {
  const f = p.foto || {};
  return guardarFotoInterno(yo, f, f.datos);
}

// Vía lenta para aparatos donde Google desvía los envíos grandes: la foto llega en partes.
function accSubirFotoParte(p, yo) {
  const f = p.foto || {};
  const n = Number(p.n), total = Number(p.total);
  if (!(total > 0 && total <= 800 && n >= 0 && n < total)) return { ok: false, codigo: "DATOS", error: "Parte inválida." };
  const parte = String(p.parte || "");
  if (parte.length > 4000) return { ok: false, codigo: "DATOS", error: "Parte demasiado grande." };
  const cache = CacheService.getScriptCache();
  const base = "fp_" + yo.usuario + "_" + String(f.id) + "_";
  cache.put(base + n, parte, 3600);
  const claves = [];
  for (let i = 0; i < total; i++) claves.push(base + i);
  const partes = cache.getAll(claves);
  if (Object.keys(partes).length < total) return { ok: true, completa: false };
  const r = guardarFotoInterno(yo, f, claves.map(k => partes[k]).join(""));
  if (r.ok) cache.removeAll(claves);
  return Object.assign({ completa: true }, r);
}

function accVerFoto(p, yo) {
  const id = String(p.id || "");
  const f = leerTabla(HOJA.FOTOS).objs.find(x => String(x.id) === id);
  if (!f || (yo.rol !== "direccion" && f.usuario !== yo.usuario)) {
    return { ok: false, codigo: "SIN_PERMISO", error: "No tienes acceso a esta foto." };
  }
  const blob = DriveApp.getFileById(String(f.driveId)).getBlob();
  return { ok: true, id: id, folio: String(f.folio), datos: Utilities.base64Encode(blob.getBytes()), ancho: f.ancho, alto: f.alto };
}

function accListarUsuarios() {
  return { ok: true, usuarios: leerTabla(HOJA.USUARIOS).objs.map(usuarioPublico) };
}

function accCrearUsuario(p, yo) {
  const temporal = conBloqueo(() => crearUsuarioInterno(p.usuario, p.nombre, p.iniciales, p.rol, yo.usuario));
  return { ok: true, passwordTemporal: temporal,
    usuario: usuarioPublico(leerTabla(HOJA.USUARIOS).objs.find(u => u.usuario === normUsuario(p.usuario))) };
}

function crearUsuarioInterno(usuario, nombre, iniciales, rol, creadoPor) {
  usuario = normUsuario(usuario);
  nombre = String(nombre || "").trim();
  iniciales = normIniciales(iniciales);
  if (!/^[a-z][a-z0-9._-]{2,29}$/.test(usuario) || usuario === "true" || usuario === "false") {
    throw new Error("Usuario inválido: de 3 a 30 caracteres, empieza con letra; solo minúsculas, números, punto o guion.");
  }
  if (!nombre) throw new Error("Escribe el nombre completo.");
  if (!/^[A-ZÑ]{2,4}$/.test(iniciales)) throw new Error("Las iniciales deben ser de 2 a 4 letras.");
  if (!ROLES[rol]) throw new Error("Rol inválido.");

  const t = leerTabla(HOJA.USUARIOS);
  if (t.objs.some(u => u.usuario === usuario)) throw new Error("El usuario " + usuario + " ya existe.");
  const otro = t.objs.find(u => normIniciales(u.iniciales) === iniciales);
  if (otro) throw new Error("Las iniciales " + iniciales + " ya son de " + otro.nombre + ". Usa otras (por ejemplo, agrega una letra).");

  const temporal = passwordTemporal();
  const salt = nuevoSalt();
  agregarFila(HOJA.USUARIOS, {
    usuario: usuario, nombre: textoSeguro(nombre), iniciales: iniciales, rol: rol,
    activo: true, debeCambiar: true, salt: salt, hash: hashPassword(temporal, salt),
    creado: new Date().toISOString(), creadoPor: creadoPor, bajaEn: "", ultimoAcceso: ""
  }, t.headers);
  bitacora(creadoPor, "crearUsuario", usuario + " (" + rol + ", " + iniciales + ")");
  return temporal;
}

// Cambia nombre, rol, iniciales o activo (baja / reactivar).
function accActualizarUsuario(p, yo) {
  return conBloqueo(() => {
    const t = leerTabla(HOJA.USUARIOS);
    const usuario = normUsuario(p.usuario);
    const idx = t.objs.findIndex(u => u.usuario === usuario);
    if (idx < 0) return { ok: false, codigo: "DATOS", error: "No existe el usuario." };
    const u = t.objs[idx];
    const cambios = [];

    const directivosActivos = t.objs.filter(x => x.rol === "direccion" && esVerdadero(x.activo));
    const quitaDireccion = u.rol === "direccion" && esVerdadero(u.activo) &&
      ((p.activo !== undefined && !esVerdadero(p.activo)) || (p.rol && p.rol !== "direccion"));
    if (quitaDireccion && directivosActivos.length <= 1) {
      return { ok: false, codigo: "DATOS", error: "Debe quedar al menos un usuario de Dirección activo." };
    }

    if (p.nombre !== undefined && String(p.nombre).trim()) {
      ponerCelda(t, idx, "nombre", textoSeguro(String(p.nombre).trim())); cambios.push("nombre");
    }
    if (p.rol !== undefined && p.rol !== u.rol) {
      if (!ROLES[p.rol]) return { ok: false, codigo: "DATOS", error: "Rol inválido." };
      ponerCelda(t, idx, "rol", p.rol); cambios.push("rol=" + p.rol);
    }
    if (p.iniciales !== undefined && normIniciales(p.iniciales) !== normIniciales(u.iniciales)) {
      const ini = normIniciales(p.iniciales);
      if (!/^[A-ZÑ]{2,4}$/.test(ini)) return { ok: false, codigo: "DATOS", error: "Iniciales inválidas." };
      const otro = t.objs.find(x => x.usuario !== usuario && normIniciales(x.iniciales) === ini);
      if (otro) return { ok: false, codigo: "DATOS", error: "Las iniciales " + ini + " ya son de " + otro.nombre + "." };
      ponerCelda(t, idx, "iniciales", ini); cambios.push("iniciales=" + ini);
    }
    if (p.activo !== undefined && esVerdadero(p.activo) !== esVerdadero(u.activo)) {
      const activo = esVerdadero(p.activo);
      ponerCelda(t, idx, "activo", activo);
      ponerCelda(t, idx, "bajaEn", activo ? "" : new Date().toISOString());
      cambios.push(activo ? "reactivado" : "baja");
    }
    bitacora(yo.usuario, "actualizarUsuario", usuario + ": " + cambios.join(", "));
    return { ok: true, usuario: usuarioPublico(leerTabla(HOJA.USUARIOS).objs[idx]) };
  });
}

function accRestablecerPassword(p, yo) {
  return conBloqueo(() => {
    const t = leerTabla(HOJA.USUARIOS);
    const usuario = normUsuario(p.usuario);
    const idx = t.objs.findIndex(u => u.usuario === usuario);
    if (idx < 0) return { ok: false, codigo: "DATOS", error: "No existe el usuario." };
    const temporal = passwordTemporal();
    const salt = nuevoSalt();
    ponerCelda(t, idx, "salt", salt);
    ponerCelda(t, idx, "hash", hashPassword(temporal, salt));
    ponerCelda(t, idx, "debeCambiar", true);
    revocarSesiones(s => s.usuario === usuario);
    CacheService.getScriptCache().remove("fallos_" + usuario);
    bitacora(yo.usuario, "restablecerPassword", usuario);
    return { ok: true, passwordTemporal: temporal };
  });
}

// Reportes anteriores (v6/v7) que aún no tienen usuario, agrupados por nombre.
function accHistorialSinAsignar() {
  const usuarios = leerTabla(HOJA.USUARIOS).objs;
  const grupos = {};
  [[HOJA.REPORTES, "prefecto"], [HOJA.DIRECCION, "directivo"]].forEach(([hoja, campo]) => {
    leerTabla(hoja).objs.forEach(r => {
      if (r.usuario) return;
      const nombre = String(r[campo] || "").trim() || "(sin nombre)";
      const k = hoja + "|" + normTexto(nombre);
      if (!grupos[k]) {
        const sug = usuarios.find(u => normTexto(u.nombre) === normTexto(nombre));
        grupos[k] = { hoja: hoja, nombre: nombre, reportes: 0, sugerido: sug ? sug.usuario : "" };
      }
      grupos[k].reportes++;
    });
  });
  return { ok: true, pendientes: Object.keys(grupos).map(k => grupos[k]) };
}

// Asigna a un usuario todos los reportes sin dueño que tengan ese nombre.
function accAsignarHistorial(p, yo) {
  const hoja = p.hoja === HOJA.DIRECCION ? HOJA.DIRECCION : HOJA.REPORTES;
  const campo = hoja === HOJA.DIRECCION ? "directivo" : "prefecto";
  const usuario = normUsuario(p.usuario);
  const objetivo = normTexto(p.nombre);
  if (!leerTabla(HOJA.USUARIOS).objs.some(u => u.usuario === usuario)) {
    return { ok: false, codigo: "DATOS", error: "No existe el usuario." };
  }
  return conBloqueo(() => {
    const t = leerTabla(hoja);
    let n = 0;
    t.objs.forEach((r, i) => {
      const nombre = String(r[campo] || "").trim() || "(sin nombre)";
      if (!r.usuario && normTexto(nombre) === objetivo) { ponerCelda(t, i, "usuario", usuario); n++; }
    });
    bitacora(yo.usuario, "asignarHistorial", n + " reportes de '" + p.nombre + "' → " + usuario);
    return { ok: true, asignados: n };
  });
}

function accLeerBitacora() {
  const objs = leerTabla(HOJA.BITACORA).objs;
  return { ok: true, eventos: objs.slice(-300).reverse() };
}

// ============================================================
//  COMPATIBILIDAD CON TERMINALES v6/v7 (solo si PERMITIR_TERMINALES_V7)
// ============================================================
function legacy(prm) {
  const accion = prm.accion || "";
  if (accion === "seguimiento") return legacySeguimiento(prm);
  if (accion === "leerSeguimientos") {
    return { ok: true, seguimientos: leerTabla(HOJA.SEGUIMIENTOS, true).objs
      .map(n => Object.assign(n, { id: String(n.id), folio: String(n.folio) }))
      .filter(n => n.id && n.folio) };
  }
  const origen = prm.origen || "prefectura";
  if (origen === "docentes") return { ok: false, error: "El módulo de docentes está descontinuado." };
  const hoja = origen === "direccion" ? HOJA.DIRECCION : HOJA.REPORTES;

  if (accion === "leer") {
    const reportes = leerTabla(hoja, true).objs;
    reportes.forEach(o => {
      if (o.id !== "" && o.id !== null && o.id !== undefined) o.id = Number(o.id);
      o.folio = String(o.folio || "");
    });
    return { ok: true, reportes: reportes };
  }
  if (accion === "guardar") {
    return conBloqueo(() => {
      const t = leerTabla(hoja);
      const folio = String(prm.folio || ""), id = String(prm.id || "");
      const previo = folio ? t.objs.find(x => String(x.folio) === folio) : null;
      if (previo) {
        if (!String(previo.id) || !id || String(previo.id) === id) return { ok: true, mensaje: "Duplicado ignorado", folio: folio };
        return { ok: false, conflicto: true, folio: folio, error: "El folio " + folio + " ya existe en la nube con otro reporte." };
      }
      const fila = {};
      t.headers.forEach(col => {
        if (col === "usuario" || col === "folioProvisional" || col === "capturado") return;
        fila[col] = col === "timestamp" ? new Date().toISOString() : textoSeguro(prm[col]);
      });
      agregarFila(hoja, fila, t.headers);
      return { ok: true, mensaje: "Reporte guardado", folio: folio };
    });
  }
  return { ok: false, error: "Acción no reconocida." };
}

function legacySeguimiento(prm) {
  if (!prm.id || !prm.folio || !prm.nota) return { ok: false, error: "Faltan datos de la nota (id, folio o nota)." };
  return conBloqueo(() => {
    const t = leerTabla(HOJA.SEGUIMIENTOS);
    if (t.objs.some(x => String(x.id) === String(prm.id))) return { ok: true, mensaje: "Nota ya registrada", id: prm.id };
    const fila = {};
    ["id", "folio", "autor", "rol", "fecha", "nota", "origen"].forEach(c => { fila[c] = textoSeguro(prm[c]); });
    fila.timestamp = new Date().toISOString();
    agregarFila(HOJA.SEGUIMIENTOS, fila, t.headers);
    return { ok: true, mensaje: "Nota guardada", id: prm.id };
  });
}

// ============================================================
//  HOJAS
// ============================================================
let _ss = null;
function abrir() {
  if (_ss) return _ss;
  // Si no se puso un ID, usa el Sheet al que pertenece este script
  // (Extensiones → Apps Script desde el propio Sheet).
  const idValido = SHEET_ID && SHEET_ID.indexOf("PEGA_AQUI") < 0;
  _ss = idValido ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!_ss) throw new Error("No se encontró el Sheet. Abre el script desde el Sheet (Extensiones → Apps Script) o escribe su ID en SHEET_ID.");
  return _ss;
}

// Crea la hoja si no existe; si existe y le faltan columnas, las agrega al final.
const _hojas = {};
function obtenerHoja(ss, nombre) {
  if (_hojas[nombre]) return _hojas[nombre];
  const cols = COLS[nombre];
  let sheet = ss.getSheetByName(nombre);
  const cache = CacheService.getScriptCache();
  const claveOk = "hojaOk_" + VERSION + "_" + nombre;
  if (sheet && cache.get(claveOk)) return (_hojas[nombre] = sheet);
  _hojas[nombre] = sheet = obtenerHojaVerificada(ss, nombre, cols, sheet);
  cache.put(claveOk, "1", 21600);
  return sheet;
}

function obtenerHojaVerificada(ss, nombre, cols, sheet) {
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    sheet.appendRow(cols);
    sheet.getRange(1, 1, 1, cols.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return sheet;
  }
  const ultimaCol = Math.max(sheet.getLastColumn(), 1);
  const actuales = sheet.getRange(1, 1, 1, ultimaCol).getValues()[0].map(String);
  const faltantes = cols.filter(c => actuales.indexOf(c) < 0);
  if (faltantes.length) {
    const inicio = actuales.filter(Boolean).length + 1;
    sheet.getRange(1, inicio, 1, faltantes.length).setValues([faltantes]).setFontWeight("bold");
  }
  return sheet;
}

// Lee la hoja como objetos. comoTexto=true convierte fechas/horas a texto (para enviar).
let _tz = null;
function leerTabla(nombre, comoTexto) {
  const ss = abrir();
  const sheet = obtenerHoja(ss, nombre);
  let datos = null;
  const cache = CacheService.getScriptCache();
  const enCache = nombre === HOJA.USUARIOS; // la lista de usuarios casi no cambia
  if (enCache) { try { datos = JSON.parse(cache.get("tabla_usuarios") || "null"); } catch (e) { datos = null; } }
  if (!datos) {
    datos = sheet.getDataRange().getValues();
    if (enCache) { try { cache.put("tabla_usuarios", JSON.stringify(datos), 300); } catch (e) { } }
  }
  const headers = datos[0].map(String);
  const tz = _tz || (_tz = ss.getSpreadsheetTimeZone());
  const objs = [];
  for (let i = 1; i < datos.length; i++) {
    const o = {};
    headers.forEach((col, j) => {
      if (!col) return;
      let v = datos[i][j];
      if (Object.prototype.toString.call(v) === "[object Date]") {
        if (comoTexto && CAMPOS_FECHA.indexOf(col) >= 0) v = Utilities.formatDate(v, tz, "yyyy-MM-dd");
        else if (comoTexto && CAMPOS_HORA.indexOf(col) >= 0) v = Utilities.formatDate(v, tz, "HH:mm");
        else v = v.toISOString();
      }
      o[col] = v;
    });
    objs.push(o);
  }
  return { nombre: nombre, sheet: sheet, headers: headers, objs: objs };
}

function olvidarCache(nombre) {
  if (nombre === HOJA.USUARIOS) CacheService.getScriptCache().remove("tabla_usuarios");
}

function agregarFila(nombre, obj, headers) {
  const sheet = obtenerHoja(abrir(), nombre);
  headers = headers || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(headers.map(c => (obj[c] === undefined || obj[c] === null) ? "" : obj[c]));
  olvidarCache(nombre);
}

// Escribe una celda de la fila idx (0 = primera fila de datos) y actualiza el objeto en memoria.
function ponerCelda(tabla, idx, col, valor) {
  const c = tabla.headers.indexOf(col);
  if (c < 0) throw new Error("Falta la columna " + col);
  tabla.sheet.getRange(idx + 2, c + 1).setValue(valor);
  tabla.objs[idx][col] = valor;
  olvidarCache(tabla.nombre);
}

function bitacora(usuario, accion, detalle) {
  try {
    agregarFila(HOJA.BITACORA, { fecha: new Date().toISOString(), usuario: usuario, accion: accion, detalle: textoSeguro(detalle) });
  } catch (e) { }
}

// ============================================================
//  UTILIDADES
// ============================================================
function conBloqueo(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { try { lock.releaseLock(); } catch (x) { } }
}

function usuarioPublico(u) {
  return {
    usuario: u.usuario, nombre: u.nombre, iniciales: normIniciales(u.iniciales), rol: u.rol,
    area: ROLES[u.rol] ? ROLES[u.rol].etiqueta : "", activo: esVerdadero(u.activo),
    debeCambiar: esVerdadero(u.debeCambiar), bajaEn: u.bajaEn || "", ultimoAcceso: u.ultimoAcceso || "",
    creado: u.creado || ""
  };
}

function sha(texto) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("");
}

function hashPassword(password, salt) {
  let h = String(salt) + ":" + String(password);
  for (let i = 0; i < ITERACIONES_HASH; i++) h = sha(h + ":" + salt);
  return "h" + h;
}

function nuevoSalt() {
  return "s" + Utilities.getUuid().replace(/-/g, "");
}

// 8 caracteres sin letras que se confunden (0/O, 1/l/I)
function passwordTemporal() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const semilla = sha(Utilities.getUuid() + Utilities.getUuid());
  let out = "";
  for (let i = 0; i < 8; i++) out += abc[parseInt(semilla.substr(i * 4, 4), 16) % abc.length];
  return out;
}

function normUsuario(u) { return String(u || "").trim().toLowerCase(); }
function normIniciales(s) { return String(s || "").trim().toUpperCase(); }
function normTexto(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function esVerdadero(v) { return v === true || String(v).toUpperCase() === "TRUE"; }

// Los id de las terminales son la hora de captura en milisegundos.
function fechaDeId(id) {
  const n = Number(id);
  return n > 1.5e12 && n < 4e12 ? new Date(n).toISOString() : "";
}

// Evita que un texto que empieza con = + - @ se interprete como fórmula
function textoSeguro(valor) {
  const v = valor === undefined || valor === null ? "" : String(valor);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function respuesta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
