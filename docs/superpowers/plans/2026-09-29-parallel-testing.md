# Firetrace Parallel Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ejecutar pruebas demo por ramas concurrentes y entregar evidencia reproducible con menos viajes MCP.

**Architecture:** Un ejecutor propietario por navegador, cola serial por sesión y coordinador de trabajos concurrentes. Un único transporte WSS publica resultados y mantiene presencia. Capturas, cuerpos y elementos tienen identificadores locales con alcance y caducidad explícitos.

**Tech Stack:** Python 3.11+, Playwright síncrono, websockets, TypeScript/JavaScript MCP SDK, Workers, Durable Objects, D1 y R2 existentes.

**Spec:** [Diseño aprobado](../specs/2026-09-29-parallel-testing.md).

## Global Constraints

- Exclusivamente demos o pruebas sin dinero real ni premios de valor.
- Conservar OAuth, aislamiento de perfiles, headless y heartbeat con hibernación.
- Límite de navegadores configurado: cuatro por defecto, rango existente 1–32.
- Secuencias: máximo 20 pasos; 120 segundos por defecto, máximo 300 segundos.
- Capturas: 200 solicitudes, 1 MiB por cuerpo, 20 MiB por sesión, TTL 15 minutos.
- No reejecutar acciones automáticamente por desconexión, timeout o consulta de resultados.
- No copiar secretos entre orígenes ni exportarlos en artefactos.
- No afirmar que checkpoint restaura estado remoto o que eval arbitrario es de solo lectura.
- Sin instalaciones sobre procesos activos ni cierre de sesiones del usuario sin autorización.
- Reutilizar las ramas de las PR existentes tras comprobar su estado; no modificar main directamente.

## Review Focus

- Cierre manual durante una secuencia: resultado parcial y limpieza, sin cambio silencioso de navegador (tareas 1–2).
- Corte de WSS después de un efecto: resultado incierto o recuperado, jamás replay automático (tarea 5).
- Cuerpos tardíos, grandes o secretos dentro de URL/JSON: límites y redacción antes de salir del PC (tarea 3).
- Navegación o sustitución DOM entre snapshot y click: rechazar elemento obsoleto (tarea 4).
- Redirección o nonce consumido durante replay: no enviar auth a otro origen ni repetir transacciones (tarea 7).

## Ubicaciones y convenciones

Repositorio agente: `work/firetrace`. Control: `work/control-optimized`.
Copiar diseño y plan a `docs/superpowers/specs/2026-09-29-parallel-testing.md`
y `docs/superpowers/plans/2026-09-29-parallel-testing.md` al iniciar ejecución.

Cada tarea sigue el ciclo: escribir la prueba indicada, ejecutarla y verificar el
fallo esperado, implementar, ejecutar la suite afectada y guardar un commit específico.
Python: activar `.venv/Scripts` en PATH y ejecutar `rtk pytest -q --tb=short`
con `--basetemp=.runtime/<nombre-unico>`. Cloudflare: `rtk npm test` desde cloudflare.
Usar páginas locales deterministas; las pruebas no operan clientes de juegos abiertos.

## Entrega 1

### 1. Ejecutores propietarios por sesión

Archivos: crear `firetrace/session_executor.py`, modificar `browser_sessions.py`,
`worker.py`, `cloudflare_agent.py`; pruebas `tests/test_session_executor.py`.

Interfaces: `SessionExecutor.submit(action: str, args: dict) -> Future[dict]`,
`snapshot() -> dict`, `close() -> None`. Cada ejecutor crea y cierra su Playwright
dentro del mismo hilo. El coordinador es el único dueño del registro de sesiones.
Cola de espera máxima: ocho órdenes por sesión; overflow devuelve `session_busy`.
Un job reserva sus sesiones durante toda su duración; no intercalar órdenes ajenas.

- [ ] Prueba: dos sesiones con trabajo bloqueado mediante barrera progresan simultáneamente; dentro de una sesión se conserva el orden. Registrar IDs de hilo y comprobar afinidad.
- [ ] Verificar que la prueba falla con el ejecutor serial actual.
- [ ] Separar operaciones sobre navegador de snapshots de presencia; mantener un único socket y el heartbeat fuera de los ejecutores.
- [ ] Probar cierre manual, excepción durante arranque, perfil duplicado y cierre limpio sin fugas de hilos/procesos; ejecutar la suite Python completa.
- [ ] Commit: `refactor: isolate browser execution per session`.

### 2. Secuencias y artefactos por paso

Archivos: crear `firetrace/sequences.py`, `firetrace/artifacts.py`,
`cloudflare/src/automation-tools.js`; modificar `worker.py`, `cloudflare_agent.py`,
`cloudflare/src/mcp.js`; pruebas `tests/test_sequences.py`, `cloudflare/test/automation.test.js`.

Interfaces: `validate_sequence(steps: list[dict], timeout_ms: int) -> list[dict]`;
`run_sequence(executor, steps, deadline, cancel_event) -> dict`;
`ArtifactStore.put(data: bytes, mime: str, job_id: str, step_id: str) -> str`.
Resultado: `{job_id, status, steps:[{step_id,status,result,artifact_ids}], error}`.
Registrar `browser_sequence` y `artifact_get`; recuperar imágenes por ID como contenido MCP.

- [ ] Prueba: click→wait→screenshot→click→screenshot devuelve dos artefactos distintos y el orden correcto. Una entrada inválida al final impide todos los efectos.
- [ ] Ejecutar prueba roja; implementar validación completa, deadline y detención al primer error.
- [ ] Eliminar dependencia de latest.jpg en este flujo. Todas las referencias incluyen job/step/artifact IDs; recuperar nunca vuelve a capturar.
- [ ] Probar 21 pasos, timeout >300 s, cancelación, cierre manual y artefacto ajeno/expirado; suite Python y MCP.
- [ ] Commit: `feat: execute bounded browser sequences with step artifacts`.

### 3. Ventanas de captura y almacenamiento acotado

Archivos: crear `firetrace/network_capture.py`, `firetrace/network_store.py`;
modificar `local_browser.py`, `redact.py`, `automation-tools.js`;
pruebas `tests/test_network_capture.py`, `tests/test_redact.py`.

Interfaces: `CaptureManager.start(filters: dict) -> dict`, `stop(capture_id: str) -> dict`,
`status(capture_id: str) -> dict`, `get_response_body(request_id: str) -> dict`.
`network_filter` configura filtros de una captura aún no iniciada; una captura activa
conserva sus filtros. Compartir esquema con `network_capture_window`.
Filtrar método/dominio exacto/path prefix/resource_type/content_type, AND entre
campos y OR dentro de campos. Filtrar content_type al recibir respuesta.

- [ ] Prueba roja contra servidor local: dos clicks dentro de una ventana, assets excluidos, body recuperable después de stop.
- [ ] Implementar hooks de finalización/fallo y almacén por sesión; aplicar límites exactos del diseño y marcar descartes/truncamiento/caducidad.
- [ ] Separar originales locales de evidencia saneada. Redactar headers, URL, JSON y formularios; cuerpos desconocidos devuelven metadata por defecto.
- [ ] Probar body tardío, binario, >1 MiB, >200 solicitudes, TTL, presupuesto 20 MiB, error y cancelación. Captura vacía no equivale a captura fallida.
- [ ] Ejecutar suites y commit: `feat: capture filtered network windows and deferred bodies`.

### 4. Snapshot DOM y clicks por identidad

Archivos: crear `firetrace/dom_inspector.py`; modificar `sequences.py`,
`automation-tools.js`; pruebas `tests/test_dom_inspector.py`.

Interfaces: `snapshot() -> dict`, `click_element(snapshot_id: str, element_id: str) -> dict`.
Registro por sesión/documento/frame; máximo 500 elementos y 500 caracteres por texto.
Incluir role, aria, enabled, visible, bounding_box y tipo canvas cuando corresponda.

- [ ] Prueba roja: botón dentro de iframe tiene ID y click dirigido; canvas se describe como superficie, sin botones inventados.
- [ ] Implementar handles ligados al snapshot, invalidación de navegación y comprobación de accionabilidad. No fallback a coordenadas viejas.
- [ ] Probar sustitución de nodo, iframe removido, scroll, transformación y elemento deshabilitado. Si no hay caja fiable, devolver null y motivo.
- [ ] Ejecutar suites y commit: `feat: inspect interactive elements and reject stale targets`.

### 5. Trabajos paralelos, progreso y cancelación

Archivos: crear `firetrace/jobs.py`; modificar `cloudflare_agent.py`,
`automation-tools.js`, `cloudflare/src/bridge.js` y el control
`cloudflare/src/index.js`; añadir migración SQL aditiva para trabajos si es necesaria.
Pruebas `tests/test_jobs.py`, `tests/test_connection_resilience.py` y
control `cloudflare/test/jobs.test.js`.

Interfaces: `JobManager.submit(branches: list[dict]) -> dict`, `get(job_id: str) -> dict`,
`cancel(job_id: str) -> dict`. Registrar `parallel_branches` y `job_cancel`;
`command_result` acepta el command ID que vincula al job. Estados:
queued/running/done/partial/error/cancelled/uncertain.

- [ ] Prueba roja: dos ramas con una barrera completan en solapamiento; una rama falla y la otra termina. Etiquetas/IDs duplicados se rechazan antes de ejecutar.
- [ ] Implementar reserva atómica de sesiones, cancelación cooperativa y resultados por rama. Prevalidar todos los pasos antes del primer efecto.
- [ ] Transportar aceptación/progreso/finalización con IDs; snapshots de progreso como máximo cada cinco segundos por job, más transiciones finales. No insertar cada evento de red en D1.
- [ ] Mantener resultados locales 15 minutos y reenviar evidencia tras reconexión de forma idempotente, nunca acciones. Reinicio del agente deja jobs incompletos como uncertain.
- [ ] Probar pérdida de respuesta final, repetición de consulta, reconexión, queue overflow, IDs ajenos y cancelación durante click; suites de ambos repositorios.
- [ ] Commit: `feat: coordinate parallel branches with bounded job recovery`.

### 6. Continuaciones acotadas

Archivos: crear `firetrace/conditions.py`; modificar `sequences.py`, `jobs.py`,
`automation-tools.js`; pruebas `tests/test_conditions.py`.

Interfaces: `evaluate_condition(condition: dict, evidence: dict) -> dict` con
matched/not_matched/unknown; `spin_until` usa steps, condición, max_iterations
(1–100) y timeout_ms (máximo 300000). Comparadores: exists, equals, type, range.
Resultado incluye matched/iteration_limit/timeout/cancelled/error, iteraciones y evidencia.

- [ ] Prueba roja: demo termina tras tres transiciones y ejecuta exactamente tres; condición ausente produce unknown y detiene.
- [ ] Implementar sin JS arbitrario; cada iteración usa la tarea 2 y conserva sus IDs.
- [ ] Probar agotamiento de iteraciones, tiempo, cancelación y error; nunca buscar premios ni ajustar apuestas.
- [ ] Ejecutar suites y commit: `feat: bound demo continuations by explicit conditions`.

### 7. Replay de una solicitud conocida

Archivos: crear `firetrace/request_replay.py`; modificar `network_store.py`,
`automation-tools.js`; pruebas `tests/test_request_replay.py`.

Interfaz: `replay(request_id: str, browser_id: str) -> dict`. Usar solicitud original
local, sesión de origen y alcance de origen explícito. Solo HTTP reproducible;
no WebSockets, streaming ni renovación automática de firmas/nonce.

- [ ] Prueba roja: servidor local recibe la cookie de la sesión correcta y una única solicitud; respuesta se devuelve saneada.
- [ ] Implementar replay mediante el contexto de navegador, preservando TLS/CORS; no usar un cliente que salte políticas del navegador para conseguir un éxito artificial.
- [ ] Bloquear redirecciones no autorizadas antes de enviar secretos. Probar cross-origin, request_id de otra sesión, nonce consumido, body expirado y error; cero reintentos automáticos.
- [ ] Ejecutar suites y commit: `feat: replay captured demo requests within their session`.

## Entrega 2

### 8. Plantillas, validación y contexto saneado

Archivos: ampliar `request_replay.py`, `conditions.py`; crear `firetrace/session_context.py`;
registrar herramientas en `automation-tools.js`. Pruebas por módulo.

Interfaces: `replay_template(browser_id, template: dict) -> dict`,
`validate_response(request_id, checks: list[dict]) -> dict`, `session_context(browser_id) -> dict`.
Placeholders tipados por referencias locales, nunca interpolación general de código.

- [ ] Pruebas rojas: referencias resuelven solo en sesión/origen correcto; validación reporta cada path/status/tipo/rango; contexto nunca retorna valores secretos ni hashes.
- [ ] Implementar reutilizando tareas 3, 6 y 7; devolver unavailable cuando la fuente dinámica no sea conocida, sin prometer detectar todos los tokens.
- [ ] Probar placeholders anidados/malformados, body no JSON y valores null; suites y commit específico.

### 9. Frames, checkpoints e historial exportable

Archivos: ampliar `dom_inspector.py`, `artifacts.py`; crear `firetrace/history.py`;
pruebas `tests/test_history.py` y `tests/test_iframes.py`.

Interfaces: `iframe_list(browser_id) -> dict`, `iframe_open_direct(browser_id, frame_id) -> dict`,
`checkpoint(browser_id, label) -> dict`, `export_history(job_id, format) -> dict`.
Exportar JSON/Markdown como artefacto descargable; escribir directo en Resultados
solo después de conocer ruta y formato. Inspector de lectura expone consultas
estructuradas; no se registra browser_eval_readonly para aceptar JS arbitrario.

- [ ] Pruebas rojas: frame HTTP seleccionado abre nueva sesión; srcdoc/blob/about se rechazan; evidencia exportada conserva relaciones y no secretos.
- [ ] Implementar checkpoint como marca, no restauración; informar dependencia del frame respecto al padre.
- [ ] Probar IDs caducados, límites de exportación y body binario; suites y commit específico.

### 10. Matriz de ramas

Archivos: crear `firetrace/branch_matrix.py`; modificar `jobs.py`,
`automation-tools.js`; pruebas `tests/test_branch_matrix.py`.

Interfaz: `submit_matrix(nodes: list[dict], budget: dict) -> dict`; nodos con
label, parent, setup_steps, precondition, steps. Máximo 100 nodos, profundidad 10,
sin ciclos; presupuesto global máximo 300 segundos por ejecución.

- [ ] Prueba roja: árbol de tres hojas ejecuta preparación y verifica precondición antes de cada hoja; reutilización no filtra cookies entre perfiles.
- [ ] Implementar planificación con el pool existente y cobertura por hojas solicitadas.
- [ ] Probar ciclo, precondición falsa, presupuesto agotado y resultado parcial; suites y commit específico.

## Publicación de cada entrega

- [ ] Revisar contratos y cambios completos, ejecutar las suites de agente/MCP/control y pruebas de concurrencia/corte de red.
- [ ] Actualizar tools/list, initialize.instructions, README y guía en outputs. Probar capacidades negociadas para que un servidor nuevo no prometa herramientas a un agente antiguo.
- [ ] Compilar el ejecutable sin consola, verificarlo contra servidor de prueba con dos sesiones headless y ninguna sesión personal.
- [ ] Publicar control compatible primero, agente después y catálogo MCP al final. Si hay sesiones activas, preparar binario y pedir autorización solo para el reinicio.
- [ ] Ejecutar smoke OAuth/MCP con páginas demo deterministas, limpiar solo recursos creados por la prueba, adjuntar evidencias y actualizar PRs sin fusionar main.

## Revisión del plan

Cobertura: tareas 1–7 implementan primera entrega; 8–10 mantienen la segunda.
Todas las interfaces y límites anteriores son decisiones del plan. Cada tarea tiene
una verificación negativa antes de implementar y regresión posterior. Queda pendiente
únicamente la ruta/formato de Resultados para escritura directa; la exportación
descargable no depende de esa información.

Método recomendado: ejecución directa en esta conversación, siguiendo dependencias
y con revisión independiente del conjunto al finalizar. Alternativa: subagente
implementador y revisor por tarea, con mayor consumo de contexto.
