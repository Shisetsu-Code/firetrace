# Verificación explícita de tres lecturas

Requisito del usuario: el motor de IA decide cuándo verificar. Una orden inicia tres comprobaciones separadas por pausas de 2000 ms. Las posiciones se publican sólo si las tres coinciden. Las coordenadas de cada botón aparecen sobre la pantalla y en la captura anotada, además del JSON.

## Decisiones
- `verify` es el comando explícito. `detect` y `observe` conservan compatibilidad como alias de verificación. `snapshot` sólo obtiene imagen.
- Navegar, clic, teclado, desplazamiento, espera y resize actualizan solamente una captura sin coordenadas; invalidan la verificación previa. Ninguna acción ni consulta de estado llama al detector automáticamente.
- Cada solicitud toma exactamente tres lecturas completas, con pausa de 2000 ms después de cada una de las dos primeras. No reintenta ni espera indefinidamente si detecta cambios.
- Se compara la página, viewport, conjunto de controles, etiquetas, estado accionable, identidad DOM/Pixi, rectángulos y puntos de clic. Tolerancia geométrica: 1 píxel CSS entre cualquier par de lecturas. También se comparan los recortes: diferencia media máxima 0,015 sobre escala 0–1. Cambios en fondos fuera de los botones no invalidan los controles.
- Se usan las posiciones de la tercera lectura, sin promedios. Si una lectura falla o discrepa, `buttons: []`, estabilidad `unstable`, razones sin coordenadas de candidatos.
- La publicación es atómica: las muestras intermedias se mantienen en RAM y el estado sólo expone el progreso. No hay archivos/JSON/overlays con posiciones sin verificar.
- Los clics por ID usan exclusivamente la última posición verificada y consumen esa observación. No inician un detector ni cambian el punto. Conservan guardas de ID/página/viewport/vigencia y comprobación de seguridad del punto previamente autorizado cuando corresponda; nunca publican una posición nueva.
- Overlay propio sin eventos del puntero en navegador controlado y en panel, con ID, x/y y marcador. Se elimina antes de cualquier captura usada para verificar y al invalidar la verificación.

## API
`POST /api/command {command:{action:"verify"},commandId:"v1"}`. Visión opcional mediante `vision:true` realiza tres lecturas con modelo. Misma caché de commandId, sin duplicar una verificación ya solicitada.

`observation.stability`: {status:"stable"|"unstable"|"unverified",requiredSamples:3,completedSamples,intervalMs:2000,geometryTolerancePx:1,maxCropDifference:0.015,reasons:[],samples:[{index,timestamp,candidateCount}]}. Sólo estado stable contiene buttons y habilita clic por ID. `GET /api/state.verification`: {status,currentSample,requiredSamples,intervalMs}; nunca dispara trabajo.

## Plan
- [x] Comparador puro y pruebas de posición, conjunto, identidad y apariencia.
- [x] Verificación explícita triple y pruebas de tiempo real, resultado atómico y ausencia de detección tras acciones.
- [x] Overlay con coordenadas en PNG/página controlada; panel con estado y progreso.
- [x] Adaptar pruebas existentes al nuevo contrato, revisar, regenerar ejemplos y actualizar el paquete.

La coincidencia en tres muestras comprueba la estabilidad observada en esos instantes; no garantiza que el sitio nunca cambie después.
