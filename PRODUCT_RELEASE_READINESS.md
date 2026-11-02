# Product Release Readiness — Probato PR 0.1.0

Documento interno (español). Fecha de evaluación: 2026-11-02 (actualizada). Entorno de prueba disponible: **Windows 11 Pro (10.0.26220), VS Code 1.144.0, Node 24.22.1, Git 2.56, pnpm 12.4.2**. No se simularon pruebas en sistemas no disponibles.

Escala: **PASS** (verificado con evidencia) · **WARN** (funciona con reservas) · **FAIL** · **SKIP** (no ejecutado) · **BLOCKED** (impedido por el entorno o una decisión pendiente). SKIP y BLOCKED **no** equivalen a PASS.

## Recomendación

> **GO como Preview 0.1.0, autorizado por el propietario el 2026-11-02 con riesgos aceptados** (B1 marca sin verificar en el INPI; B4 sin pruebas en Linux/macOS, declarado en el README). La evaluación técnica sola seguía siendo NO-GO por esos dos puntos; la decisión de publicar igual es del propietario. Licencia MIT, repositorio público, `"preview": true`. B3 (publisher) se resuelve al crearlo.

### Bloqueantes

| # | Bloqueante | Responsable |
|---|---|---|
| B1 | Verificación legal/comercial del nombre "Probato PR" (INPI clases 9 y 42, Marketplace, GitHub, dominios). Solo hubo chequeos automáticos de disponibilidad, que no constituyen disponibilidad jurídica. **Riesgo aceptado por el propietario (2026-11-02)**: si hubiera conflicto, habría que publicar con otro ID. | Alejandro |
| ~~B2~~ | ~~Licencia definitiva.~~ **Resuelto 2026-11-02: MIT** (`LICENSE`, `package.json`). | — |
| B3 | Publisher `armotusitio` en Visual Studio Marketplace: crear/verificar identidad y método de publicación (ver `docs/RELEASE.md`). | Alejandro |
| B4 | Pruebas en Linux y macOS (al menos Extension Host + suite e2e) antes de declarar compatibilidad. **Riesgo aceptado**: el README declara que solo Windows está verificado. | CI (plantilla preparada, no habilitada) |

## Checklist GO / NO-GO

| Criterio | Estado | Evidencia / justificación |
|---|---|---|
| Extensión instalable desde VSIX | **PASS** | `code --install-extension probato-pr.vsix` en perfil aislado → `armotusitio.probato-pr@0.1.0` listado. |
| Activación comprobada en VS Code oficial | **PASS** | Suite de integración (`test/integration`) 11/11 en VS Code 1.144.0 (escenarios repo único y multi-root: panel Review Summary, Copy PR Description con el portapapeles real, URL de IA no sobrescribible desde el workspace), tanto desde fuentes como **desde el contenido extraído del VSIX** (re-ejecutado 2026-11-02 tras BYOK). |
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
| Gobierno del repositorio | **PASS** | Rulesets activos y verificados por API (2026-11-02): `main` solo por PR (aprobación de CODEOWNERS, conversaciones resueltas, historial lineal, solo squash, sin force-push ni borrado; el admin solo puede saltear la aprobación al mergear un PR) y tags `v*` creables solo por el admin, inmutables. Secret scanning + push protection, alertas y updates de seguridad de Dependabot, reporte privado de vulnerabilidades. El rechazo de un push directo a `main` no se probó en vivo. |
| Release autorizado por el propietario | **PASS** | Autorizado por Alejandro el 2026-11-02 (Preview 0.1.0), con B1 y B4 como riesgos aceptados. |

## Requisitos de la directiva — estado

| Requisito | Estado | Nota |
|---|---|---|
| Zero-friction (sin cuentas, IA, Docker, servidores) | PASS | Probado en la suite de integración. |
| Workspace Trust | WARN | `untrustedWorkspaces: limited` + bloqueo en cada comando + welcome view. Test automatizado **BLOCKED por la plataforma**: VS Code no aplica Workspace Trust en el Extension Development Host (`isTrusted` queda en `true`; escenario opt-in `PROBATO_SCENARIO=restricted` lo documenta). Verificación manual: `docs/MANUAL_TEST_PLAN.md` §5. |
| SecretStorage | PASS (código) | API keys de IA, una por origen de servidor (`apiKeySecretName`, test unitario); el borrado usa una lista en `globalState` porque `SecretStorage.keys()` no existe en VS Code 1.99. Sin test automatizado del llavero real (requiere llavero del SO). |
| IA BYOK: proveedor compatible con OpenAI | PASS | Tests con `fetch` simulado (errores auth/rate-limit/red/refusal/respuesta inválida, sin header sin key) y **contra un servidor HTTP real en 127.0.0.1** (rutas, header `Authorization`, la key nunca en el body). Validación de URL (HTTPS salvo loopback, sin credenciales ni query). |
| IA BYOK: llamadas reales a OpenAI / Anthropic / Copilot / Ollama | SKIP | Sin claves ni servidores en esta máquina; no se simuló. Plan manual §8. |
| IA: protección de la clave ante workspaces maliciosos | PASS | `ai.openaiCompatible.baseUrl` con scope `application`: test de integración verifica que VS Code rechaza escribirlo a nivel workspace. Claves ligadas al origen. |
| IA: sospecha → prueba | PASS | Test e2e con `tsc` y baseline reales: un hallazgo de IA en una línea donde el type-check falla solo tras el cambio pasa a *confirmed / introduced* ("AI suspicion confirmed"). Solo aplica a checks con diagnósticos parseables (tsc, go). |
| Prompt injection | PASS | Tests: delimitación de datos (diffs, contenido completo, rutas y hallazgos conocidos), cierre/apertura de etiquetas neutralizado, rechazo de hallazgos y entradas del resumen fuera de los archivos compartidos, texto del modelo escapado en Markdown y en la descripción del PR. |
| Path traversal / symlinks | PASS | Tests con `..`, absolutos, NUL y junctions que escapan. |
| CSP de webviews | PASS | Un webview (Review Summary): CSP `default-src 'none'` + nonce, `localResourceRoots` acotado, sin command URIs, render con `textContent`. Mensajes validados con Zod contra lista blanca; tests unitarios de rechazo (`test/unit/summary-ui.test.ts`). |
| Multi-root | PASS | Integración: workspace con 2 repos + carpeta sin repo; review dirigida por URI/`SourceControl.rootUri`, repo limpio y carpeta sin repo rechazados. Guardia de repo padre (p. ej. home bajo Git) con confirmación. |
| Monorepos | WARN | Funciona a nivel de diff y análisis; baseline con `node_modules` por paquete puede quedar *inconclusive* (documentado). |
| Precisión / recall / FPR | PASS (corpus propio) | 22 casos (13 defectos, 9 trampas, incluye alias de tsconfig): precision 1,000, recall 1,000, FPR 0,000. **No** es un benchmark comparativo. |
| Localización al español | PASS | Manifest (`package.nls.es.json`) y runtime (`l10n/bundle.l10n.es.json`, 194/194 claves, verificado con `scripts/l10n-keys.mjs`). |
| Telemetría | PASS | No existe. |
| Accesibilidad | WARN | Árboles nativos con `accessibilityInformation` e iconos con forma distinta por estado (no solo color). Panel: botones nativos, `aria-pressed`/`aria-expanded`, foco restaurado tras cada render, chips de verificación distinguibles por estilo de borde, `prefers-reduced-motion`. Sin auditoría con lector de pantalla; plan manual §1.7. |
| VS Code Insiders | SKIP | No instalado en esta máquina. |
| vscode.dev / github.dev | Fuera de alcance 0.1 | `virtualWorkspaces: false` declarado; requiere Git y procesos locales. |
| OIDC / Trusted Publishing | WARN | Validado contra la documentación oficial (2026-11-02): `vsce publish --oidc` (soportado por `@vscode/vsce` 4.1.0 instalado) con política de Trusted Publishing; los PAT globales se retiran el 2026-12-01. Workflow `.github/workflows/publish.yml` con acciones fijadas por SHA y environments limitados a `main`; guía `docs/PUBLICACION.md`. |

## Pendientes no bloqueantes

- Ejecutar los pasos nuevos del plan manual (`docs/MANUAL_TEST_PLAN.md` §1.6–1.9: agrupación, panel con teclado, restauración tras reload, walkthrough; §8: BYOK con un proveedor real). Hasta ahora el panel solo se probó con la suite de integración y uso informal, y la IA sin llamadas reales.
- El logo del README (`media/readme-logo.png`) usa ruta relativa: `vsce` la reescribe a `github.com/Drako01/probato-pr`, así que en el Marketplace solo se verá cuando el repositorio sea público.
- "Extension host is unresponsive" (~5 s) aparece en la integración durante la primera revisión: es la carga síncrona del compilador TypeScript. Relacionado con el punto del bundle de abajo.
- Capturas reales para el README del Marketplace (panel Review Summary, Overview con los pasos, Findings agrupado por archivo).
- ~~Repositorio privado~~: público desde el 2026-11-02; `repository`, `bugs` y el logo del README responden HTTP 200.
- Confirmar el email público de contacto usado en `SECURITY.md`, `SUPPORT.md` y `PRIVACY.md`.
- Resolución de `extends` en tsconfig y self-imports por nombre de paquete (los alias `paths` del tsconfig raíz ya se resuelven).
- Tamaño del bundle (4,35 MB, mayormente el compilador TypeScript): evaluar carga diferida del módulo `typescript` para acelerar la activación.
