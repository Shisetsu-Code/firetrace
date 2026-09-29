# Firetrace 2: pruebas por ramas y evidencia

Firetrace expone 35 herramientas MCP. El agente 0.6 incorpora ejecución independiente
por navegador; el servidor comprueba las capacidades del agente antes de enviar
herramientas nuevas. Actualizar herramientas en ChatGPT después de instalar ambas partes.

## Flujo recomendado

1. `browser_list` y `browser_create` para disponer de sesiones demo aisladas.
2. `browser_open` para preparar cada cliente. Usar `headless:true` si no hace falta verlo.
3. `dom_snapshot` para botones/inputs accesibles, o `browser_screenshot` para canvas.
4. `browser_sequence` en un cliente, o `parallel_branches` para opciones distintas.
5. Consultar `command_result({id: job_id})` hasta finalizar. No volver a enviar la acción.
6. Recuperar imágenes con `artifact_get`; exportar evidencia con `history_export`.

Las herramientas de automatización de juegos son para demos/pruebas sin dinero
real ni premios con valor. El cliente debe conocer y preparar el entorno correcto.

## Ejemplo de secuencia

```json
{
  "browser_id": "ID_DE_BROWSER_LIST",
  "timeout_ms": 120000,
  "steps": [
    {"action":"capture_start","args":{"filters":{"method":["POST"],"path":["/api/"],"content_type":["json"]}}},
    {"action":"click_relative","args":{"rx":0.25,"ry":0.60}},
    {"action":"wait","args":{"ms":1000}},
    {"action":"screenshot"},
    {"action":"capture_stop"},
    {"action":"checkpoint","args":{"label":"opcion-a"}}
  ]
}
```

Se valida toda la secuencia antes de comenzar. Máximo 20 pasos, 120 segundos por
defecto y límite duro de 300 segundos. Cada paso tiene ID, tiempos y resultado.
Una captura devuelve artifact_id en vez de sobrescribir un archivo compartido.
El primer error detiene la rama y conserva los pasos completados.

## Ramas paralelas

```json
{
  "branches": [
    {"label":"opcion_a","browser_id":"ID_A","steps":[{"action":"click_relative","args":{"rx":0.25,"ry":0.60}},{"action":"screenshot"}]},
    {"label":"opcion_b","browser_id":"ID_B","steps":[{"action":"click_relative","args":{"rx":0.45,"ry":0.60}},{"action":"screenshot"}]}
  ],
  "timeout_ms":120000
}
```

Un ejecutor por sesión permite solapamiento real. Cada rama reserva su navegador:
una orden ajena devuelve session_busy, sin intercalarse entre clicks. No se asignan
dos ramas a la misma sesión. Un fallo no cancela las otras ramas. La cobertura
cuenta ramas completadas frente a solicitadas; no afirma descubrir todas las
opciones posibles. Las URLs, coordenadas y preparación son específicas de cada demo.

`job_cancel({job_id})` cancela pasos pendientes cooperativamente. Una acción en
curso puede haber ocurrido; cancelar no revierte efectos.

## Catálogo nuevo

| Herramientas | Uso |
| --- | --- |
| browser_sequence | Pasos ordenados en una sesión; devuelve job_id |
| parallel_branches | Secuencias etiquetadas en sesiones distintas |
| branch_matrix | Árbol finito; cada hoja reproduce su camino con setup_steps y precondition explícitos |
| spin_until | Repetir pasos hasta una condición declarada o un límite obligatorio |
| network_capture_window | start/stop/status de una ventana de captura |
| network_filter | Filtros para la siguiente captura, solo mientras no hay una activa |
| network_get_response_body | Cuerpo retenido por request_id; nunca repite la request |
| dom_snapshot / interactive_elements | Elementos por frame, texto/aria y bounding boxes; canvas como superficie |
| browser_click_element | Click por snapshot_id y element_id; rechaza identidades obsoletas |
| browser_inspect | Consultas document, frames y storage_names; sin JS arbitrario |
| iframe_list / iframe_open_direct | Identificar frames y abrir una URL HTTP(S) en una sesión nueva |
| request_replay | Reenviar una solicitud capturada desde su sesión y origen |
| request_replay_from_template | Ajustar method/url/headers/body de una solicitud capturada |
| validate_response | Comprobar status y body con paths y comparadores declarativos |
| session_context | Nombres/metadatos de cookies y referencias opacas de headers |
| state_checkpoint | Etiqueta + UI + screenshot + referencias de red; no restaura estado |
| history_export | JSON o Markdown saneado para Resultados |
| artifact_get | Recuperar una captura por ID sin tomar otra |
| job_cancel | Cancelación cooperativa |

Las herramientas existentes siguen disponibles. `network_events` devuelve eventos
retenidos de las ventanas de captura; no graba tráfico de forma permanente sin
haber iniciado una captura.

## Condiciones y matrices

Los paths usan puntos y números para arrays, por ejemplo `steps.0.result.ready_state`.
Comparadores: exists, equals, type, range, length. La ausencia es unknown, y detiene
spin_until. max_iterations: 1–100; timeout_ms: 1–300000. Alcanzar un límite no es éxito.
No se acepta `follow_until:"terminal"` sin una condición verificable.

branch_matrix admite hasta 100 nodos y profundidad 10, sin ciclos. Cada nodo tiene
label, parent opcional y steps. Cada raíz exige setup_steps y precondition; en los demás nodos son opcionales. Las hojas se
distribuyen por tandas entre los browser_ids disponibles. Preparar y verificar un
estado de inicio reproducible es responsabilidad del caso: copiar cookies no clona
RNG, memoria, sockets ni estado del servidor.

## Red, credenciales y replay

Filtros: método, dominio exacto, prefijo de path, resource_type y content_type.
Se combinan con AND entre campos y OR entre sus valores. Content-type se decide al
recibir la respuesta. Los cuerpos se retienen al finalizar, no se vuelven a pedir.

Máximo 200 solicitudes por captura, 1 MiB por cuerpo y 20 MiB de registros/cuerpos
por sesión, con caducidad de 15 minutos. Los binarios se omiten. Para no cargar
cuerpos de tamaño desconocido, respuestas comprimidas o sin Content-Length se
marcan unavailable_unbounded. El truncamiento o descarte siempre queda indicado.

Headers sensibles, parámetros de URL y claves JSON/formularios se sanean antes
de publicarse. Los cuerpos de formato desconocido se omiten. No se garantiza
detectar secretos arbitrarios escondidos en texto o nombres no convencionales.
Los originales de replay permanecen en memoria local; nunca van a D1/R2.

Replay usa fetch dentro del navegador, solo en el origen de la solicitud y de la
página actual. Rechaza redirecciones y no reintenta. Las cookies las añade Chromium;
un header capturado puede estar obsoleto. Firmas/nonces/streaming pueden requerir
repetir el flujo UI. Las plantillas se anclan a request_id y aceptan referencias
`{"$ref":"ID_DE_SESSION_CONTEXT"}` para headers conocidos. No se exportan valores
de cookies, secretos ni hashes. No hay detección mágica de todos los tokens.

## Evidencia, recuperación y límites

Un corte de WSS no vuelve a ejecutar la acción. El agente retiene resultados no
confirmados y los reenvía; el control confirma su almacenamiento. Si el proceso
se reinicia, los jobs y cuerpos locales se pierden: un ID desconocido no autoriza
repetir un efecto incierto. Perfiles persistentes conservan datos del sitio, no jobs.

Artefactos: máximo 1 MiB cada uno, 20 MiB por sesión, TTL 15 minutos. Evidencia de
rama: 128 KB; agregado de trabajo: 512 KB; exportación: 1 MiB. Se indican las
omisiones; para más detalle usar capturas pequeñas y lotes cortos. Hasta 100 jobs
retenidos durante 15 minutos. Hasta 100 sesiones registradas por ejecución del agente.

history_export relaciona pasos, tiempos, ramas y solicitudes/respuestas de las
capturas retenidas. Si ya expiraron o la sesión está ocupada, lo informa. Devuelve
contenido JSON/Markdown; no escribe directamente en una carpeta Resultados cuya
ruta no se haya indicado.

No hay nuevas conexiones WSS por ventana ni streaming de vídeo. El historial de
trabajos vive localmente y se consulta bajo demanda, evitando escrituras periódicas
de progreso en D1. Consultar resultados con moderación mientras la tarea está activa.

El paso capture_read recupera la última respuesta de la captura activa como JSON.
Una condición como steps.3.result.body.terminal permite detener spin_until según
la respuesta de la demo. command_result incluye progreso del paso en curso.
