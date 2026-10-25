# Firetrace Remote: Chromium en GitHub Actions, sin PC

Esta variante funciona por completo en GitHub: Chrome/Playwright se ejecuta
en un runner efímero, y ChatGPT envía comandos mediante el conector GitHub.
No requiere Cloudflare ni credenciales de la PC. No sustituye la integración
existente Firetrace/HardFire, que permanece intacta.

## Arranque

Crear el archivo remote/start.json en la rama main utilizando
remote/start.example.json como plantilla. Cambiar session_id en cada ejecución.
El cambio inicia el workflow Firetrace Remote Browser.

El job publica el archivo
remote/sessions/SESSION/results/_boot.json cuando está conectado al repositorio.

Puede durar entre 5 y 120 minutos y termina al superar la inactividad indicada
(60 a 1800 segundos), al enviar stop o por la duración máxima del job (125 min).
GitHub Actions no proporciona servidores permanentes ni continuidad de la misma
pestaña después del cierre.

## Comandos desde ChatGPT

Crear un archivo NUEVO con identificador único en:
remote/sessions/SESSION/inbox/COMMAND.json

Ejemplo:

~~~json
{"session":"demo-20261025-001","id":"cmd-001","action":"open",
 "args":{"url":"https://www.pragmaticplay.fun/en/slots/death-dominion/"}}
~~~

El runner publica una respuesta en:
remote/sessions/SESSION/results/COMMAND.json

Esperar ese resultado antes de repetir o encadenar acciones con efectos.
Si el resultado es incierto, consultar el MISMO ID; no duplicar clicks.

Acciones:
- status: estado del navegador y run_id de Actions
- open: args.url (HTTPS, dominio autorizado)
- screenshot: args.quality opcional, JPEG en data.image_base64
- inspect: frames, texto y controles HTML visibles
- click: args.x y args.y en pixels
- click_relative: args.rx y args.ry entre 0 y 1
- wait: args.ms (máximo 10000)
- record_status: contadores HTTP/WS
- record_start: comienza/continúa HAR
- network_report: checkpoint HAR y resumen endpoints; reanuda captura
- record_save: guardar HAR y dejar de grabar
- trigger_and_capture: args.url_contains, rx, ry y wait_ms
- note: args.text y args.tags para registrar observaciones
- stop: finalizar sesión y subir artefactos sanitizados

La captura de red comienza automáticamente al iniciar el navegador. Las
capturas del juego se guardan después de abrir una página o pulsar un control.
La exploración visual debe usar una observación actual antes del siguiente clic.

## Artefactos y documentación

El workflow publica un ZIP firetrace-evidence-RUN_ID, por 7 días:
- events.jsonl: acciones, tiempos, notas y respuestas
- screenshots/frame-NNN.jpg: evidencia visual por acción
- captures/capture-NNN.har: HTTP, headers, payloads y frames WS disponibles
- captures/capture-NNN.json: métodos, endpoints, estados y ejemplos sanitizados

El HAR sólo cubre eventos observados por CDP en la página seleccionada.
Iframes cross-origin/OOPIF y ventanas nuevas pueden requerir captura adicional.
No confundir un clic enviado con una compra completada.

## Restricciones de seguridad

EL REPOSITORIO ES PÚBLICO. Todos los comandos, URLs, resultados y capturas
publicadas como base64 son legibles en el historial de Git. Usar exclusivamente
demos autorizadas, sin login, sin saldo real y sin datos confidenciales.

Los HAR originales viven temporalmente en el runner; solo se guardan en los
artefactos copias con redacción de claves comunes (tokens, claves, cookies,
autorizaciones y campos de sesión). Los cuerpos binarios se omiten. Esto es
una mitigación best-effort, NO una garantía completa de eliminación de secretos.
No usar con cuentas, identidades ni sistemas internos.

La lista allowed_hosts limita la navegación principal a dominios admitidos.
No actúa como filtro completo de subrecursos externos cargados por la página.
Para una versión privada de producción, usar control WSS Cloudflare + R2
privado detrás de OAuth. La versión publicada de Firetrace MCP no se modifica.

## Límites

Los archivos de Git introducen varios segundos de latencia por interacción.
El flujo depende de que Actions tenga permiso contents:write y disponibilidad
de runners. Cada sesión es efímera y finaliza cuando expira, queda inactiva,
se cancela el workflow o llega stop.
