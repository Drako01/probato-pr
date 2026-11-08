# Manual test plan

Covers what automated tests cannot (Restricted Mode is not enforced in the Extension Development Host) and the first-use experience. Record PASS/FAIL per step in `PRODUCT_RELEASE_READINESS.md`.

## Setup

```bash
code --install-extension probato-pr.vsix
node scripts/create-demo-repo.mjs C:\temp\probato-demo
```

## 1. First use (zero friction)

1. Open `C:\temp\probato-demo` in VS Code and choose **Yes, I trust the authors**.
2. Click the **Probato PR** icon (the letter P drawn as a merge graph) in the Activity Bar. The Overview welcome shows *Review → Verify → Share* with *Review Current Changes* and *Review Branch* buttons; Findings and Verification show their own empty-state text.
3. Run it. The **Review Summary** panel opens: risk **CRITICAL**, the three steps with *Verify* highlighted as the next step, and the findings. The status bar shows the risk and the finding count; the Activity Bar icon shows a badge. Expected in **Findings**:
   - High · Evidenced — `"getUserName" is no longer exported by src/api/user.ts` at `src/ui/profile.ts:1`.
   - High · Evidenced — focused test `cart > adds items`.
   - High · Evidenced — `Test no longer asserts anything: "cart > removes items"`.
   - Critical · Evidenced — AWS access key in `src/storage.ts` (excerpt redacted).
   - Medium · Evidenced — empty catch block in `src/storage.ts`.
4. Click a finding: the editor opens at the right line; the Problems panel lists the same findings.
5. Hover a finding: the tooltip explains *why this status*.
6. In **Findings**, switch to *Group by File* in the view toolbar and back; the choice survives a window reload.
7. In the Review Summary: filter by severity, switch *By file*, expand a finding and press **Open** (the code opens beside the panel), then **Dismiss** (the finding disappears everywhere and *Restore dismissed* appears). Use only the keyboard (Tab, Enter) for one pass: focus stays on the control you used.
8. Reload the window: the Review Summary panel is restored with the same review.
9. `Welcome: Open Walkthrough` → **Get started with Probato PR**: each step's button runs its command and the step is marked done.

## 2. Verification with attribution

1. Click the beaker (**Verify Findings**) in the Verification view.
2. The picker shows `npm run test` with its rationale and the "Executes repository code" warning (not pre-selected); it does not show the script body. Select it, confirm the modal.
3. Choose **Compare with base**.
4. Expected: check **failed · introduced** ("Passes on the base revision and fails with this change"); review risk **CRITICAL** (the committed AWS key), with the regression listed among the reasons; the Evidence node opens a log with command, revision, exit code, duration and output hash.
5. Run `git worktree list` in the demo repo: only the main worktree remains.

## 3. Reports

`Export Review Report` → SARIF, Markdown, JSON. Open the SARIF file with a SARIF viewer; confirm no secret appears in any report.

## 4. Cancellation

Add a script `"test": "node -e \"setTimeout(()=>{},600000)\""`, run Verify and press **Cancel** in the notification. The check ends as *cancelled* and no `node` process remains (Task Manager).

## 5. Restricted Mode

1. Open any Git folder and choose **No, I don't trust the authors**.
2. The Probato PR view shows the Restricted Mode message; running *Review Current Changes* shows the trust warning and produces no review, no diagnostics and no Git process.
3. Trust the folder (**Manage Workspace Trust**): the commands start working without reloading.

## 6. Parent repository guard

Open a folder that is not a repository but lives inside one (e.g. a subfolder of a monorepo). *Review Current Changes* asks before reviewing the parent repository.

## 7. Offline and optional services

- Disconnect the network: local review and verification still work; *Review Pull Request* shows "Could not reach GitHub".
- With `probatoPR.ai.provider = none`, *AI Review* explains it is optional and offers the setting.

## 8. Bring your own AI

1. In the Review Summary, the *AI reviewer* card shows **Connect Your AI**. Run it and pick **Chat models already in VS Code** (requires GitHub Copilot): the model list appears; pick one. The card now shows the provider and **Run AI Review**.
2. Run **Connect Your AI** again with **OpenAI** (or **Other OpenAI-compatible API** with `http://localhost:11434/v1` and Ollama running): an invalid key shows "Could not connect" and saves nothing; a valid key lists models.
3. Try `http://example.com/v1` as a custom URL: it is refused (HTTPS required for remote servers).
4. **Run AI Review**: the confirmation lists *Diffs*, *Full file content, for context* and *Not sent*. Confirm: the card shows the walkthrough; AI findings appear as *Suspected*.
5. **Copy PR Description** and paste it in an editor: *Summary* (AI walkthrough) comes first, then *Verification (Probato PR)*.
6. Add `"probatoPR.ai.openaiCompatible.baseUrl": "https://evil.example/v1"` to the workspace `.vscode/settings.json`: Settings shows it as not applicable in the workspace and AI review keeps using the user-level URL.
7. **Delete Stored AI API Keys**, then **Run AI Review** with OpenAI: it reports the provider is not ready.

## 9. Spanish UI

Set the display language to Spanish (`Configure Display Language` → `es`), reload, and check that commands, views and messages are translated.
