/**
 * app.js — Lógica del formulario, escáner y envío a Google Apps Script.
 * Depende de config.js (GOOGLE_SCRIPT_URL, APP_TOKEN).
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LIMITES = { codigoBarras: 64, numeroSerie: 100, ubicacion: 120, descripcion: 160, observaciones: 500 };
  const CAMPOS = ['codigoBarras', 'numeroSerie', 'ubicacion', 'descripcion', 'observaciones'];
  const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code', 'data_matrix'];

  const el = {
    form: $('formulario'), btnGuardar: $('btnGuardar'), btnEscanear: $('btnEscanear'),
    btnDetener: $('btnDetener'), visor: $('visor'), video: $('video'),
    estadoEscaner: $('estadoEscaner'), lectura: $('lectura'), lecturaValor: $('lecturaValor'),
    codigo: $('codigoBarras'), aviso: $('aviso'), avisoTexto: $('avisoTexto'),
    avisoCerrar: $('avisoCerrar'), configuracion: $('configuracion')
  };

  const state = {
    enviando: false,
    requestId: nuevoId(),
    stream: null, sesion: 0, escaneando: false, timer: null, pista: null,
    detector: null, zx: null, canvas: null,
    ultimoCodigo: '', ultimoTiempo: 0, avisoTimer: null
  };

  const configurado = typeof GOOGLE_SCRIPT_URL === 'string' &&
    /^https:\/\/script\.google\.com\/.+\/exec$/.test(GOOGLE_SCRIPT_URL.trim());

  function nuevoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return (Date.now().toString(16) + Math.random().toString(16).slice(2) + '0000000000000000').slice(0, 32);
  }

  /* ---------- Avisos ---------- */
  function mostrarAviso(tipo, texto, autoOcultar) {
    clearTimeout(state.avisoTimer);
    el.avisoTexto.textContent = texto;
    el.aviso.className = 'aviso ' + (tipo === 'exito' ? 'exito' : 'fallo');
    el.aviso.setAttribute('role', tipo === 'exito' ? 'status' : 'alert');
    el.aviso.hidden = false;
    if (autoOcultar) state.avisoTimer = setTimeout(ocultarAviso, autoOcultar);
  }
  function ocultarAviso() { el.aviso.hidden = true; }
  el.avisoCerrar.addEventListener('click', ocultarAviso);

  /* ---------- Validación ---------- */
  function leerDatos() {
    const f = el.form;
    const limpio = (v) => String(v || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const estado = f.querySelector('input[name="estado"]:checked');
    return {
      codigoBarras: limpio(f.codigoBarras.value),
      numeroSerie: limpio(f.numeroSerie.value),
      ubicacion: limpio(f.ubicacion.value),
      descripcion: limpio(f.descripcion.value),
      estado: estado ? estado.value : '',
      observaciones: f.observaciones.value.replace(/\r\n?/g, '\n').trim()
    };
  }

  function validar(d) {
    const e = {};
    if (!d.numeroSerie) e.numeroSerie = 'El número de serie es obligatorio.';
    if (!d.ubicacion) e.ubicacion = 'La ubicación es obligatoria.';
    if (!d.descripcion) e.descripcion = 'La descripción o tipo es obligatoria.';
    if (!['Bueno', 'Regular', 'Malo'].includes(d.estado)) e.estado = 'Seleccione un estado: Bueno, Regular o Malo.';
    CAMPOS.forEach((c) => {
      if (!e[c] && d[c].length > LIMITES[c]) e[c] = 'No puede exceder ' + LIMITES[c] + ' caracteres.';
    });
    return e;
  }

  function mostrarErrores(errores) {
    let primero = null;
    ['codigoBarras', 'numeroSerie', 'ubicacion', 'descripcion', 'estado', 'observaciones'].forEach((c) => {
      const p = $('err-' + c);
      const msg = errores[c];
      p.hidden = !msg;
      p.textContent = msg || '';
      const campo = c === 'estado' ? el.form.querySelector('input[name="estado"]') : el.form[c];
      if (campo && c !== 'estado') campo.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (msg && !primero) primero = campo;
    });
    if (primero) primero.focus();
  }

  /* ---------- Envío ---------- */
  async function enviarAlServidor(datos) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      // text/plain evita la solicitud previa (preflight) de CORS que Apps Script no admite.
      const resp = await fetch(GOOGLE_SCRIPT_URL.trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ token: APP_TOKEN, requestId: state.requestId }, datos)),
        redirect: 'follow',
        signal: ctrl.signal
      });
      const texto = await resp.text();
      try { return JSON.parse(texto); }
      catch (e) { return { ok: false, code: 'RESPUESTA_INVALIDA' }; }
    } finally { clearTimeout(t); }
  }

  function fijarEnvio(enviando) {
    state.enviando = enviando;
    el.btnGuardar.disabled = enviando;
    el.btnGuardar.setAttribute('aria-busy', enviando ? 'true' : 'false');
    el.btnGuardar.textContent = enviando ? 'Guardando…' : 'Guardar registro';
  }

  async function alEnviar(ev) {
    ev.preventDefault();
    if (state.enviando) return; // evita duplicados por doble clic
    ocultarAviso();
    if (!configurado) { el.configuracion.hidden = false; return; }

    const datos = leerDatos();
    const errores = validar(datos);
    mostrarErrores(errores);
    if (Object.keys(errores).length) {
      mostrarAviso('fallo', 'Revise los campos marcados antes de guardar.');
      return;
    }

    fijarEnvio(true);
    try {
      const r = await enviarAlServidor(datos);
      if (r && r.ok === true && r.id) {
        el.form.reset();
        limpiarLectura();
        mostrarErrores({});
        state.requestId = nuevoId();
        mostrarAviso('exito', 'Registro guardado correctamente. Folio: ' + r.id + '.', 8000);
      } else {
        if (r && r.errores) mostrarErrores(r.errores);
        mostrarAviso('fallo', (r && r.message) ? r.message : 'El servidor no confirmó el registro. Sus datos se conservaron.');
      }
    } catch (err) {
      // Sin respuesta verificable: no se asume éxito. El mismo requestId permite reintentar sin duplicar.
      mostrarAviso('fallo', 'No se pudo confirmar el guardado (sin conexión o sin respuesta). Sus datos se conservaron; puede intentar de nuevo.');
    } finally {
      fijarEnvio(false);
    }
  }

  /* ---------- Escáner ---------- */
  function estadoEscaner(texto, esError) {
    el.estadoEscaner.hidden = !texto;
    el.estadoEscaner.textContent = texto || '';
    el.estadoEscaner.classList.toggle('es-error', Boolean(esError));
  }
  function limpiarLectura() { el.lectura.hidden = true; el.lecturaValor.textContent = ''; estadoEscaner(''); }

  function cargarZXing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise((ok, fallo) => {
      const s = document.createElement('script');
      s.src = ZXING_URL; s.async = true;
      s.onload = ok; s.onerror = () => fallo(new Error('zxing'));
      document.head.appendChild(s);
    });
  }

  async function prepararDetector() {
    if ('BarcodeDetector' in window) {
      try {
        const soportados = await BarcodeDetector.getSupportedFormats();
        const formats = FORMATOS.filter((f) => soportados.includes(f));
        if (formats.length) { state.detector = new BarcodeDetector({ formats }); return; }
      } catch (e) { /* se usa ZXing */ }
    }
    state.detector = null;
    await cargarZXing();
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93,
      Z.BarcodeFormat.CODABAR, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    state.zx = new Z.MultiFormatReader();
    state.zx.setHints(hints);
    state.canvas = document.createElement('canvas');
  }

  async function leerFotograma() {
    const v = el.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    if (state.detector) {
      const r = await state.detector.detect(v);
      return r.length ? r[0].rawValue : null;
    }
    const w = Math.min(960, v.videoWidth);
    const h = Math.round(v.videoHeight * (w / v.videoWidth));
    state.canvas.width = w; state.canvas.height = h;
    const ctx = state.canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const Z = window.ZXing;
    try {
      const fuente = new Z.HTMLCanvasElementLuminanceSource(state.canvas);
      return state.zx.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(fuente))).getText();
    } catch (e) { return null; } // NotFoundException: aún no hay código en cuadro
  }

  function ciclo(sesion) {
    if (sesion !== state.sesion) return;
    leerFotograma().then((codigo) => {
      if (sesion !== state.sesion) return;
      if (codigo) {
        const ahora = Date.now();
        const c = String(codigo).trim().slice(0, LIMITES.codigoBarras);
        if (c && !(c === state.ultimoCodigo && ahora - state.ultimoTiempo < 3000)) {
          aceptarCodigo(c);
          return;
        }
      }
      state.timer = setTimeout(() => ciclo(sesion), 120);
    }).catch(() => { state.timer = setTimeout(() => ciclo(sesion), 250); });
  }

  function aceptarCodigo(c) {
    state.ultimoCodigo = c; state.ultimoTiempo = Date.now();
    el.codigo.value = c;
    el.codigo.setAttribute('aria-invalid', 'false');
    el.lecturaValor.textContent = c;
    el.lectura.hidden = false;
    if (navigator.vibrate) navigator.vibrate(150);
    detenerEscaner();
    estadoEscaner('Código leído correctamente. Puede corregirlo a mano si es necesario.');
  }

  function mensajeCamara(err) {
    switch (err && err.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Permiso de cámara denegado. Habilítelo en la configuración del navegador o escriba el código a mano.';
      case 'NotFoundError': case 'OverconstrainedError':
        return 'No se encontró una cámara disponible. Escriba el código a mano.';
      case 'NotReadableError': case 'AbortError':
        return 'La cámara está en uso por otra aplicación. Ciérrela e intente de nuevo.';
      default:
        return 'No se pudo iniciar la cámara. Escriba el código a mano.';
    }
  }

  async function iniciarEscaner() {
    if (state.escaneando) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      estadoEscaner('Este navegador no permite usar la cámara aquí. Escriba el código a mano.', true);
      return;
    }
    const sesion = ++state.sesion;
    state.escaneando = true;
    el.btnEscanear.disabled = true;
    estadoEscaner('Solicitando acceso a la cámara…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (sesion !== state.sesion) { stream.getTracks().forEach((t) => t.stop()); return; }
      state.stream = stream;
      el.video.srcObject = stream;
      el.visor.hidden = false;
      await el.video.play();
      estadoEscaner('Apunte la cámara al código y manténgalo estable.');
      await prepararDetector();
      if (sesion !== state.sesion) return;
      ciclo(sesion);
    } catch (err) {
      if (sesion === state.sesion) {
        detenerEscaner();
        estadoEscaner(err && err.message === 'zxing'
          ? 'No se pudo cargar el lector alternativo. Escriba el código a mano.'
          : mensajeCamara(err), true);
      }
    }
  }

  function detenerEscaner() {
    state.sesion++;
    clearTimeout(state.timer);
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    el.video.srcObject = null;
    el.visor.hidden = true;
    state.escaneando = false;
    el.btnEscanear.disabled = false;
  }

  el.btnEscanear.addEventListener('click', () => { limpiarLectura(); iniciarEscaner(); });
  el.btnDetener.addEventListener('click', () => { detenerEscaner(); estadoEscaner('Escáner detenido.'); });
  window.addEventListener('pagehide', detenerEscaner);
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.escaneando) detenerEscaner(); });

  /* ---------- Inicio ---------- */
  el.form.addEventListener('submit', alEnviar);
  el.form.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.name && $('err-' + t.name) && !$('err-' + t.name).hidden) {
      $('err-' + t.name).hidden = true;
      t.setAttribute('aria-invalid', 'false');
    }
  });
  if (!configurado) { el.configuracion.hidden = false; el.btnGuardar.disabled = true; }
})();
