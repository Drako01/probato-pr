# Arquitectura de Probato PR

Documento interno (español). La documentación pública está en inglés.

## Principio rector

**Una observación no es una prueba.** El sistema separa tres cosas: *detección* (analizadores, IA), *verificación* (comandos realmente ejecutados) y *atribución causal* (comparación base vs. cambio). La evidencia de comandos solo se crea a partir de una ejecución real (`toEvidence(RunResult)`); nada la sintetiza.

## Capas y dependencias

```text
extension.ts (composition root)
   │
   ├─ extension/   comandos, sesión, settings        ← depende de vscode
   ├─ ui/          árboles, diagnósticos, documentos ← depende de vscode
   ├─ ai/vscode-lm-provider.ts                       ← depende de vscode
   │
   ├─ core/          modelo de dominio, motor, riesgo, secretos, paths, glob   (sin vscode)
   ├─ analyzers/     analizadores deterministas (AST con TypeScript)           (sin vscode)
   ├─ git/           cliente Git endurecido, parser de diff, change sets      (sin vscode)
   ├─ github/        cliente REST de solo lectura, change set de PR           (sin vscode)
   ├─ verification/  detección de checks, motor, baseline, atribución, enlace (sin vscode)
   ├─ ai/            contexto, parser/validador, proveedor Anthropic          (sin vscode)
   ├─ reports/       Markdown, SARIF 2.1.0, JSON                              (sin vscode)
   └─ infrastructure/ process runner, índice del workspace, historial         (sin vscode)
```

Reglas verificadas por tests (`test/unit/ai-github-reports.test.ts`): las capas marcadas "sin vscode" no importan `vscode`, y no hay ciclos de importación. ESLint prohíbe `child_process` fuera de `ProcessRunner`.

## Flujo de una revisión

1. `ReviewController` resuelve el repositorio (multi-root: selector), verifica Workspace Trust y adquiere el lock de `ReviewSession.exclusive` (evita ejecuciones duplicadas).
2. `LocalChangeCollector` (o `pullRequestChangeSet`) produce un `ChangeSet`: archivos, hunks, límites aplicados y un `ContentProvider` perezoso para leer base/head.
3. `ReviewEngine` ejecuta cada `Analyzer` aplicable; un analizador que falla queda registrado como `failed` sin ocultar a los demás; los recortes de cobertura se informan como limitaciones.
4. `finalizeResult` deduplica, ordena y calcula el riesgo explicable (`assessRisk`).
5. La UI se suscribe a `ReviewSession.onDidChange` (árboles, diagnósticos, reporte virtual) y el historial se persiste de forma atómica.

## Verificación

1. `detectChecks` arma el plan solo con herramientas presentes (scripts de `package.json`, `tsc` local, `go build/vet/test`), con advertencias (scripts del repo = código no confiable) y requisitos de infraestructura detectados.
2. El usuario elige y confirma (QuickPick + modal). Nada se ejecuta sin eso.
3. `VerificationEngine` corre cada check con `ProcessRunner` (sin shell, timeout, límite de salida, cancelación con kill del árbol).
4. Solo los checks que fallan se re-ejecutan en un `BaselineWorktree` (worktree temporal desacoplado en `%TEMP%`, hooks desactivados, `node_modules` enlazado y desenlazado con `unlink` antes de borrar).
5. `attribute` clasifica: `introduced`, `pre-existing`, `fixed`, `inconclusive`. Con diagnósticos parseables (tsc/go) compara huellas `archivo|código|mensaje`, independientes de los números de línea.
6. `applyVerification` se aplica siempre sobre la revisión pre-verificación: enlaza diagnósticos con hallazgos (→ `confirmed` si el error es nuevo respecto de la base), agrega hallazgos de verificación y degrada a `suspected` los hallazgos de contrato cuando el type-check pasa.

## Decisiones (ADR resumidos)

| Decisión | Motivo | Alternativa descartada |
|---|---|---|
| Git por CLI con flags seguros, no la Git Extension API | Necesitamos merge-base, worktrees, blobs por revisión y tests fuera de VS Code; control explícito de config peligrosa | `vscode.git` API: no expone todo y no es testeable sin el host |
| Parser de diff propio | Renombres, binarios, rutas citadas y cambios de modo de Git | `diff.parsePatch`: maneja mal cabeceras de Git |
| TypeScript 6.0.3 como dependencia de runtime (bundle) | AST real para analizadores; typescript-eslint exige `<6.1` | TS 7 (compilador nativo) no expone la API de JS |
| Sin webviews | Superficie de ataque mínima, accesibilidad y tema nativos; reporte vía documento virtual + vista previa Markdown | Webview con CSP: más código y riesgo sin beneficio en el MVP |
| Baseline solo para checks fallidos | Reduce el costo a la mitad o menos; un check que pasa no puede ser regresión | Correr todo dos veces |
| PR vía API, sin fetch/checkout | Solo lectura, no toca el repo del usuario | `git fetch pull/N/head`: escribe refs |
| IA solo como transporte de texto | Proveedores intercambiables; validación y redacción comunes | Lógica por proveedor |
| SDK oficial `@anthropic-ai/sdk` | Recomendación oficial; errores tipados | `fetch` crudo |

## Puntos de extensión

- **Nuevo analizador:** implementar `Analyzer` (`src/core/analyzer.ts`) y registrarlo en `src/analyzers/index.ts`. Agregar casos verdaderos y trampas al corpus (`test/unit/benchmark.test.ts`).
- **Nuevo proveedor de IA:** implementar `AIReviewProvider` (`src/ai/ai-provider.ts`) y agregarlo al switch de `extension.ts` + enum de settings.
- **Nuevo tipo de check:** extender `detectChecks` y, si la salida es parseable, `parseDiagnostics`.
- **Nuevo formato de reporte:** función pura `ReviewResult → string` en `src/reports/`.

## Marca

El nombre visible (`Probato PR`) vive en `package.nls*.json`, README y reportes. Los contratos funcionales (`probatoPR.*` en comandos/settings, `probato-report:` y `probato-evidence:` como esquemas) no dependen del nombre comercial salvo el prefijo técnico, que puede mantenerse aunque cambie la marca.
