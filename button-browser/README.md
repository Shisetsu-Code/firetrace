# Button Browser 1.1

Navegador Chromium controlable con comandos. Devuelve los botones visibles como **recortes PNG**, rectángulos y puntos de clic en **coordenadas del área visible del navegador**. Incluye panel web, consola, CLI y API HTTP.

## Qué hace

- Navegación real: URL, atrás, adelante, recargar y pestañas.
- Detección de controles HTML, elementos accesibles y Shadow DOM abierto; inspección de iframes.
- Detección de controles interactivos PixiJS recuperables desde el navegador mediante CDP.
- Visión opcional mediante un modelo con API compatible con OpenAI, como un Qwen VL servido en un equipo o servidor propio.
- Captura anotada, recorte individual de cada botón, lámina de recortes y JSON con coordenadas.
- Clic por ID o coordenadas; mover ratón, escribir texto, pulsar teclas, desplazar y redimensionar.
- Verificación únicamente por orden explícita de la IA: tres lecturas con pausas de 2 segundos. Sólo publica posiciones cuando las tres coinciden.
- Coordenadas x/y y marcador visibles sobre cada botón, en el panel, el navegador controlado y la captura anotada.
- Validación de vigencia y del punto previamente autorizado antes del clic por ID, sin recalcular posiciones ni volver a ejecutar el detector. Los `commandId` repetidos devuelven el resultado anterior sin repetir la acción mientras permanezcan en la caché del proceso.

## Ejecutar en un servidor con Docker

Copiá esta carpeta a un servidor con Docker y Compose. Creá `.env` a partir de `.env.example` y cambiá `BUTTON_BROWSER_TOKEN` por un valor aleatorio de al menos 16 caracteres.

```bash
docker compose up --build -d
```

Abrí `http://IP_DEL_SERVIDOR:8766`, ingresá el token en el panel y cargá una URL. Para acceso por Internet, poné el servicio detrás de HTTPS en tu proxy habitual; el puerto HTTP también sirve para una red privada. Chromium corre dentro del contenedor y no necesita una pantalla ni usar tu PC como ejecutor.

### Ejecutar directamente con Node

Requiere Node.js 22 o posterior.

```bash
npm ci
npx playwright install --with-deps chromium
npm start
```

Panel: `http://127.0.0.1:8766`. En Windows/macOS, usá `npx playwright install chromium`. Para escuchar remotamente, configurá `HOST=0.0.0.0` y `BUTTON_BROWSER_TOKEN`; el proceso rechaza exposición remota sin un token de al menos 16 caracteres.

El panel ofrece **Página de prueba**: permite verificar recortes, clics, modal, ocultamiento, Shadow DOM, teclado y navegación sin depender de servicios externos.

## Comandos

Se pueden enviar desde la consola del panel, CLI o API.

| Comando | Acción |
| --- | --- |
| `goto https://example.com` | Abrir una URL |
| `verify` / `detect` / `observe` | Verificar tres lecturas y publicar sólo posiciones estables |
| `verify vision` | Verificar tres lecturas con reconocimiento visual configurado |
| `snapshot` | Actualizar sólo la captura, sin detectar ni devolver coordenadas |
| `click b3` | Clic en el objetivo de la observación vigente |
| `click 1060 620` | Clic directo en píxeles CSS del viewport |
| `move 1060 620` | Mover el ratón |
| `scroll 500` | Desplazar 500 px hacia abajo |
| `scroll -300 100` | Desplazar vertical y horizontalmente |
| `type texto con espacios` | Escribir en el control enfocado |
| `press Enter` | Pulsar una tecla |
| `press Control+A` | Atajo de teclado; `Meta+A` en contextos macOS |
| `wait 1500` | Esperar y actualizar sólo la captura |
| `resize 1280 720` | Cambiar tamaño del contenido |
| `back` / `forward` / `reload` | Navegación |
| `tabs` / `newtab https://example.com` | Listar o abrir pestaña |
| `switch 0` / `close` | Seleccionar índice desde cero o cerrar pestaña |
| `export` | Obtener enlaces al JSON y la lámina de recortes |

Las acciones actualizan una captura sin posiciones y dejan el estado `unverified`. No disparan detección ni consultas al modelo. Si un sitio tarda en cargar, la IA puede esperar con `wait 1500` y solicitar `verify` cuando corresponda. El panel muestra capturas; no es una transmisión de video continua. Para clic directo sobre la captura, activá el modo de interacción; la interfaz convierte la escala de la imagen a coordenadas del viewport.

### Verificación explícita de estabilidad

La IA manda `verify` cuando decide que corresponde leer los controles. `detect` y `observe` son alias del mismo proceso; ninguno devuelve coordenadas de una sola lectura. El comando toma la primera muestra, espera 2000 ms, toma la segunda, espera 2000 ms y toma la tercera. El tiempo total mínimo es aproximadamente 4 segundos más el tiempo de detección. No se vuelve a intentar automáticamente si cambia la interfaz.

Se compara el conjunto completo de controles, su identidad, texto, estado, rectángulo, punto de clic y apariencia del recorte. Deben coincidir las tres parejas de muestras: 1–2, 1–3 y 2–3. La tolerancia geométrica es 1 píxel CSS; la diferencia media máxima de apariencia es 0,015 en escala 0–1. Los cambios del fondo fuera de los botones no bloquean controles que siguen iguales.

- `stable`: tres lecturas coincidentes. Publica las coordenadas de la tercera lectura, los recortes y el overlay con ID, x/y y marcador.
- `unstable`: alguna lectura cambió o falló. Devuelve `buttons: []`, las razones y una captura sin coordenadas. La IA decide cuándo volver a verificar.
- `unverified`: sólo hay una captura. Se usa después de navegar, hacer clic, escribir, desplazar o pedir `snapshot`. No contiene posiciones y no permite clic por ID.

Las muestras intermedias no se publican ni se escriben como recortes. `GET /api/state` muestra progreso, pero no hace detecciones. La ausencia de cambios en tres instantes no garantiza que el sitio no cambie después; un clic por ID conserva guardas de vigencia y puede rechazar un punto cambiado. Esas guardas no llaman a un modelo ni ejecutan otra detección y nunca sustituyen el punto por uno nuevo.

```text
goto https://example.com
verify
click b1
verify
```

`verify vision` usa el endpoint de visión configurado en cada una de las tres muestras; supone tres solicitudes al modelo. La verificación DOM/Pixi no necesita IA de visión.

### Verificar una selección explícita

Si un control animado impide verificar el conjunto completo, la IA puede solicitar una selección por etiqueta exacta:

```json
{"action":"verify","excludeLabels":["BET_DEC","BET_INC"]}
```

La orden anterior omite esas dos etiquetas de su resultado. Cada control incluido debe superar las mismas tres lecturas, tolerancia de 1 píxel y comparación de apariencia. No se excluye automáticamente ningún control que falle. Los detectores inspeccionan primero la escena completa, de modo que un elemento excluido sigue contando como oclusor de otro control.

`observation.stability.scope` registra las etiquetas excluidas y cuántos candidatos se omitieron en cada muestra. El panel identifica el resultado como **Selección estable**, y no muestra posiciones de los controles excluidos. `verify` sin esta opción mantiene la verificación estricta del conjunto completo.

### CLI

```bash
node src/cli.cjs "goto https://example.com"
node src/cli.cjs "verify"
node src/cli.cjs "click b1"
```

Para otro servidor: `--url https://navegador.example` y variable `BUTTON_BROWSER_TOKEN`. Sin argumentos, lee comandos o JSON por líneas desde stdin y escribe una respuesta JSON por línea. No reintenta acciones automáticamente.

### API

```http
POST /api/command
Content-Type: application/json
Authorization: Bearer TU_TOKEN

{
  "commandId": "click-001",
  "command": {
    "action": "click",
    "id": "b3",
    "observationId": "ID_DEVUELTO_POR_VERIFY"
  }
}
```

Para coordenadas directas, usá `{"action":"click","x":1060,"y":620}`. Para verificar: `{"action":"verify"}`. La respuesta incluye `observation.stability`; únicamente su estado `stable` contiene botones con coordenadas. `GET /api/state` devuelve la observación actual, estado ocupado y disponibilidad de visión. Los recursos `/artifacts/…` usan la misma autorización.

### Forma de salida

Este ejemplo ilustra el esquema; `examples/output/` contiene una salida real de la página de prueba cuando se incluye en el paquete.

```json
{
  "observationId": "identificador-de-la-captura",
  "coordinateSpace": "viewport-css-px",
  "stability": {"status": "stable", "requiredSamples": 3, "completedSamples": 3, "intervalMs": 2000},
  "viewport": {"width": 1280, "height": 720, "deviceScaleFactor": 1},
  "buttons": [{
    "id": "b1",
    "label": "Continuar",
    "kind": "button",
    "source": "dom",
    "confidence": 1,
    "actionable": true,
    "estimated": false,
    "bbox": {"x": 80, "y": 200, "width": 140, "height": 48},
    "center": {"x": 150, "y": 224},
    "clickPoint": {"x": 150, "y": 224},
    "normalized": {"x": 0.0625, "y": 0.277778, "width": 0.109375, "height": 0.066667},
    "cropUrl": "/artifacts/identificador/b1.png"
  }]
}
```

`bbox` es el rectángulo visible del objetivo. `center` es su centro geométrico; `clickPoint` es un punto comprobado para interacción cuando la fuente permite comprobarlo. Pueden diferir cuando sólo parte del botón es accesible. Las coordenadas normalizadas van de 0 a 1. La captura tiene un píxel por píxel CSS; no incluye barra de direcciones, pestañas ni marco del sistema operativo. Las coordenadas de iframes se transforman al viewport principal.

## Alcance de la detección

**DOM.** Excluye controles ocultos, deshabilitados y sin un punto visible de interacción. Incluye botones, enlaces y toggles, identificados por `kind`. También incluye controles con listeners o cursor de mano; los que sólo tienen cursor se marcan como estimados. Shadow DOM cerrado no se puede recorrer con esta estrategia.

**Pixi.** Inspecciona escenas accesibles desde gestores de interacción del canvas, sin ejecutar sus callbacks. La compatibilidad depende de la versión y de cómo el juego integra el motor. Se prueba específicamente PixiJS 6.5.2, la versión encontrada en el HAR aportado. Un canvas que no expone una escena compatible produce una advertencia; no se transforma automáticamente en un supuesto botón.

**Visión.** Sirve de alternativa para canvas opacos o motores distintos. Requiere configurar un modelo. Su salida es una estimación y la confianza no es una probabilidad calibrada. Antes de un clic visual por ID se compara el recorte con la última captura verificada; un cambio relevante exige otra orden `verify`. Esta comprobación no convierte el modelo en infalible.

## Configurar visión opcional

En `.env` para Docker, o como variables del proceso Node:

```dotenv
VISION_BASE_URL=https://TU_SERVIDOR_DE_VISION/v1
VISION_MODEL=IDENTIFICADOR_DEL_MODELO
VISION_API_KEY=SI_EL_SERVIDOR_LA_REQUIERE
```

`verify vision` envía tres capturas al endpoint configurado, una por muestra. El modo normal funciona sin API de IA. El adaptador espera `/chat/completions` con imágenes en `image_url` y una respuesta JSON de cajas; la capacidad de interpretar imágenes depende del modelo que alojes. No se configura ningún proveedor por defecto.

## Ejecución por lote / CI

```bash
node scripts/batch.cjs examples/commands.json
```

El array contiene exclusivamente los comandos solicitados. La salida por línea es JSON y los archivos quedan en `data/observations/`. El flujo de GitHub Actions incluido ejecuta pruebas y puede ejecutar un archivo de comandos mediante `workflow_dispatch`. Las sesiones de CI terminan al finalizar el trabajo; para un navegador interactivo persistente usá el servicio en un servidor.

## Vigencia, datos y límites operativos

- Las coordenadas sobre la pantalla se dibujan con código a partir de la muestra verificada; no dependen de que el modelo escriba o explique sus posiciones. El overlay no captura eventos del mouse y se quita al invalidar la verificación.
- Un ID corresponde a una observación; no es permanente entre capturas. Para automatización, enviá siempre `observationId` junto al ID.
- Vigencia máxima de referencia: 120 segundos, además de comprobar navegación, estado y ubicación al hacer clic. Las coordenadas directas ejecutan lo solicitado sin vincularse a un botón.
- Los comandos se serializan por servicio. La caché conserva hasta 256 `commandId`; no sobrevive al reinicio. En caso de pérdida de conexión, consultá el estado y reutilizá el mismo ID mientras la instancia siga viva. No se promete exactamente una vez después de reinicios.
- Los artefactos se guardan en `data/observations/`. Se conservan las últimas 12 observaciones creadas durante cada ejecución; los archivos de ejecuciones anteriores no se borran automáticamente.
- Las sesiones arrancan con un contexto limpio. No se guardan cookies ni perfiles persistentes.
- El HAR proporcionado se utilizó para identificar el motor y diseñar la detección. El paquete no incluye su sesión, credenciales ni recursos gráficos del juego.
- El navegador no descubre por sí mismo qué URL querés abrir ni recorre compras/apuestas automáticamente. Sólo ejecuta tus comandos.

## Pruebas

```bash
npm ci
npx playwright install --with-deps chromium
npm test
```

Pruebas con Chromium real: HTML, Shadow DOM, iframes con escala, ocultamiento, controles Pixi, recortes, validación de objetivos, API y reintentos. El transporte de visión se prueba con un endpoint de prueba local; no incluye evaluación de calidad de un modelo de visión externo. Ver `docs/verification.md` para el resultado de la entrega.

## Referencias de implementación

- [Playwright: boundingBox y coordenadas respecto al viewport principal](https://playwright.dev/docs/api/class-locator#locator-bounding-box)
- [Playwright: captura con escala CSS](https://playwright.dev/docs/api/class-page#page-screenshot)
- [Chrome DevTools Protocol: listeners de eventos](https://chromedevtools.github.io/devtools-protocol/tot/DOMDebugger/#method-getEventListeners)
- [PixiJS 6.5.2](https://github.com/pixijs/pixijs/tree/v6.5.2)
