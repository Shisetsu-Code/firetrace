# Verificación de la entrega 1.1

Fecha: 25 de octubre de 2026.

Este documento conserva la validación de la entrega inicial. La prueba posterior con un juego real en GitHub Actions y la suite ampliada de **67/67 pruebas** están documentadas en el [informe de Rise of Olympus Origins](playngo-actions-test.md).

## Resultado de la entrega inicial

`npm test`: **59 pruebas aprobadas, 0 fallos, 0 omitidas**, código de salida 0. Duración observada de la última ejecución completa: 84,22 segundos. Node 24.22.1, Playwright 1.56.1 y Chromium 141.0.7390.37. Las pruebas usan navegador real con páginas y escenas controladas.

## Cobertura comprobada

- Verificación a pedido: sólo verify y sus alias inician detección. Hay tres lecturas con pausas reales de 2000 ms; navegar, hacer clic y pedir snapshot no vuelven a llamar al detector.
- Estabilidad: todos los pares de muestras, cambios en la segunda muestra aunque la tercera vuelva al inicio, desplazamiento gradual, conjunto/identidad/etiquetas/estado, puntos de clic y apariencia de cada control. Correspondencia visual con etiquetas repetidas y orden variable. Entradas incompletas o malformadas se rechazan.
- Publicación: las muestras intermedias no exponen coordenadas; un resultado inestable no guarda recortes de candidatos. La navegación durante la preparación descarta las posiciones, y una navegación de iframe elimina las etiquetas anteriores y el estado estable.
- Coordenadas visibles: texto ID/x/y, marcador en clickPoint, etiquetas dentro del viewport, texto escapado, PNG coherente con el JSON y overlay que no captura clics ni altera el layout o el detector.
- DOM: controles normales, Shadow DOM abierto, exclusión de invisibles/deshabilitados/tapados.
- Geometría: iframe de otro origen con borde y escala, iframe parcialmente fuera de pantalla, recortes por overflow, transformación a píxeles CSS y tamaño del PNG.
- PixiJS 6.5.2 real: escena sin global exportado, resolución 2×, escala CSS, z-order, máscaras, controles deshabilitados, nombres Megaton, polígonos y descarte de contenedores interactivos sin manejador.
- Clics: botón DOM, botón Pixi cuyo centro geométrico cae fuera de su polígono, aparición de una superposición, movimiento del objetivo, observación vencida y listener de un solo uso. La guarda DOM comprueba exclusivamente el punto verificado, incluso con desplazamiento de 0,75 px y un bloque de 1 px que lo tapa; no busca otra posición.
- Comandos/API: navegación, teclado, resize, caché de commandId, conflicto de payload, token, acceso a recortes, rechazo de origen distinto.
- Fallos parciales: la acción se ejecuta una vez y, si falla la captura siguiente, se borra la observación vigente y se informa que debe solicitarse verify antes del próximo clic por ID.
- Visión: protocolo HTTP compatible, envío de imagen, validación de cajas, límites, timeout y errores sin filtrar claves. Endpoint de prueba local; no se evaluó un modelo VLM externo.
- CLI: texto, JSONL, envelopes, token, IDs, resultados por stdout, errores y ausencia de reintentos.

## Prueba del panel

Chromium real, escritorio y móvil: navegación a `/demo` sin coordenadas; progreso real 1/2/3; publicación de seis recortes, etiquetas x/y y marcadores sólo al terminar las tres muestras. Clic por ID seguido de estado sin verificar, alias detect/observe, cambio de posición entre lecturas con resultado inestable, resultado estable de cero controles, descarte de una respuesta GET antigua y recuperación parcial mediante snapshot sin repetir el clic. Sin errores JavaScript ni desborde horizontal. Se verificaron 31 solicitudes de imagen autenticadas con Bearer. Los servidores temporales de pruebas quedaron cerrados.

## Evidencia de salida

`examples/output/` contiene seis recortes, la captura original, la captura con ID y coordenadas, la lámina de botones y `observation.json`, obtenidos ejecutando verify sobre la página de prueba con viewport 1280×720. Los intervalos entre los timestamps de las tres capturas de este ejemplo fueron 2116 y 2107 ms: incluyen el trabajo de lectura, además de las pausas de 2000 ms. Los enlaces del JSON de ejemplo se hicieron relativos para permitir su traslado. `examples/panel.png` muestra el panel real en estado estable 3/3.

## Uso del HAR aportado

El HAR tiene 104 entradas y permitió identificar Play’n GO Rise of Olympus Origins con PixiJS 6.5.2/Megaton. En una reproducción estrictamente offline se recuperó un canvas Pixi del juego. La carga se detuvo antes del menú: el HAR no contiene los mensajes WebSocket necesarios para reconstruir la inicialización de la partida. No se enviaron solicitudes a servidores reales, no se hicieron clics ni giros y no se afirma validación de todos los botones del juego vivo.

## Límites de la verificación

La estabilidad se comprueba en tres instantes; no garantiza que el sitio no cambie entre muestras ni después. Se admite hasta 1 píxel CSS de variación geométrica y una diferencia media de apariencia de 0,015 sobre escala 0–1. La prueba valida el detector y el control con el motor real, no la compatibilidad universal con todos los juegos. La detección visual depende del modelo configurado y produce estimaciones. El Dockerfile y Compose se revisaron pero no se ejecutó una compilación Docker porque el entorno no tiene Docker. La ejecución del proceso Node, el panel y la API sí se comprobaron de extremo a extremo. No se publicó ni desplegó un servicio remoto.
