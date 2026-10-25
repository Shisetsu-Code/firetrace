# Prueba real de Play’n GO en GitHub Actions

## Objetivo autorizado

Ejecutar Button Browser en GitHub Actions, abrir una demo pública real de Play’n GO, superar las pantallas de carga e introducción y comprobar la verificación de tres muestras, las coordenadas y los clics dentro del juego.

## Ejecución

- Repositorio: Shisetsu-Code/firetrace, rama codex/button-browser-playngo-20261025.
- Paquete aislado en button-browser/ y workflow dedicado; los otros navegadores del repositorio conservan sus sesiones.
- Juego inicial: Rise of Olympus Origins, usando el enlace de demostración publicado por Play’n GO con practice=1.
- Chromium en un runner Ubuntu. Una sesión acepta órdenes explícitas por archivo; el coordinador inspecciona las capturas y el resultado antes de elegir cada acción.
- La primera orden abre la URL configurada. Las lecturas de botones requieren verify; no hay detección, reintentos ni clics automáticos al esperar o cargar.
- Se guarda la evidencia de cada paso, el estado estable/inestable y el historial de comandos. La sesión se cierra al recibir stop o al llegar al límite de tiempo.

## Criterio de éxito

No basta con descargar el HTML ni obtener una captura de carga. Debe verse el tablero del juego, obtener controles reales con tres lecturas estables y confirmar visualmente al menos una interacción dentro del juego. El informe final distinguirá los pasos ejecutados de los que queden bloqueados.
