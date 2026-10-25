# Botones fijos: uso y persistencia

## Guardar botones existentes

1. Abrí la página o juego y solicitá `verify`.
2. En un control verificado, elegí su nombre y pulsá **Guardar fijo**, o enviá `pin b1 Giro`.
3. Conservá el ID devuelto, por ejemplo `f1`. El nombre se puede modificar sin cambiar el ID.
4. Usá `click f1` cuando corresponda. El controlador comprueba contexto y recorte, sin detectar otra vez ni cambiar la posición.

El usuario elige qué controles considera fijos. El programa no fija todos los controles automáticamente. No utiliza como actuales las coordenadas de una sesión de prueba anterior.

```json
{
  "commandId": "guardar-giro-001",
  "command": {
    "action": "pin",
    "id": "b1",
    "name": "Giro principal",
    "observationId": "ID_DE_LA_OBSERVACION_ESTABLE_VIGENTE"
  }
}
```

Para listar, renombrar, utilizar o quitar:

```json
{"command": {"action": "pins"}}
{"command": {"action": "rename", "id": "f1", "name": "Giro normal"}}
{"commandId": "usar-giro-001", "command": {"action": "click", "id": "f1"}}
{"command": {"action": "unpin", "id": "f1"}}
```

El panel ofrece **Exportar lista**, que descarga el catálogo actual como `{ "fixedButtons": [...] }`, incluso si no hay una observación dinámica. Es una exportación de datos; no inicia una verificación.

## Qué se conserva

Cada registro contiene ID permanente, nombre elegido, etiqueta original, tipo y fuente original, recuadro, centro, punto de clic exacto, coordenadas normalizadas, contexto, fechas y referencia a la observación de origen. La miniatura se copia a almacenamiento propio. El contador de IDs no reutiliza los eliminados.

El contexto distingue la identidad de la URL —incluido el juego indicado en sus parámetros—, ancho y alto del viewport, DPR y scroll. Sólo se guarda un hash de esa identidad y una etiqueta pública limitada; no se guardan tokens de sesión. Cambiar de juego, tamaño o scroll deja el registro en la lista pero impide utilizarlo. No hay reescalado automático.

Los fijos se marcan en azul como `Fijo · fN`. `verification: "user-fixed"` significa posición guardada por decisión del usuario, no verificación reciente. Un resultado dinámico inestable conserva `buttons: []` aunque existan fijos en su campo separado.

La comprobación del clic compara el recorte en la posición guardada con una captura actual. Usa el umbral visual existente de 0,015. Un modal, una carga, un control cambiado o una animación que altere ese recorte pueden bloquear el clic. No se invoca un detector ni se buscan coordenadas alternativas.

## Almacenamiento del servicio

Por defecto, el catálogo está en `data/observations/fixed-buttons/index.json`, con `f1.png`, `f2.png`, etc. Queda fuera de la eliminación de las últimas 12 observaciones. Puede cambiarse con `BUTTON_BROWSER_FIXED_DATA` o con la opción `fixedButtonDir` del controlador.

Conservá ese directorio en un volumen persistente al desplegar. El catálogo admite 200 registros. Las escrituras del índice son atómicas; un archivo inválido se reporta y se conserva sin sobrescribirlo silenciosamente.

Los recursos `/artifacts/fixed/fN.png` usan la misma autorización que los demás recortes. Un registro borrado deja de estar disponible aunque alguna evidencia histórica conserve su imagen.

## GitHub Actions

El runner guarda el catálogo en `button-browser/ci-results/<sessionId>/fixed/index.json` y los PNG en esa misma carpeta. Los incluye en checkpoints y en el artefacto de evidencia, incluso si el comando de guardado no produjo una captura nueva.

Una sesión posterior puede cargarlo mediante `ci/start.json`:

```json
{
  "sessionId": "nueva-sesion",
  "gameURL": "https://sitio.example/ContainerLauncher?gid=juego",
  "fixedButtonsFrom": "sesion-anterior"
}
```

La sesión de origen debe contener un catálogo generado con esta versión. La prueba histórica `playngo-rise-20261025-03` es anterior a esta función y no contiene ese catálogo.

Se valida el índice y cada miniatura antes de abrir el navegador. La restauración rechaza rutas inválidas, enlaces simbólicos, imágenes ausentes y catálogos dañados. El runner continúa escribiendo únicamente dentro del prefijo de su propia sesión; no modifica el catálogo histórico de origen.

## Alcance de esta entrega

Se verifica con Chromium local, pruebas del almacenamiento, del panel y del runner. La prueba anterior del juego real permanece documentada por separado en [Play’n GO en Actions](playngo-actions-test.md). Esta función no vuelve a abrir juegos ni ejecuta giros por sí sola.
