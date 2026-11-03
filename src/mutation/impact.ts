import type { WorkspaceIndex } from '../core/analyzer';
import { parseSource, collectImports, resolveImport, isTestFile } from '../analyzers/ts-ast';

const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
/** Deliberately narrow: changed source and direct source imports of changed tests, never a broad repository glob. */
export async function discoverImpactedMutationFiles(changedFiles: readonly string[], workspace: WorkspaceIndex): Promise<readonly string[]> {
  const files = new Set(await workspace.listFiles((file) => SOURCE.test(file)));
  const impacted = new Set<string>();
  for (const file of changedFiles.slice(0, 5000)) {
    if (!SOURCE.test(file) || !files.has(file)) continue;
    if (!isTestFile(file)) { impacted.add(file); continue; }
    const text = await workspace.read(file);
    if (text === undefined) continue;
    for (const entry of collectImports(parseSource(file, text))) {
      const target = resolveImport(file, entry.specifier, files);
      if (target && !isTestFile(target)) impacted.add(target);
    }
  }
  return [...impacted].sort();
}
