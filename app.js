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
    btnZoomMenos: $('btnZoomMenos'), btnZoomMas: $('btnZoomMas'), zoomValor: $('zoomValor'),
    btnEnfocar: $('btnEnfocar'), btnTomarFoto: $('btnTomarFoto'), btnSubirFoto: $('btnSubirFoto'),
    inputTomarFoto: $('inputTomarFoto'), inputSubirFoto: $('inputSubirFoto'),
    estadoEscaner: $('estadoEscaner'), lectura: $('lectura'), lecturaValor: $('lecturaValor'),
    codigo: $('codigoBarras'), aviso: $('aviso'), avisoTexto: $('avisoTexto'),
    avisoCerrar: $('avisoCerrar'), configuracion: $('configuracion')
  };

  const state = {
    enviando: false,
    requestId: nuevoId(),
    stream: null, sesion: 0, escaneando: false, timer: null, pista: null, caps: null,
    detector: null, zx: null, canvas: null, timerEnfoque: null, leyendoFoto: false,
    zoom: 1, zoomMin: 1, zoomMax: 4, zoomPaso: 0.5, zoomNativo: false,
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
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  function cargarZXing() {
    if (window.ZXing) return Promise.resolve();
    return new Promise((ok, fallo) => {
      const s = document.createElement('script');
      s.src = ZXING_URL; s.async = true;
      s.onload = ok; s.onerror = () => fallo(new Error('zxing'));
      document.head.appendChild(s);
    });
  }

  async function iniciarZXing() {
    if (state.zx) return;
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
  }

  async function prepararDetector() {
    if (state.detector || state.zx) return;
    if ('BarcodeDetector' in window) {
      try {
        const soportados = await BarcodeDetector.getSupportedFormats();
        const formats = FORMATOS.filter((f) => soportados.includes(f));
        if (formats.length) { state.detector = new BarcodeDetector({ formats }); return; }
      } catch (e) { /* se usa ZXing */ }
    }
    await iniciarZXing();
  }

  function zxDesdeCanvas(canvas) {
    const Z = window.ZXing;
    try {
      const fuente = new Z.HTMLCanvasElementLuminanceSource(canvas);
      return state.zx.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(fuente))).getText();
    } catch (e) { return null; } // NotFoundException: aún no hay código en cuadro
  }
  async function bdDesde(fuente) {
    try {
      const r = await state.detector.detect(fuente);
      return r.length ? r[0].rawValue : null;
    } catch (e) { return null; }
  }

  async function leerFotograma() {
    const v = el.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    const digital = !state.zoomNativo && state.zoom > 1;
    if (state.detector && !digital) return bdDesde(v);
    // Zoom digital: se recorta el centro del fotograma; ZXing siempre lee desde un canvas.
    const z = digital ? state.zoom : 1;
    const sw = v.videoWidth / z, sh = v.videoHeight / z;
    const sx = (v.videoWidth - sw) / 2, sy = (v.videoHeight - sh) / 2;
    const w = Math.min(960, Math.round(sw)), h = Math.round(sh * (w / sw));
    state.canvas = state.canvas || document.createElement('canvas');
    state.canvas.width = w; state.canvas.height = h;
    state.canvas.getContext('2d', { willReadFrequently: true }).drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
    return state.detector ? bdDesde(state.canvas) : zxDesdeCanvas(state.canvas);
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
        return 'Permiso de cámara denegado. Habilítelo en la configuración del navegador, tome una foto o escriba el código a mano.';
      case 'NotFoundError': case 'OverconstrainedError':
        return 'No se encontró una cámara disponible. Suba una foto o escriba el código a mano.';
      case 'NotReadableError': case 'AbortError':
        return 'La cámara está en uso por otra aplicación. Ciérrela e intente de nuevo.';
      default:
        return 'No se pudo iniciar la cámara. Suba una foto o escriba el código a mano.';
    }
  }

  /* ---------- Zoom y enfoque de la cámara ---------- */
  const redondear = (n) => Math.round(n * 100) / 100;

  function actualizarZoomUI() {
    el.zoomValor.textContent = state.zoom.toFixed(1).replace('.', ',') + '×';
    el.btnZoomMenos.disabled = state.zoom <= state.zoomMin + 0.001;
    el.btnZoomMas.disabled = state.zoom >= state.zoomMax - 0.001;
  }

  function configurarControlesCamara() {
    const pista = state.pista;
    const caps = (pista && pista.getCapabilities) ? pista.getCapabilities() : {};
    state.caps = caps;
    state.zoomNativo = Boolean(caps.zoom && caps.zoom.max > caps.zoom.min);
    if (state.zoomNativo) {
      // Zoom real de la cámara (Chrome/Edge en Android, entre otros).
      state.zoomMin = caps.zoom.min; state.zoomMax = caps.zoom.max;
      state.zoomPaso = Math.max(caps.zoom.step || 0.1, (caps.zoom.max - caps.zoom.min) / 8);
      const actual = pista.getSettings && pista.getSettings().zoom;
      state.zoom = actual || caps.zoom.min;
    } else {
      // Zoom digital (recorte): iPhone/Safari y navegadores sin control de zoom.
      state.zoomMin = 1; state.zoomMax = 4; state.zoomPaso = 0.5; state.zoom = 1;
    }
    el.video.style.transform = '';
    if ((caps.focusMode || []).includes('continuous')) {
      pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    actualizarZoomUI();
  }

  async function cambiarZoom(direccion) {
    if (!state.escaneando) return;
    const nuevo = redondear(Math.min(state.zoomMax, Math.max(state.zoomMin, state.zoom + direccion * state.zoomPaso)));
    if (nuevo === state.zoom) return;
    if (state.zoomNativo) {
      try {
        await state.pista.applyConstraints({ advanced: [{ zoom: nuevo }] });
        state.zoom = nuevo;
      } catch (e) {
        estadoEscaner('No se pudo cambiar el zoom en esta cámara.', true);
        return;
      }
    } else {
      state.zoom = nuevo;
      el.video.style.transform = 'scale(' + nuevo + ')';
    }
    actualizarZoomUI();
  }

  async function enfocar() {
    if (!state.escaneando || !state.pista) return;
    const modos = (state.caps && state.caps.focusMode) || [];
    const aplicar = (m) => state.pista.applyConstraints({ advanced: [{ focusMode: m }] });
    try {
      if (modos.includes('single-shot')) {
        await aplicar('single-shot');
      } else if (modos.includes('continuous')) {
        if (modos.includes('manual')) { await aplicar('manual'); await esperar(150); }
        await aplicar('continuous'); // volver a continuo reinicia el enfoque automático
      } else {
        estadoEscaner('Este dispositivo enfoca solo. Aleje un poco el código y vuelva a acercarlo.');
        return;
      }
      estadoEscaner('Enfocando…');
      clearTimeout(state.timerEnfoque);
      state.timerEnfoque = setTimeout(() => {
        if (!state.escaneando) return;
        if (modos.includes('continuous')) aplicar('continuous').catch(() => {});
        estadoEscaner('Apunte la cámara al código y manténgalo estable.');
      }, 1500);
    } catch (e) {
      estadoEscaner('No se pudo ajustar el enfoque en este dispositivo.', true);
    }
  }

  /* ---------- Cámara en vivo ---------- */
  async function iniciarEscaner() {
    if (state.escaneando) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) {
      estadoEscaner('Este navegador no permite usar la cámara aquí. Suba una foto o escriba el código a mano.', true);
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
      state.pista = stream.getVideoTracks()[0] || null;
      el.video.srcObject = stream;
      el.visor.hidden = false;
      await el.video.play();
      configurarControlesCamara();
      estadoEscaner('Apunte la cámara al código y manténgalo estable.');
      await prepararDetector();
      if (sesion !== state.sesion) return;
      ciclo(sesion);
    } catch (err) {
      if (sesion === state.sesion) {
        detenerEscaner();
        estadoEscaner(err && err.message === 'zxing'
          ? 'No se pudo cargar el lector alternativo. Suba una foto o escriba el código a mano.'
          : mensajeCamara(err), true);
      }
    }
  }

  function detenerEscaner() {
    state.sesion++;
    clearTimeout(state.timer);
    clearTimeout(state.timerEnfoque);
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    state.pista = null; state.caps = null; state.zoom = 1; state.zoomNativo = false;
    el.video.srcObject = null;
    el.video.style.transform = '';
    el.visor.hidden = true;
    state.escaneando = false;
    el.btnEscanear.disabled = false;
  }

  /* ---------- Lectura desde foto (tomada o subida) ---------- */
  async function abrirImagen(archivo) {
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(archivo); // respeta la orientación EXIF
        return { fuente: bmp, w: bmp.width, h: bmp.height, cerrar: () => bmp.close && bmp.close() };
      } catch (e) { /* se prueba con <img> */ }
    }
    const url = URL.createObjectURL(archivo);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { fuente: img, w: img.naturalWidth, h: img.naturalHeight, cerrar: () => URL.revokeObjectURL(url) };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }

  function dibujarImagen(img, ladoMax, grados) {
    const escala = Math.min(1, ladoMax / Math.max(img.w, img.h));
    const w = Math.max(1, Math.round(img.w * escala)), h = Math.max(1, Math.round(img.h * escala));
    const canvas = document.createElement('canvas');
    const girar = grados === 90;
    canvas.width = girar ? h : w; canvas.height = girar ? w : h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (girar) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(img.fuente, 0, 0, w, h);
    return canvas;
  }

  async function decodificarImagen(img) {
    const intentos = [];
    const vistos = new Set();
    [1600, 1000, 2400].forEach((lado) => {
      const real = Math.min(lado, Math.max(img.w, img.h));
      [0, 90].forEach((g) => { const k = real + '-' + g; if (!vistos.has(k)) { vistos.add(k); intentos.push([lado, g]); } });
    });

    if (state.detector) {
      const directo = await bdDesde(img.fuente);
      if (directo) return directo;
      for (const [lado, g] of intentos) {
        const c = await bdDesde(dibujarImagen(img, lado, g));
        if (c) return c;
        await esperar(0);
      }
    }
    // ZXing: lector principal si no hay BarcodeDetector, o respaldo si este no encontró nada.
    try { await iniciarZXing(); } catch (e) { return null; }
    for (const [lado, g] of intentos) {
      const c = zxDesdeCanvas(dibujarImagen(img, lado, g));
      if (c) return c;
      await esperar(0);
    }
    return null;
  }

  async function leerFoto(archivo) {
    if (!archivo || state.leyendoFoto) return;
    detenerEscaner();
    limpiarLectura();
    if (archivo.size > 25 * 1024 * 1024) {
      estadoEscaner('La imagen es demasiado grande (máximo 25 MB). Intente con otra foto.', true);
      return;
    }
    state.leyendoFoto = true;
    el.btnTomarFoto.disabled = el.btnSubirFoto.disabled = true;
    estadoEscaner('Leyendo la foto…');
    let img = null;
    try {
      try { img = await abrirImagen(archivo); }
      catch (e) { estadoEscaner('No se pudo abrir la imagen. Pruebe con otra foto (JPG o PNG).', true); return; }
      try { await prepararDetector(); }
      catch (e) { /* decodificarImagen reintenta con ZXing */ }
      const codigo = await decodificarImagen(img);
      if (codigo) {
        aceptarCodigo(String(codigo).trim().slice(0, LIMITES.codigoBarras));
      } else {
        estadoEscaner('No se encontró un código en la foto. Acérquese, evite reflejos y que salga completo y enfocado; o escriba el código a mano.', true);
      }
    } finally {
      if (img) img.cerrar();
      state.leyendoFoto = false;
      el.btnTomarFoto.disabled = el.btnSubirFoto.disabled = false;
    }
  }

  function alElegirFoto(ev) {
    const input = ev.target;
    const archivo = input.files && input.files[0];
    input.value = ''; // permite volver a elegir la misma foto
    leerFoto(archivo);
  }

  el.btnEscanear.addEventListener('click', () => { limpiarLectura(); iniciarEscaner(); });
  el.btnDetener.addEventListener('click', () => { detenerEscaner(); estadoEscaner('Escáner detenido.'); });
  el.btnZoomMas.addEventListener('click', () => cambiarZoom(1));
  el.btnZoomMenos.addEventListener('click', () => cambiarZoom(-1));
  el.btnEnfocar.addEventListener('click', enfocar);
  el.btnTomarFoto.addEventListener('click', () => el.inputTomarFoto.click());
  el.btnSubirFoto.addEventListener('click', () => el.inputSubirFoto.click());
  el.inputTomarFoto.addEventListener('change', alElegirFoto);
  el.inputSubirFoto.addEventListener('change', alElegirFoto);
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
