# Jump Platform – Web Client

PWA/SPA que muestra en tiempo real los datos de la plataforma de salto vía SSE
y permite grabar/exportar sesiones.

## Uso rápido

```
web/
├── index.html
├── manifest.json
├── service-worker.js
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── src/
    ├── main.js
    └── styles.css
```

### Correr localmente (recomendado para conectarse al ESP32)

```bash
cd web/
python3 -m http.server 8080
# abre http://localhost:8080
```

O con Node:

```bash
npx serve web/
```

### Publicar en GitHub Pages

1. Habilitar GitHub Pages desde `Settings → Pages → Source: main / root` (o `/web`).
2. Acceder por HTTPS, p.ej. `https://usuario.github.io/repo/web/`.

---

## Problema de Mixed Content

GitHub Pages sirve la app en **HTTPS**. El ESP32 corre en **HTTP** (192.168.4.1).  
Los navegadores **bloquean** requests HTTP desde una página HTTPS (Mixed Content).

### Soluciones (de más fácil a más robusta)

| Opción | Descripción |
|--------|-------------|
| **A – HTTP local** | Correr la app en `http://localhost:8080` en vez de GitHub Pages. Funciona sin restricciones. |
| **B – Permitir insecure en Chrome** | En Chrome: `Configuración del sitio → Contenido no seguro → Permitir` para la URL de GitHub Pages. |
| **C – Instalar como PWA** | Instalar la PWA desde el propio ESP32 (si se sirve desde ahí) en HTTP. |
| **D – Proxy HTTPS** | Colocar un proxy TLS delante del ESP32 (más complejo, requiere dominio + cert). |

La opción **A** es la más práctica para uso en campo: conectar el celular al AP del
ESP32 y abrir `http://localhost:8080` desde una laptop con la app corriendo, o bien
navegar directamente a `http://192.168.4.1` si el ESP32 sirve la SPA desde su flash.

---

## Configuración (Settings modal)

| Campo | Descripción | Default |
|-------|-------------|---------|
| URL del ESP32 | URL base del servidor | `http://192.168.4.1` |
| Ventana (s) | Segundos visibles en el gráfico | `10` |
| Línea calculada | `mediana`, `media` o `total` | `mediana` |
| Nombre de archivo | Nombre del JSON a descargar | `medicion.json` |
| Dark mode | Toggle claro/oscuro | Oscuro |

Toda la configuración se persiste en **localStorage**.

## Acciones ESP32 (dentro de Settings)

| Botón | Comando enviado | Descripción |
|-------|-----------------|-------------|
| TARE | `TARE` | Tara todos los sensores |
| CALIBRATE | `CALIBRATE:<peso>` | Calibra con peso conocido (kg) |
| SAVE | `SAVE` | Persiste calibración en flash |

## Grabación

1. **REC** – empieza a acumular frames en memoria.
2. **STOP** – detiene la grabación.
3. **SAVE** – descarga el JSON con metadata y samples.

Formato del JSON exportado:

```json
{
  "metadata": {
    "start": "2026-05-10T12:00:00.000Z",
    "end":   "2026-05-10T12:00:10.000Z",
    "url":   "http://192.168.4.1",
    "calc":  "median",
    "windowSecs": 10,
    "samples": 800
  },
  "samples": [
    { "t": 1715340000000, "fl": 12.3, "fr": 11.8, "rl": 12.1, "rr": 11.9, "calc": 12.05 }
  ]
}
```
