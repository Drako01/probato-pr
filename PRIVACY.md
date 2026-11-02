# Privacy

Probato PR treats your code as confidential. The core product runs entirely on your machine.

## What is processed locally

- Git diffs and the contents of changed files (base and head revisions).
- Other repository source files, read only to find consumers of changed exports.
- Output of verification commands you approve.

## What is stored, and where

| Data | Location | How to delete |
|---|---|---|
| Latest review and a summary of the last 20 reviews (findings, evidence metadata, redacted output excerpts) | VS Code workspace storage for this extension (outside your repository) | `Probato PR: Delete Local Review History` |
| Dismissed finding IDs | VS Code workspace state | `Probato PR: Restore Dismissed Findings` |
| Anthropic API key (if you set one) | VS Code SecretStorage (OS keychain) | `Probato PR: Set Anthropic API Key` with an empty value |
| Exported reports | Wherever you save them | Delete the file |

Temporary baseline worktrees are created in the OS temp folder and removed after each verification.

## What is sent to third parties

Nothing, unless you use one of these optional features:

| Feature | Recipient | What is sent | When |
|---|---|---|---|
| Pull request review | GitHub API (`api.github.com`) | Requests for PR metadata, changed-file lists and file contents of that PR | Only when you run *Review Pull Request* |
| AI review — VS Code model | The provider of the chat model selected in VS Code (e.g. GitHub Copilot) | Diff hunks of the files listed in the confirmation dialog, secrets redacted | Only after you confirm the dialog, every time |
| AI review — Anthropic | Anthropic API | Same as above | Only after you confirm the dialog, every time |

Sensitive files (`.env*`, private keys, certificates, credential files, Terraform state) are never sent to AI providers, regardless of settings. The providers' own privacy terms apply to what you send them.

## Telemetry

Probato PR collects **no telemetry** and contains no analytics code. It does not phone home.

## Data subject requests

Because Probato PR stores no data on servers operated by the author, there is no remote data to access or delete. Local data can be removed with the commands above or by uninstalling the extension. This policy is intended to be compatible with Argentina's Ley 25.326 and the GDPR.

## Contact

Alejandro Daniel Di Stefano — ArmoTuSitio — addistefano76@gmail.com
