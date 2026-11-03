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
| AI provider API keys (if you set any), each bound to the server it was entered for | VS Code SecretStorage (OS keychain) | `Probato PR: Delete Stored AI API Keys` |
| AI walkthrough of a review (if you ran AI review) | Part of the stored review | `Probato PR: Delete Local Review History` |
| Exported reports | Wherever you save them | Delete the file |

Temporary baseline worktrees are created in the OS temp folder and removed after each verification.

## What is sent to third parties

Nothing, unless you use one of these optional features:

| Feature | Recipient | What is sent | When |
|---|---|---|---|
| Pull request review | GitHub API (`api.github.com`) | Requests for PR metadata, changed-file lists and file contents of that PR | Only when you run *Review Pull Request* |
| AI review — VS Code model | The provider of the chat model selected in VS Code (e.g. GitHub Copilot) | The diffs of the files listed in the confirmation dialog; the full current content of the changed files listed as "for context" (unless `probatoPR.ai.includeFileContent` is off); titles and locations of findings Probato PR already reported. Secrets redacted. | Only after you confirm the dialog, every time |
| AI review — Anthropic | Anthropic API | Same as above | Only after you confirm the dialog, every time |
| AI review — OpenAI or OpenAI-compatible API | The server at `probatoPR.ai.openaiCompatible.baseUrl` (OpenAI, OpenRouter, Azure OpenAI, or a local server such as Ollama) | Same as above | Only after you confirm the dialog, every time |
| Connect Your AI | The chosen provider | A request for its model list, authenticated with your key. No code is sent. | When you run the setup |

Sensitive files (`.env*`, private keys, certificates, credential files, Terraform state) are never sent to AI providers,
regardless of settings. The providers' own privacy terms apply to what you send them.

## Telemetry

Probato PR collects **no telemetry** and contains no analytics code. It does not phone home.

## Data subject requests

Because Probato PR stores no data on servers operated by the author, there is no remote data to access or delete. Local
data can be removed with the commands above or by uninstalling the extension. This policy is intended to be compatible
with Argentina's Ley 25.326 and the GDPR.

## Contact

Alejandro Daniel Di Stefano — ArmoTuSitio — addistefano76@gmail.com

## GitHub delivery

Creating or updating a pull request sends its title, description, branch and target to GitHub. Publishing a review
sends only the observations selected and previewed by the user. Replies, review decisions, conversation state,
merge requests and merge-queue requests are also explicit user actions. The active PR identity is stored in the
editor's workspace state. API credentials remain in the editor authentication provider.

Local Git push and synchronization contact the configured remote through Git. Commit hooks and approved project
checks execute with the user's permissions and can make their own network requests. Probato does not sandbox them.

Repository snapshots store hashes rather than file contents. Incremental analyzer caches exist only in memory.
Exported reports and displayed CI logs redact detected secrets; generated reports may still contain private code
or project details and should be shared deliberately.
