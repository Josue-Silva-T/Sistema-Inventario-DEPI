# Sistema de Inventariado · División DEPI

Formulario web para registrar equipos, dispositivos y materiales, con escáner de códigos de barras en la cámara del celular. Los registros se guardan en Google Sheets.

```
GitHub Pages (frontend)  →  Google Apps Script (Web App)  →  Google Sheets
```

Todo funciona con los planes gratuitos de GitHub y Google. No se usa ningún otro servicio.

## Estructura

```text
sistema-inventariado-depi/
├── index.html · styles.css · app.js · config.js
├── assets/icons/icon.svg
└── google-apps-script/
    ├── Code.gs  Config.gs  Validation.gs  README.md
```

## Instalación paso a paso

### 1. Requisitos previos
- Una cuenta de Google (de preferencia institucional o una cuenta dedicada al proyecto, porque será la propietaria de la hoja y del script).
- Una cuenta de GitHub.
- Un celular con cámara y navegador actualizado (Chrome, Edge, Safari o Firefox).

### 2. Crear el repositorio en GitHub
1. Entre a github.com → **New repository**.
2. Nombre: `sistema-inventariado-depi`. Visibilidad **Public** (GitHub Pages gratuito lo requiere en cuentas personales).
3. Suba los archivos de la raíz (`index.html`, `styles.css`, `app.js`, `config.js`, `README.md`) y la carpeta `assets/`. La carpeta `google-apps-script/` puede subirse también; no se ejecuta en GitHub.

### 3. Crear la hoja de cálculo
1. Entre a sheets.google.com → **En blanco**.
2. Póngale el nombre **Sistema de Inventariado - División DEPI**.
3. Copie el **ID** de la hoja: es el texto largo de la URL entre `/d/` y `/edit`.
   `https://docs.google.com/spreadsheets/d/`**`ESTE_ES_EL_ID`**`/edit`

### 4. Pestaña Capturas y encabezados (pasos 5 y 6 de su lista)
No hace falta crearlos a mano: el paso 8 ejecuta una función que crea la pestaña **Capturas**, escribe los encabezados `ID, CodigoBarras, NumeroSerie, Ubicacion, Descripcion, Estado, Observaciones, FechaCaptura` y fija el formato de texto en las columnas (conserva los ceros iniciales).

### 5. Crear el proyecto de Apps Script
1. En la hoja: **Extensiones → Apps Script**.
2. Nómbrelo "Inventariado DEPI".

### 6. Pegar el código del backend
1. En el editor, el archivo `Código.gs` ya existe: reemplace su contenido con el de `google-apps-script/Code.gs`.
2. Cree dos archivos con **+ → Script**: `Config` y `Validation`, y pegue `Config.gs` y `Validation.gs`.

### 7. Configurar ID, zona horaria y token
En `Config.gs` cambie:
- `SPREADSHEET_ID`: el ID del paso 3.
- `TIMEZONE`: por defecto `America/Mexico_City`.
- `APP_TOKEN`: un texto propio (ej. `depi-2026-xk93`). Debe ser **idéntico** al `APP_TOKEN` de `config.js`.

Guarde (Ctrl+S).

### 8. Preparar la hoja
En el editor elija la función **`configurarHoja`** en el menú superior y pulse **Ejecutar**. La primera vez Google pide permisos: **Revisar permisos → su cuenta → Avanzado → Ir a Inventariado DEPI (no seguro) → Permitir**. Es normal: el script es suyo y no está verificado por Google.

Revise que la hoja ahora tiene la pestaña **Capturas** con los encabezados.

### 9. Implementar como aplicación web
1. **Implementar → Nueva implementación**.
2. Engranaje → **Aplicación web**.
3. **Ejecutar como: Yo**.
4. **Quién tiene acceso: Cualquier persona** (así el personal registra sin iniciar sesión; ver "Seguridad").
5. **Implementar**.

> Si su organización de Google Workspace no permite "Cualquier persona", solicite al administrador que lo habilite o use una cuenta personal de Google.

### 10. Obtener la URL del backend
Al terminar, copie la **URL de la aplicación web** (termina en `/exec`). Pegada en el navegador debe mostrar algo como:
`{"ok":true,"servicio":"Sistema de Inventariado / División DEPI","version":"1.0.0","configurado":true}`

### 11. Configurar el frontend
En `config.js`:
```js
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';
const APP_TOKEN = 'el mismo valor de Config.gs';
```
Suba el cambio a GitHub (Commit).

### 12. Activar GitHub Pages
Repositorio → **Settings → Pages** → *Source*: **Deploy from a branch** → rama `main`, carpeta `/ (root)` → **Save**. En 1–2 minutos aparece la URL `https://SU_USUARIO.github.io/sistema-inventariado-depi/`.

### 13. Prueba de conexión
1. Abra la URL `/exec` en el navegador (paso 10): debe devolver el JSON.
2. Abra la página de GitHub Pages: no debe aparecer el aviso rojo de "no está conectada".

### 14. Prueba de registro desde un celular
1. Abra la página en el celular.
2. Pulse **Escanear**, acepte el permiso de cámara y apunte a un código. Los dígitos aparecen en grande y el campo se llena.
3. Complete serie, ubicación, descripción y estado → **Guardar registro**.
4. Debe aparecer "Registro guardado correctamente" con un folio, y la fila debe verse en la pestaña **Capturas**.

### 15. Exportar a Excel
En Google Sheets: **Archivo → Descargar → Microsoft Excel (.xlsx)**. Solo las personas con acceso a la hoja pueden hacerlo.

### 16. Actualizar el backend más adelante
Si cambia el código: **Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar**. La URL no cambia. (Guardar el código **no** actualiza la versión publicada.)

## Cómo se comunican frontend y backend

- `fetch()` envía `POST` con `Content-Type: text/plain` y el JSON como texto. Esto es una "solicitud simple" de CORS: no hay preflight, algo que Apps Script no soporta.
- Apps Script responde con una redirección; `fetch` la sigue y las respuestas de `ContentService` publicadas como "Cualquier persona" incluyen cabeceras CORS, por lo que **el frontend sí lee la respuesta real** (no se usa `no-cors`).
- El frontend solo muestra éxito si recibe `{"ok":true,"id":...}`. Si no hay respuesta, muestra error y **conserva los datos**.
- Cada envío lleva un `requestId`. Si la respuesta se pierde pero la fila sí se guardó, el reintento no duplica: el servidor responde "ya se había guardado" (memoria de 6 horas). Además el backend rechaza números de serie ya existentes.
- Limitaciones: la primera llamada tras un tiempo sin uso puede tardar varios segundos; algunas redes o bloqueadores pueden impedir leer la respuesta (el sistema lo comunica como error, no como éxito).

## Seguridad: lo que sí y lo que no protege

Una Web App de Apps Script abierta a "Cualquier persona" es, por definición, un punto público.

**Lo que sí hay:**
- El backend valida y normaliza todo, ignora lo que diga el navegador, y solo permite **agregar** filas (no hay endpoint de lectura ni de borrado). La hoja sigue privada: solo la ven quienes usted comparta.
- `LockService` serializa las escrituras; límite global de 30 solicitudes por minuto; tamaño máximo de solicitud; longitudes máximas por campo.
- No hay credenciales en el frontend.

**Lo que NO hay:**
- `APP_TOKEN` **no es un secreto**: cualquiera que abra el código de la página lo ve. Solo evita envíos accidentales o de bots básicos; no impide que una persona determinada envíe datos.
- El límite por minuto es global (Apps Script no entrega la IP): un abusador podría agotarlo y bloquear temporalmente a los demás.
- Quien conozca la URL y el token podría insertar registros falsos. Mitigación: revise la hoja periódicamente, cambie el token si sospecha abuso (en `Config.gs` y `config.js`, y publique nueva versión) o mantenga la URL de la página solo entre el personal.
- Si necesita control real de acceso, la alternativa es exigir inicio de sesión de Google (implementación restringida a su dominio), a costa de que cada persona deba autenticarse.

Los textos se guardan como texto plano en celdas con formato texto, así que `=` o `+` iniciales no se ejecutan como fórmulas.

## Límites del plan gratuito
Google Apps Script y Google Sheets tienen cuotas diarias (tiempo de ejecución, solicitudes simultáneas, celdas por hoja ≈ 10 millones). Para un inventario institucional normal sobran; consulte la documentación vigente de cuotas de Google para cifras actuales.

## Pruebas

Esta entrega **no fue probada contra servicios reales de Google ni GitHub** (no hay acceso a sus cuentas). Pruebas reproducibles:

1. **Backend desde el editor:** ejecute `pruebaRegistro` y revise *Registro de ejecución* y la hoja. Bórrela después.
2. **Backend con curl** (reemplace URL y token):
   ```bash
   URL="https://script.google.com/macros/s/XXXX/exec"
   curl -L "$URL"
   curl -L -X POST -H "Content-Type: text/plain" \
     --data '{"token":"TU_TOKEN","requestId":"prueba-0000000000001","codigoBarras":"0001234","numeroSerie":"00123","ubicacion":"Lab 2","descripcion":"Laptop","estado":"Bueno","observaciones":""}' "$URL"
   ```
   Repita el mismo `POST`: debe devolver `repetido:true` (sin fila nueva). Cambie `requestId` y repita: debe devolver `DUPLICADO`. Use un token incorrecto: `NO_AUTORIZADO`. Quite `numeroSerie`: `VALIDACION`.
3. **Ceros iniciales:** el registro anterior debe verse como `0001234` y `00123` en la hoja.
4. **Doble clic:** pulse "Guardar registro" muy rápido: debe aparecer una sola fila.
5. **Error con datos conservados:** desactive el internet del celular y guarde; debe verse el error y el formulario intacto.
6. **Cámara:** en el celular, abra el escáner y cierre la pestaña o cambie de aplicación: el indicador de cámara debe apagarse. Niegue el permiso para ver el mensaje de error.

## Solución de errores frecuentes

| Síntoma | Causa y solución |
|---|---|
| Aviso rojo "no está conectada" | `GOOGLE_SCRIPT_URL` vacía o no termina en `/exec`. |
| "Solicitud no autorizada" | `APP_TOKEN` distinto entre `config.js` y `Config.gs`, o falta publicar nueva versión (paso 16). |
| "No existe la pestaña" / "encabezados no coinciden" | Ejecute `configurarHoja` (paso 8). No renombre columnas. |
| "El servidor no está configurado" | Falta `SPREADSHEET_ID` en `Config.gs`. |
| No se pudo confirmar el guardado | Sin internet, o el acceso no está en "Cualquier persona"; revise paso 9. Los datos se conservan. |
| Cámara no abre | Use HTTPS (GitHub Pages ya lo es), acepte el permiso y cierre otras apps que usen la cámara. |
| El escáner lee lento | Buena luz, 15–25 cm de distancia, código dentro del recuadro. En navegadores sin `BarcodeDetector` se carga ZXing (requiere internet). |
| Cambié el código y no surte efecto | Publique **Nueva versión** de la implementación. |
