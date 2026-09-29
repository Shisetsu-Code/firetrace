# Firetrace: pruebas paralelas y evidencia reproducible

Estado: propuesta para revisión; estas capacidades aún no están implementadas.

## Objetivo acordado

Reducir los viajes MCP al probar distintas opciones de una interfaz y obtener
evidencia etiquetada por rama. Uso exclusivamente en demos o pruebas, sin dinero
real ni premios de valor. Mantener navegadores aislados, perfiles persistentes y
headless, además del WebSocket compartido y la hibernación de Cloudflare.

## Situación actual comprobada

El agente ejecuta órdenes en serie. Worker.execute ya admite una secuencia interna
de hasta 20 pasos, pero no existe browser_sequence en el catálogo MCP. Las capturas
de secuencia usan un archivo compartido latest.jpg: no sirve para ramas concurrentes.
La captura CDP actual se abre alrededor de un click y se descarta al terminar.
No hay almacén de respuestas consultable después. La redacción actual cubre algunos
headers, pero no secretos dentro de URL o body. Playwright síncrono pertenece al
hilo donde se creó: no basta con lanzar sus métodos en un pool de hilos cualquiera.

## Arquitectura recomendada

Un ejecutor propietario por sesión, con su propia instancia Playwright síncrona y
cola serial. Un coordinador distribuye ramas entre esos ejecutores; nunca ejecuta
dos secuencias simultáneas en la misma sesión. Un hilo de transporte mantiene el
WebSocket y el heartbeat; los ejecutores publican resultados mediante una cola.
El estado periódico usa snapshots internos y no invoca Playwright desde otro hilo.

Alternativas consideradas: mantener el ejecutor serial solo reduce viajes MCP,
pero no proporciona paralelismo; migrar todo a Playwright async facilita concurrencia
pero amplía considerablemente el cambio. Los ejecutores por sesión permiten conservar
las operaciones síncronas existentes y probar el aislamiento de cada una.

La GUI permanece en su hilo actual. No se abren consolas ni se crea una conexión
Cloudflare por navegador. Límite inicial de concurrencia: el límite de navegadores
configurado, cuatro por defecto. Una cola acotada rechaza trabajo adicional con un
error explícito; no guarda acciones para ejecutarlas silenciosamente mucho después.

## Primera entrega: seis prioridades y sus dependencias

### browser_sequence

Una sesión, pasos ordenados y etiquetados: open, click, click_relative,
click_element, wait, screenshot, capture_start, capture_stop y checkpoint.
Máximo 20 pasos y 120 segundos por defecto, límite duro de 300 segundos. Validar
toda la estructura antes del primer efecto. Error detiene la secuencia por defecto
y devuelve los pasos completados. Las capturas tienen artifact_id y step_id propios;
no comparten latest.jpg. Capturas múltiples se recuperan por ID sin repetir acciones.

### parallel_branches

Cada rama declara label, browser_id y steps; una opción adicional permite asignar
en orden una lista de ramas a browser_ids distintos y disponibles. Rechazar IDs
duplicados dentro del lote, etiquetas repetidas y sesiones ocupadas antes de comenzar.
No trasladar automáticamente una rama a otra sesión si falla su navegador.
Devolver job_id de inmediato para operaciones largas; consultar progreso y resultados
con command_result. Incorporar cancelación cooperativa: cancelar los pasos pendientes,
esperar que termine o venza la acción en curso y devolver evidencia parcial.

Un error de una rama no detiene las demás por defecto. Cada resultado incluye
browser_id, label, estado, pasos, capturas, solicitudes y motivo de terminación.
Mostrar cobertura completadas/solicitadas y fallidas; no declarar N/N cuando faltan
ramas o se alcanzó un límite. No inferir que etiquetas A/B/C prueban todos los modos
posibles del juego.

### network_capture_window, network_filter y network_get_response_body

Captura start/stop/status con capture_id ligado a browser_id. La ventana puede
abarcar una secuencia completa. Filtros estructurados por método, dominio exacto,
prefijo de path, resource_type y content_type; combinar campos con AND y valores
dentro de un campo con OR. Sin regex arbitrarias. Content-type se decide cuando
llega la respuesta. Incluir solicitudes fallidas e incompletas como tales.

Guardar metadata y cuerpos finalizados con request_id propio y único por sesión,
sin depender de que el ID CDP continúe disponible después. Capturar el cuerpo al
finalizar la respuesta y entregarlo bajo demanda. Límites iniciales: 200 solicitudes
por captura, 1 MiB por cuerpo, 20 MiB por sesión y expiración a los 15 minutos.
Informar truncamiento, descarte, caducidad y cuerpos no disponibles; no simular vacío.
Evitar binarios por defecto y retornar metadata. La captura debe cerrarse también
ante cancelación, error o cierre del navegador.

Antes de devolver evidencia al MCP o almacenarla en Cloudflare, redactar headers,
parámetros de URL y claves sensibles de JSON/formularios; los cuerpos no reconocidos
no se publican completos por defecto. Los originales necesarios para replay se
mantienen localmente, con el mismo límite y caducidad. No prometer detección perfecta
de secretos dentro de formatos arbitrarios.

### dom_snapshot / interactive_elements y browser_click_element

Snapshot por frame con snapshot_id, URL saneada, texto/aria acotado, rol, tipo,
visible/enabled y bounding box en coordenadas del viewport principal cuando pueda
calcularse. Registrar handles locales asociados a element_id y a la generación de
navegación. Al cambiar documento, invalidar los IDs. Antes del click comprobar que
el elemento sigue conectado y accionable; si está obsoleto pedir otro snapshot,
sin recurrir silenciosamente a coordenadas antiguas.

Enumerar canvas como superficies con bounding box; no inventar botones internos ni
afirmar que el DOM revela sus opciones. La interpretación visual la hace GPT sobre
la captura, y la rama conserva snapshot/captura de origen como evidencia.

### spin_until

Ejecutor de pruebas acotado: repetir una secuencia explícita hasta satisfacer una
condición declarada en DOM o respuesta capturada. Requiere max_iterations y timeout;
parar ante error, condición desconocida, cancelación o presupuesto agotado. No aceptar
follow_until: terminal sin un predicado concreto. Estados posibles: matched,
iteration_limit, timeout, cancelled y error. No buscar resultados ganadores ni
adaptar apuestas: recorre transiciones de la demo especificadas por el caso de prueba.

### request_replay

Reproducir una solicitud capturada por request_id usando únicamente su sesión de
origen y credenciales locales vigentes. La herramienta es de escritura, aunque el
verbo HTTP sea GET; no reintentar automáticamente. No copiar cookies o Authorization
a otro dominio. Mantener política del navegador, no desactivar TLS/CORS ni saltar
controles de acceso. Bloquear redirecciones a orígenes fuera del alcance del caso.

La primera entrega limita replay a solicitudes HTTP reproducibles; firmas efímeras,
nonces consumidos, WebSockets y cuerpos streaming pueden requerir repetir el flujo
de UI. Informar esa limitación. Replay no garantiza equivalencia con el navegador
si la aplicación incorpora lógica adicional para construir o firmar la solicitud.

## Segunda entrega, conservada en el alcance propuesto

- request_replay_from_template: plantillas HTTP con placeholders referenciados por
  identificadores locales, sustitución tipada y alcance de origen. Nunca recibir
  instrucciones para enviar secretos a un host distinto de su origen autorizado.
- validate_response: status, existencia de paths JSON, tipo, igualdad, rangos y
  longitud. Sin ejecutar código arbitrario. Devolver cada comprobación y evidencia.
- session_context: nombres, dominio, expiración y disponibilidad de cookies/tokens,
  con referencias opacas para uso local; no devolver valores ni hashes de secretos.
- state_checkpoint: etiqueta y evidencia de UI/red/estado observado. Es una marca
  de evidencia, no una promesa de restaurar el estado del servidor.
- history_export: JSON y Markdown con job/branch/step/request/artifact IDs y línea
  temporal, listos para Resultados. No escribir en un destino desconocido: determinar
  primero la ruta y formato del sistema Resultados. Sin datos secretos en la exportación.
- iframe_list e iframe_open_direct: describir frames y abrir una URL HTTP(S)
  explícitamente elegida en una sesión nueva. Informar cuando depende del padre,
  postMessage, URL firmada o storage; abrir directo puede no reproducir el cliente.
- inspector de lectura: consultas estructuradas de DOM, frames y propiedades JSON
  conocidas. No ofrecer eval arbitrario con una garantía falsa de solo lectura:
  getters, proxies y llamadas pueden producir efectos incluso dentro de expresiones.
- branch_matrix: árbol finito de ramas explícitas, presupuestos globales y receta
  de preparación por nodo. Reutilizar una sesión solo después de aplicar y validar
  la preparación; no copiar sesiones vivas como si fueran estados equivalentes.

## Preparación y estado inicial

Cada rama usa un cliente ya preparado y validado, o una receta setup_steps que abre
la demo y llega al estado necesario. Copiar cookies/localStorage no clona el estado
del servidor, memoria JS, RNG, sockets o transacciones pendientes. El aislamiento se
mantiene por defecto; compartir credenciales no equivale a compartir estado inicial.

## Recuperación y recursos

Asignar IDs estables al trabajo y sus pasos; una consulta de resultados no ejecuta
de nuevo la acción. Si se pierde el resultado de una acción durante un corte,
marcarlo como incierto y conservar evidencia local hasta caducar; nunca repetir
clicks/replays automáticamente. No prometer exactly-once sobre el sitio externo.
Registrar checkpoints de progreso acotados, no escribir en D1 por cada evento de red.
Publicar evidencia resumida y subir artefactos solicitados con IDs por paso.

## Validación antes de instalar

Usar páginas locales de prueba deterministas con botones, iframes, canvas y endpoints
HTTP. Comprobar orden de pasos, aislamiento de secretos, rechazo de IDs obsoletos,
filtros y redirecciones, límites de memoria/tiempo, limpieza al cancelar y resultados
parciales. Medir dos ramas con espera controlada para demostrar solapamiento real,
sin prometer aceleración lineal. Forzar corte de WebSocket durante trabajo y comprobar
que no se duplican acciones. Verificar cuerpos tardíos, truncados y expirados.

Mantener las pruebas actuales de OAuth, perfiles, headless y reconexión. Probar el
ejecutable empaquetado en Windows. Publicar catálogo MCP y documentación juntos;
instalar el agente sin cerrar sesiones del usuario sin autorización.

## Decisión solicitada

Confirmar esta arquitectura y división de entregas. Después se concreta el plan de
implementación antes de modificar el ejecutor y el contrato de resultados existente.
