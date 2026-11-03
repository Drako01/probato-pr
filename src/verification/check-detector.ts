import { sha256 } from '../core/ids';
import { executionDefinition } from './execution-definition';
import type { PlannedCheck } from '../core/model';
import { goChecks } from './ecosystems/go';
import { javaChecks } from './ecosystems/java';
import { nodeChecks } from './ecosystems/node';
import { phpChecks } from './ecosystems/php';
import { pythonChecks } from './ecosystems/python';
import { rustChecks } from './ecosystems/rust';
import type { CheckDraft, Ecosystem, ProjectProbe } from './ecosystems/shared';

export type { ProjectProbe } from './ecosystems/shared';

/** Order in which ecosystems are offered; a polyglot repository gets the checks of each. */
const ECOSYSTEMS: readonly Ecosystem[] = [nodeChecks, goChecks, phpChecks, pythonChecks, rustChecks, javaChecks];

/** Any change to the command, its directory or the script body changes the fingerprint (and voids remembered approvals). */
function withFingerprint({ check, scriptBody = '' }: CheckDraft): PlannedCheck {
  return { ...check, fingerprint: sha256(JSON.stringify([check.command.executable, check.command.args, check.cwd, scriptBody])) };
}

/**
 * Builds the verification plan from tools already present in the project. Never proposes
 * installing anything; when dependencies are missing the plan says so instead of hiding the check.
 */
export async function detectChecks(probe: ProjectProbe, platform: NodeJS.Platform = process.platform): Promise<PlannedCheck[]> {
  const found = await Promise.all(ECOSYSTEMS.map((ecosystem) => ecosystem({ probe, platform })));
  const definition = await executionDefinition(probe);
  return found.flat().map((draft) => withFingerprint({ ...draft, scriptBody: `${draft.scriptBody ?? ''}:${definition}` }));
}
