# Conectar GitHub Actions al MCP Firetrace existente

El workflow `.github/workflows/remote-mcp.yml` crea un Chromium temporal en GitHub
Actions y conecta su agente por WSS al servicio Cloudflare de control
`shisetsu-browser-control`. El MCP OAuth existente en
`https://firetrace-mcp.braian-n-l.workers.dev/mcp` controla el agente
con identificador `firetrace`, sin ejecutar navegadores en la PC.

## Requisitos en GitHub

En el repositorio `Shisetsu-Code/firetrace`, ir a **Settings > Secrets and
variables > Actions > New repository secret** y configurar:

- `CF_CONTROL_URL`: dirección pública HTTPS del relay
  `shisetsu-browser-control` que acepta conexiones `/ws?agent_id=firetrace`.
  NO usar aquí la URL del MCP OAuth.
- `CF_CONTROL_TOKEN`: secreto autorizado por ese relay para agentes WSS.
  No compartirlo en el chat, ni subirlo a archivos o commits.

Los secretos deben coincidir con los existentes del servicio de control
Cloudflare, no con la contraseña OAuth `MCP_PASSWORD`.

## Ejecución

Desde Actions, elegir **Firetrace MCP Remote Agent > Run workflow**. También
se inicia al actualizar `remote/mcp-start.json`. GitHub hospedará Chromium
hasta 115 minutos de sesión (el job tiene límite 120 minutos); esto NO es un
servicio persistente. El grupo de concurrencia evita dos agentes remotos.

En el chat con Firetrace conectado, llamar primero `browser_status`:
debe indicar `connected=true` y backend `local-playwright-cdp`.
Luego usar `browser_open`, `browser_screenshot`, `browser_click`,
`trigger_and_capture`, etc. Para HAR, el agente admite las acciones
`record_start`, `record_status`, `record_save`, pero el adaptador
Cloudflare MCP actualmente no publica estas tres como herramientas;
necesita su correspondiente actualización/despliegue o pueden enviarse
mediante el canal de comandos que las soporte.

**No usar a la vez un Firetrace local y uno de GitHub con el mismo agent_id**.
La conexión remota no debe confundirse con el agente local HardFire:
HardFire no funciona automáticamente dentro de este workflow.

## Estado probado

La ejecución GitHub Actions 40191375939 fue creada y llegó hasta la etapa
`Check relay credentials`, que falló porque faltaba al menos uno de los
secretos. No hubo conexión WSS ni navegación MCP confirmada.

GitHub no revela el contenido de secretos desde esta integración.
