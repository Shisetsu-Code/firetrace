# Fixed Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Guardar y reutilizar botones fijos con IDs y coordenadas persistentes.

**Architecture:** Catálogo y miniaturas propios; comandos explícitos integrados en BrowserController; representación separada de observaciones dinámicas. La interfaz y el runner consumen el mismo contrato.

**Tech Stack:** Node, Playwright y Sharp existentes; sin dependencias adicionales.

**Spec:** `docs/superpowers/specs/2026-10-25-fixed-buttons-design.md`.

## Global Constraints

- Tres lecturas y pausas de 2000 ms sólo cuando se solicita `verify`.
- IDs `f1` persistentes; puntos exactos, sin reescalado.
- Escrituras atómicas del catálogo y miniaturas independientes.
- No mezclar juegos con el mismo ContainerLauncher.
- Ninguna verificación automática al listar, guardar o usar un fijo.

## Review Focus

- Reinicio o retención de observaciones: conservar miniatura e ID.
- Cambio de juego, viewport o scroll: impedir uso del fijo ajeno al contexto.
- Modal o carga superpuesto: rechazar el clic si cambió el recorte.
- Verificación inestable: mantener `buttons: []` y distinguir fijos.
- Respuestas antiguas del panel: conservar serialización, autenticación y contexto actual.

## Tasks

- [x] Catálogo (`src/fixed-buttons.cjs`, `tests/fixed-store.test.cjs`): persistencia, IDs, contexto, mutaciones y validación.
- [x] Controlador y parser (`src/browser.cjs`, `src/commands.cjs`, `tests/fixed-buttons.test.cjs`, `tests/commands.test.cjs`): pin/listar/renombrar/eliminar/clic por posición guardada.
- [x] Publicación y API (`src/artifacts.cjs`, `src/overlay.cjs`, `src/server.cjs`): coordenadas fijas separadas y miniaturas autenticadas.
- [x] Panel (`public/*`, `tests/fixed-ui.test.cjs`): guardar, listar, usar, renombrar, quitar y distinguir fijos.
- [x] Actions (`scripts/github-session.cjs`, `tests/fixed-session.test.cjs`): catálogo en evidencia y restauración explícita de una sesión anterior.
- [x] Verificación: pruebas focales con rojo→verde, suite completa 97/97 y prueba visual del panel conectado a Chromium.
- [x] Documentar comandos y preparar los cambios para la rama existente, sin iniciar juegos ni modificar main.
