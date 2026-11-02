import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewResult } from '../core/model';

export interface HistoryEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly repository: string;
  readonly scope: string;
  readonly risk: string;
  readonly findings: number;
}

interface StoredState {
  readonly version: 1;
  readonly latest?: { readonly review: ReviewResult; readonly verified?: ReviewResult };
  readonly history: readonly HistoryEntry[];
}

const MAX_HISTORY = 20;
const FILE = 'reviews.json';

/**
 * Local review persistence in the extension's workspace storage folder (outside the repository).
 * Stores the latest review and a short summary list only; evidence excerpts are already redacted.
 */
export class HistoryStore {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string | undefined) {}

  private get file(): string | undefined {
    return this.directory ? path.join(this.directory, FILE) : undefined;
  }

  async load(): Promise<StoredState> {
    const empty: StoredState = { version: 1, history: [] };
    if (!this.file) {
      return empty;
    }
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StoredState>;
      return parsed.version === 1 && Array.isArray(parsed.history) ? (parsed as StoredState) : empty;
    } catch {
      // Missing or corrupt file: history is a convenience, so start fresh rather than fail activation.
      return empty;
    }
  }

  /** Writes are serialized and atomic (temp file + rename) so an interrupted save never corrupts history. */
  save(review: ReviewResult, verified: ReviewResult | undefined): Promise<void> {
    this.writing = this.writing.then(async () => {
      const file = this.file;
      if (!file || !this.directory) {
        return;
      }
      const state = await this.load();
      const summary: HistoryEntry = {
        id: review.id,
        createdAt: review.createdAt,
        repository: review.repository.name,
        scope: review.scope.label,
        risk: (verified ?? review).risk.level,
        findings: (verified ?? review).findings.length,
      };
      const next: StoredState = {
        version: 1,
        latest: { review, ...(verified ? { verified } : {}) },
        history: [summary, ...state.history.filter((h) => h.id !== review.id)].slice(0, MAX_HISTORY),
      };
      await mkdir(this.directory, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(next), 'utf8');
      await rename(temp, file);
    });
    return this.writing;
  }

  async clear(): Promise<void> {
    await this.writing;
    if (this.file) {
      await rm(this.file, { force: true });
    }
  }
}
