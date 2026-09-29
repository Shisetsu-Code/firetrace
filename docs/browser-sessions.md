# Ventanas y perfiles de Firetrace

Firetrace permanece conectado aunque no haya ventanas. ChatGPT puede llamar a
`browser_create` varias veces para trabajar con varios programas al mismo tiempo.
Cada ventana usa un proceso Chromium y un contexto independientes, sin conexión
automática al Chrome personal ni al antiguo puerto CDP 9222.

- `browser_create({mode:"temporary"})`: nueva ventana sin datos previos.
- `browser_create({mode:"persistent",profile:"programa-a"})`: crea o recupera
  ese perfil. No se puede abrir el mismo perfil dos veces simultáneamente.
- `browser_list({})`: IDs, ventanas abiertas/cerradas, perfiles guardados y límite.
- `browser_close({browser_id:"..."})`: cierra únicamente esa ventana.
- `browser_reopen({browser_id:"..."})`: reabre una ventana cerrada; las temporales
  comienzan limpias y las persistentes conservan los datos de su perfil.

Usar el `browser_id` devuelto en navegación, clics, esperas, capturas y tráfico de
red. Si hay varias ventanas abiertas, omitirlo devuelve un error; no se elige una
ventana arbitrariamente. No se reejecutan clics ni se reabre automáticamente una
ventana cerrada al intentar hacer clic.

Los IDs viven durante la ejecución del agente. Después de reiniciarlo, consultar
los perfiles guardados con `browser_list` y abrirlos por nombre con `browser_create`.
Se conservan cookies persistentes y almacenamiento del sitio; no se promete
restaurar las pestañas, formularios sin guardar ni el estado en memoria de una web.

Configuración local, mediante variables de entorno del usuario de Windows:

| Variable | Predeterminado |
| --- | --- |
| `FIRETRACE_MAX_BROWSERS` | `4`, configurable entre 1 y 32 |
| `FIRETRACE_PROFILE_DIR` | `%LOCALAPPDATA%/Firetrace/profiles` |

Reiniciar Firetrace después de cambiar estas variables. Cerrar Firetrace Control
detiene el agente y sus ventanas; cerrar solamente una ventana del navegador deja
el agente disponible. Los perfiles persistentes permanecen en el equipo, fuera
del repositorio. El aislamiento separa datos del navegador; comparten usuario del
sistema operativo y conexión de red. Las páginas funcionan simultáneamente; las
órdenes mantienen su orden dentro de cada sesión; parallel_branches ejecuta sesiones distintas en paralelo.

Tras actualizar el Worker remoto, actualizar la lista de herramientas de la
conexión de ChatGPT. El servidor ahora publica 35 herramientas.

## Si GPT no encuentra las herramientas nuevas

Abrir Firetrace en [ChatGPT Plugins](https://chatgpt.com/plugins), pulsar
**Refresh / Actualizar** y comprobar que aparecen `browser_create`, `browser_list`,
`browser_close` y `browser_reopen`, habilitadas. Después iniciar un chat nuevo y
seleccionar Firetrace. La dirección debe ser
`https://firetrace-mcp.braian-n-l.workers.dev/mcp`.

Prueba sugerida: «Usá Firetrace: primero browser_list y después browser_create
para abrir dos ventanas temporales independientes».

La guía del repositorio no actualiza el catálogo de una conexión ya creada. El
MCP transmite las descripciones en `tools/list` y el flujo de uso en
`initialize.instructions`; la actualización de la conexión importa esos cambios.
Si siguen apareciendo menos de 35 herramientas, no se importó el catálogo nuevo.

[Procedimiento oficial de actualización](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

## Aceleración gráfica (agente 0.6.1)
Las sesiones temporales y persistentes usan Chromium completo y --enable-gpu, también en headless. Chromium conserva sus comprobaciones de compatibilidad: el hardware y el controlador determinan la aceleración disponible. Verificado en Windows con RX 6800 XT: WebGL por Direct3D11 en ambos tipos de sesión. No acelera todo el JavaScript ni elimina el consumo de CPU. Requiere la distribución completa instalada mediante playwright install chromium.

