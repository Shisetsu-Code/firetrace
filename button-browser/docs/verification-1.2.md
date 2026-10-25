# Verificación de Button Browser 1.2

Fecha: 25 de octubre de 2026.

## Resultado

`npm test` terminó con **97 pruebas aprobadas, 0 fallidas, 0 omitidas**, código de salida **0**, en **126,759 segundos**. Entorno local con Node.js 24.22.1, Playwright 1.56.1 y Chromium real. Se incorporaron 30 pruebas a las 67 existentes.

## Botones fijos comprobados

- Guardado desde una observación estable vigente; rechazo de observaciones vencidas, inestables o de ID incorrecto.
- Persistencia de nombre, ID, recuadro y punto de clic exacto. Miniaturas independientes del borrado de observaciones antiguas.
- Listado, cambio de nombre y eliminación; IDs eliminados no se reutilizan.
- Uso después de reiniciar el controlador, sin volver a ejecutar los detectores.
- Separación por juego, parámetros de URL, viewport, DPR y scroll. El cambio de token de sesión no mezcla juegos ni obliga a guardar credenciales.
- Rechazo de clics cuando un elemento cubre el recorte o cambia la apariencia del destino.
- Un resultado dinámico inestable mantiene `buttons: []`, mientras los fijos conservan su identificación separada `user-fixed`.
- Miniaturas protegidas por el token del servicio; eliminación de acceso al quitar el registro.
- Un fallo al dibujar la marcación no convierte una modificación ya guardada en un error ambiguo que invite a repetirla.

## Concurrencia y frescura

Se reprodujeron y corrigieron seis condiciones de carrera: listado atrasado después de invalidar el contexto, lectura HTTP con una observación antigua, navegación entre PNG y metadatos, scroll durante una muestra, navegación durante la lectura del contexto y recarga de la misma URL durante la última comprobación del clic.

Las regresiones fallaron antes de las correcciones y pasaron después. Un listado no modifica el contexto del controlador; la captura y su identidad deben corresponder a la misma página. Un cambio durante la captura la rechaza sin detectar ni reintentar automáticamente.

## Panel

Prueba con Chromium de guardar, renombrar, usar, quitar y exportar el catálogo; recortes con Bearer; persistencia al recargar; fijos azules sobre capturas sin verificación dinámica; bloqueo visual por contexto incompatible; escritorio y móvil sin desborde horizontal.

Además, se realizó una comprobación de extremo a extremo con el panel conectado al servicio real y a su página `/demo`:

1. Abrir la página desde el panel y solicitar una verificación.
2. Guardar «Continuar» como `f1`, con nombre «Continuar fijo».
3. Pedir `snapshot`: cero botones dinámicos y un fijo disponible.
4. Pulsar **Usar f1** desde la lista.
5. Confirmar `Continuar: 1 clic(s)` en la página controlada.

Resultado: **tres lecturas del detector en total**, todas pertenecientes a la verificación inicial; guardado, captura y clic fijo no añadieron lecturas. Punto conservado: **x 210,59; y 248,59** en el viewport de la demo. No hubo errores JavaScript.

## Runner de Actions

Nueve pruebas del runner cubren catálogo vacío inicial, checkpoints con miniaturas, guardado sin nueva observación, renombrado y eliminación, reintento de checkpoint sin repetir el comando, referencias públicas, estado no disponible durante una acción y restauración validada desde una sesión anterior.

Se conserva el límite de escritura dentro de la sesión actual. La restauración rechaza rutas inválidas, enlaces simbólicos, imágenes ausentes y catálogos corruptos.

Estas comprobaciones del runner se ejecutaron localmente con entradas y almacenamiento controlados. El recorrido previo del juego real en Actions está documentado en [la prueba de Play’n GO](playngo-actions-test.md); corresponde a la versión anterior a los botones fijos.

## Uso

Ver [comandos y persistencia](fixed-buttons.md). El usuario elige los controles fijos; el catálogo inicial no incorpora automáticamente botones de juegos anteriores. La posición guardada se conserva y su recorte se comprueba al solicitar el clic.
