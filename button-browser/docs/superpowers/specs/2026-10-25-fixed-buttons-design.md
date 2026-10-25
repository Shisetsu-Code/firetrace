# Botones fijos

## Objetivo

Guardar botones existentes que el usuario declara fijos y reutilizar sus nombres, recuadros y puntos de clic. La lista persiste y se muestra junto a los controles detectados.

## Decisiones de implementación

- Catálogo de datos JSON y miniaturas propias, fuera de la retención de observaciones. IDs permanentes `f1`, `f2`, etc.
- `pin b1 Nombre` guarda desde una observación estable vigente. `pins` lista; `rename f1 Nombre` renombra; `unpin f1` elimina; `click f1` usa la posición guardada.
- El guardado copia el punto de clic exacto y el recorte de la observación; no ejecuta otra detección ni vuelve a capturar.
- Contexto por URL canonicalizada y parámetros de juego, viewport, DPR y scroll. Los datos sensibles de URL no se guardan. No se reescalan posiciones.
- Un clic fijo comprueba contexto y recorte antes de enviar el input. No ejecuta tres lecturas, no consulta visión y no recalcula la posición.
- Los fijos aparecen en azul como posiciones guardadas. `fixedButtons` permanece separado de `observation.buttons`; la verificación dinámica conserva su contrato.
- En Actions, el catálogo se conserva en la evidencia de su sesión. `fixedButtonsFrom` permite restaurar un catálogo de otra sesión sin ampliar el permiso de escritura fuera de la sesión actual.

## Alternativas consideradas

Sólo una lista en memoria perdería los registros al reiniciar. Mezclar fijos con las posiciones dinámicas haría ambiguo cuáles pasaron la última verificación. Se elige una lista persistente separada, integrada en la misma interfaz y transporte de comandos.

## Comprobación

Pruebas con navegador real: guardar, capturar, reiniciar y usar sin nuevas lecturas; rechazo por contexto o recorte cambiado; protección de miniaturas; separación de una verificación inestable; lista y marcación en el panel. No es necesaria otra sesión del juego para validar la persistencia y el contrato de comandos.
