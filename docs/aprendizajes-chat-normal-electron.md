# Firetrace, Chat normal y HardFire: aprendizajes

Memoria de la integración comprobada el 2 de octubre de 2026. Véase [Resume](https://github.com/Shisetsu-Code/Resume/blob/main/knowledge/browser-mcp-lessons.md) para el historial común y [la guía HardFire](https://github.com/Shisetsu-Code/HardFire/blob/main/docs/electron-firetrace-chat-normal.md) para ejemplos.

## Separar los dos navegadores

En el entorno probado, la conexión remota Firetrace MCP 2.1.0 publicó 61 herramientas, incluyendo el adaptador `hardfire_*` hacia el agente HardFire 1.5.1. `browser_*` siguió controlando el navegador propio de Firetrace; `hardfire_*` controló Electron. Esta memoria no despliega ni incorpora esa implementación a la versión de código presente en esta rama.

`browser_status` con `connected:true` sólo demuestra la conexión Firetrace. Para Electron, consultar `hardfire_status` y comprobar backend `hard-browser-electron-cdp`. Los agentes tienen estados distintos; `browser_id` no es un `tab_id`.

## Dos fallos, dos correcciones

Primero las herramientas estaban presentes pero el agente Firetrace no estaba conectado. Iniciar el agente autorizado recuperó navegación desde Chat normal. Después, el servidor publicó HardFire pero el chat seguía viendo el catálogo anterior de 14 herramientas. Refresh de la conexión remota correcta permitió usar Electron.

No resolver un catálogo antiguo reiniciando indiscriminadamente navegadores, modificando varios proyectos o instalando un paquete distinto de igual nombre. Comprobar por separado catálogo autenticado del servidor y catálogo recibido por el chat.

## Transporte y operación

La integración reutilizó MCP autenticado y relay WSS existentes en Cloudflare. El navegador estuvo en el PC, pero comandos, resultados y capturas atravesaron ese transporte remoto. No equivale a una conexión exclusivamente localhost. No se añadió un nuevo túnel.

El agente debe permanecer iniciado. El bridge puede arrancar Electron cerrado, pero no un agente apagado que no recibe órdenes. Heartbeat y reconexión no autorizan repetir una acción cuyo resultado es incierto. Consultar `hardfire_command_result` por ID cuando corresponda.

## Evidencia y límites

Chat normal abrió la página oficial de Sweet Bonanza en Electron, comprobó título y recibió JPEG. Una primera visualización de imagen falló y una segunda lectura funcionó. No hubo apuestas, compras ni tiradas. Probar la página no prueba cargar la demo interactiva.

No publicar tokens, registros completos ni capturas privadas para guardar evidencia. Mantener versiones e identidades reales y distinguir código publicado de instalación local. Quedan pendientes persistencia tras reinicio, medición de latencia y una prueba HAR HTTP/WS específica desde Chat normal.
