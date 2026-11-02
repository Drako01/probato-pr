# Product Release Readiness — Probato PR 0.1.0

Documento interno (español). Fecha de evaluación: 2026-11-02 (actualizada). Entorno de prueba disponible: **Windows 11 Pro (10.0.26220), VS Code 1.144.0, Node 24.22.1, Git 2.56, pnpm 12.4.2**. No se simularon pruebas en sistemas no disponibles.

Escala: **PASS** (verificado con evidencia) · **WARN** (funciona con reservas) · **FAIL** · **SKIP** (no ejecutado) · **BLOCKED** (impedido por el entorno o una decisión pendiente). SKIP y BLOCKED **no** equivalen a PASS.

## Recomendación

> **NO-GO para publicación pública** hasta resolver los bloqueantes B1, B3 y B4. El producto es funcional y está empaquetado; la licencia ya está decidida (MIT). Falta la verificación de marca, el publisher y la validación multiplataforma que exige la directiva. Recomendación al resolverlos: primera publicación como 0.x con `"preview": true`.

### Bloqueantes

| # | Bloqueante | Responsable |
|---|---|---|
| B1 | Verificación legal/comercial del nombre "Probato PR" (INPI clases 9 y 42, Marketplace, GitHub, dominios). Solo hubo chequeos automáticos de disponibilidad, que no constituyen disponibilidad jurídica. | Alejandro |
| ~~B2~~ | ~~Licencia definitiva.~~ **Resuelto 2026-11-02: MIT** (`LICENSE`, `package.json`). | — |
| B3 | Publisher `armotusitio` en Visual Studio Marketplace: crear/verificar identidad y método de publicación (ver `docs/RELEASE.md`). | Alejandro |
| B4 | Pruebas en Linux y macOS (al menos Extension Host + suite e2e) antes de declarar compatibilidad. | CI (plantilla preparada, no habilitada) |

## Checklist GO / NO-GO

| Criterio | Estado | Evidencia / justificación |
|---|---|---|
| Extensión instalable desde VSIX | **PASS** | `code --install-extension probato-pr.vsix` en perfil aislado → `armotusitio.probato-pr@0.1.0` listado. |
| Activación comprobada en VS Code oficial | **PASS** | Suite de integración (`test/integration`) 9/9 en VS Code 1.144.0 (escenarios repo único y multi-root, incluye apertura del panel Review Summary), tanto desde fuentes como **desde el contenido extraído del VSIX** (re-ejecutado 2026-11-02 tras el cambio de UI). |
| Primer uso funcional sin cuentas externas | **PASS** | La suite ejecuta *Review Current Changes* en un repo fixture sin GitHub ni IA; detecta el hallazgo y publica el diagnóstico. |
| Revisión Git local funcional | **PASS** | Tests e2e sobre repos Git reales: working/staged/branch/commit, untracked, rutas con espacios y Unicode, límites y exclusiones. |
| Hallazgos navegables | **PASS** | Test de integración: `openFinding` abre el archivo correcto en la línea del hallazgo; diagnósticos verificados en el host. |
| Verificación con evidencia real | **PASS** | E2E: tsc falla solo después del cambio → hallazgo *confirmed* + atribución *introduced*, con evidencia head/base reales. |
| Cancelación operativa | **PASS** | Test: la cancelación mata el proceso hijo y el nieto (sin huérfanos); timeout probado. |
| Seguridad de comandos revisada | **PASS** | Sin shell; whitelist de argumentos para shims `.cmd`; refs validadas; fsmonitor malicioso no se ejecuta (test); aprobación explícita; README/SECURITY declaran que **no hay sandbox**. |
| Ausencia de secretos en el paquete | **PASS** | Contenido del VSIX inspeccionado (20 archivos); `vsce` no reportó secretos; sin `.env`, tests ni fuentes. |
| Documentación de privacidad completa | **PASS** | `PRIVACY.md`: qué se procesa, almacena y envía, cómo borrar historial, sin telemetría. |
| Dependencias y licencias auditadas | **PASS** | `pnpm audit --prod`: sin vulnerabilidades. 7 paquetes en el bundle, todos Apache-2.0/MIT/Unlicense (`THIRD_PARTY_NOTICES.md` generado del metafile). |
| Compatibilidad declarada respaldada por pruebas | **WARN** | Solo Windows verificado; README lo declara explícitamente. Linux/macOS/WSL/Dev Containers/SSH: **SKIP** (no disponibles). |
| Rendimiento medido | **PASS** | `pnpm run perf` (esta máquina, 2026-11-02): 50 archivos 0,53 s; 1.000 archivos 3,4 s; 5.000 archivos/300 cambios 19,1 s con 300/300 detectados (presupuestos 3/15/60 s). |
| Errores críticos conocidos resueltos | **PASS** | Bugs encontrados por tests y corregidos: doble conteo de asserts, doble finalización del runner, límite silencioso de escaneo (ahora se reporta), owner `..` en remotos. |
| Branding validado antes de publicación | **BLOCKED** | B1. |
| Identidad del publisher preparada | **BLOCKED** | B3. `publisher: armotusitio` configurado, no verificado en Marketplace. |
| Paquete VSIX inspeccionado | **PASS** | `unzip -l`: solo bundles (extensión y script del webview), CSS del panel, avisos legales, iconos, manifiestos, l10n y docs de usuario. 1,24 MB. |
| Instalación limpia comprobada | **PASS** | Perfil aislado (`--user-data-dir`/`--extensions-dir` temporales). |
| Procedimiento de publicación documentado | **PASS** | `docs/RELEASE.md`. |
| Release autorizado por el propietario | **BLOCKED** | Pendiente de Alejandro. |

## Requisitos de la directiva — estado

| Requisito | Estado | Nota |
|---|---|---|
| Zero-friction (sin cuentas, IA, Docker, servidores) | PASS | Probado en la suite de integración. |
| Workspace Trust | WARN | `untrustedWorkspaces: limited` + bloqueo en cada comando + welcome view. Test automatizado **BLOCKED por la plataforma**: VS Code no aplica Workspace Trust en el Extension Development Host (`isTrusted` queda en `true`; escenario opt-in `PROBATO_SCENARIO=restricted` lo documenta). Verificación manual: `docs/MANUAL_TEST_PLAN.md` §5. |
| SecretStorage | PASS (código) | API key de Anthropic; sin test automatizado (requiere llavero del SO). |
| Prompt injection | PASS | Tests: delimitación de datos, cierre de etiqueta neutralizado, rechazo de ubicaciones fuera del diff. |
| Path traversal / symlinks | PASS | Tests con `..`, absolutos, NUL y junctions que escapan. |
| CSP de webviews | PASS | Un webview (Review Summary): CSP `default-src 'none'` + nonce, `localResourceRoots` acotado, sin command URIs, render con `textContent`. Mensajes validados con Zod contra lista blanca; tests unitarios de rechazo (`test/unit/summary-ui.test.ts`). |
| Multi-root | PASS | Integración: workspace con 2 repos + carpeta sin repo; review dirigida por URI/`SourceControl.rootUri`, repo limpio y carpeta sin repo rechazados. Guardia de repo padre (p. ej. home bajo Git) con confirmación. |
| Monorepos | WARN | Funciona a nivel de diff y análisis; baseline con `node_modules` por paquete puede quedar *inconclusive* (documentado). |
| Precisión / recall / FPR | PASS (corpus propio) | 22 casos (13 defectos, 9 trampas, incluye alias de tsconfig): precision 1,000, recall 1,000, FPR 0,000. **No** es un benchmark comparativo. |
| Localización al español | PASS | Manifest (`package.nls.es.json`) y runtime (`l10n/bundle.l10n.es.json`, 155/155 claves, verificado con `scripts/l10n-keys.mjs`). |
| Telemetría | PASS | No existe. |
| Accesibilidad | WARN | Árboles nativos con `accessibilityInformation` e iconos con forma distinta por estado (no solo color). Panel: botones nativos, `aria-pressed`/`aria-expanded`, foco restaurado tras cada render, chips de verificación distinguibles por estilo de borde, `prefers-reduced-motion`. Sin auditoría con lector de pantalla; plan manual §1.7. |
| VS Code Insiders | SKIP | No instalado en esta máquina. |
| vscode.dev / github.dev | Fuera de alcance 0.1 | `virtualWorkspaces: false` declarado; requiere Git y procesos locales. |
| OIDC / Trusted Publishing | WARN | Evaluado y documentado en `docs/RELEASE.md`; validar contra la documentación vigente de Microsoft antes de habilitar. |

## Pendientes no bloqueantes

- Ejecutar los pasos nuevos del plan manual (`docs/MANUAL_TEST_PLAN.md` §1.6–1.9: agrupación, panel con teclado, restauración tras reload, walkthrough). Hasta ahora el panel solo se probó con la suite de integración y uso informal.
- Capturas reales para el README del Marketplace (panel Review Summary, Overview con los pasos, Findings agrupado por archivo).
- `repository`/`bugs` apuntan a `github.com/Drako01/probato-pr`, que hoy es **privado**: hacerlo público (o quitar esos campos) antes de publicar, para que los enlaces del Marketplace no den 404.
- Confirmar el email público de contacto usado en `SECURITY.md`, `SUPPORT.md` y `PRIVACY.md`.
- Resolución de `extends` en tsconfig y self-imports por nombre de paquete (los alias `paths` del tsconfig raíz ya se resuelven).
- Tamaño del bundle (4,35 MB, mayormente el compilador TypeScript): evaluar carga diferida del módulo `typescript` para acelerar la activación.
