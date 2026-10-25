# Button Browser — diseño

Objetivo: navegador Chromium real controlable por comandos, con lista filtrada de botones, recortes PNG, rectángulos y centros de clic. Ejecutable en servidor/headless, con panel web, CLI y API. No depende de la PC del usuario.

La política de verificación explícita y overlays de la versión 1.1 se detalla en [stability-design.md](stability-design.md).

## Decisiones de implementación
Node.js 22+ + Playwright + Sharp. UI estática servida por el mismo proceso. Se entrega como paquete independiente porque el pedido actual no identifica un repositorio de destino. El repositorio previo Firetrace es Python y se preserva.

Detección híbrida: DOM accesible (incluye iframes y Shadow DOM abierto); escenas interactivas Pixi recuperables con CDP; opcional visión por endpoint compatible con OpenAI (p. ej. Qwen VL). Los resultados de visión se identifican como estimaciones. Nunca se inventan botones de un canvas opaco: se informa el límite.

## Salida
Cada observación: observationId, timestamp, url, viewport {width,height,deviceScaleFactor}, coordinateSpace=viewport-css-px, buttons [{id,label,kind,source,confidence,actionable,bbox:{x,y,width,height},center:{x,y},normalized:{x,y,width,height},cropUrl}], screenshotUrl, annotatedUrl, contactSheetUrl, warnings. Datos internos de destino fuera del JSON. Crops del mismo screenshot usado en esa observación; x/y CSS.

## Operaciones
goto, back, forward, reload, verify (alias observe/detect), snapshot, click por ID+observationId o x/y, move, scroll, type, press, wait, resize, tabs, newtab, switch, close, export. CLI JSON Lines y comandos de texto; HTTP POST /api/command. Acciones serializadas y commandId evita repetir solicitudes. Datos de observación con vida limitada y comprobación del punto exacto antes de click por ID. Sólo verify inicia las tres lecturas y publica posiciones cuando coinciden.

## Panel
Barra de URL; captura actual con cajas y etiquetas ID/x/y activables; galería de recortes y búsqueda por texto/fuente; consola; JSON descargable. Clic manual en captura sólo tras habilitar modo de interacción. Las acciones actualizan sólo la imagen sin verificar; los recortes y coordenadas se publican después de verify estable.

## Límites
No contiene sesión, tokens ni assets del HAR; se usa para investigación y pruebas offline internas. No se prometen todos los motores propietarios. La visión necesita servidor/modelo externo configurado. El software no ejecuta apuestas autónomas.

## Comprobación
Chromium real con fixture DOM, sombras, iframe cruzado, canvas Pixi, cambios de estado, exclusión de botones invisibles/deshabilitados/tapados, coordenadas/crops, navegación y clic. Validación offline del HAR si permite arrancar con sus recursos.
