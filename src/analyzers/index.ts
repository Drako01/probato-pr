import type { Analyzer } from '../core/analyzer';
import { ConfigRiskAnalyzer } from './config-risk';
import { CrossStackAnalyzer } from './cross-stack';
import { DependenciesAnalyzer } from './dependencies';
import { ErrorHandlingAnalyzer } from './error-handling';
import { SecretsAnalyzer } from './secrets';
import { TestIntegrityAnalyzer } from './test-integrity';
import { TsContractsAnalyzer } from './ts-contracts';

/** Built-in deterministic analyzers. New analyzers are added here; the engine has no knowledge of them. */
export function createDefaultAnalyzers(): Analyzer[] {
  return [
    new SecretsAnalyzer(),
    new TsContractsAnalyzer(),
    new TestIntegrityAnalyzer(),
    new ErrorHandlingAnalyzer(),
    new DependenciesAnalyzer(),
    new ConfigRiskAnalyzer(),
    new CrossStackAnalyzer(),
  ];
}
