import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewResult } from '../core/model';
import { sanitizeText } from '../core/sanitize';
import { readStoredReview } from './history-schema';

export interface HistoryEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly repository: string;
  readonly scope: string;
  readonly risk: string;
  readonly findings: number;
  readonly snapshotAvailable?: boolean;
}
export interface StoredState {
  readonly version: 2;
  readonly latest?: { readonly review: ReviewResult; readonly verified?: ReviewResult };
  readonly history: readonly HistoryEntry[];
  readonly snapshots: readonly ReviewResult[];
}
const MAX_HISTORY = 20;
const MAX_SNAPSHOTS = 5;
const MAX_SNAPSHOT_BYTES = 1_500_000;
const MAX_SNAPSHOT_TOTAL_BYTES = 6_000_000;
const MAX_FILE_BYTES = 10_000_000;
const FILE = 'reviews.json';

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function readSummary(value: unknown): HistoryEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (!['id', 'createdAt', 'repository', 'scope', 'risk'].every((key) => typeof value[key] === 'string' && value[key].length <= 20_000)) return undefined;
  if (typeof value.findings !== 'number' || !Number.isSafeInteger(value.findings) || value.findings < 0) return undefined;
  return { id: String(value.id), createdAt: String(value.createdAt), repository: String(value.repository), scope: String(value.scope), risk: String(value.risk), findings: value.findings };
}
function boundedSnapshots(reviews: readonly ReviewResult[]): ReviewResult[] {
  const result: ReviewResult[] = [];
  let bytes = 0;
  for (const review of reviews) {
    if (result.length >= MAX_SNAPSHOTS) break;
    if (result.some((previous) => previous.id === review.id)) continue;
    const size = Buffer.byteLength(JSON.stringify(review));
    if (size > MAX_SNAPSHOT_BYTES || bytes + size > MAX_SNAPSHOT_TOTAL_BYTES) continue;
    result.push(review);
    bytes += size;
  }
  return result;
}

/** Versioned local history. Full evidence is bounded separately from the twenty compact history rows. */
export class HistoryStore {
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string | undefined) {}
  private get file(): string | undefined { return this.directory ? path.join(this.directory, FILE) : undefined; }

  async load(): Promise<StoredState> {
    const empty: StoredState = { version: 2, history: [], snapshots: [] };
    const file = this.file;
    if (!file) return empty;
    try {
      const handle = await open(file, 'r');
      let contents: string;
      try {
        if ((await handle.stat()).size > MAX_FILE_BYTES) return empty;
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_FILE_BYTES) return empty;
        contents = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      const parsed: unknown = JSON.parse(contents);
      if (!isRecord(parsed) || ![1, 2].includes(Number(parsed.version)) || !Array.isArray(parsed.history)) return empty;
      const latest = isRecord(parsed.latest) ? parsed.latest : undefined;
      const review = latest ? readStoredReview(latest.review) : undefined;
      const candidateVerified = latest ? readStoredReview(latest.verified) : undefined;
      const verified = review && candidateVerified && candidateVerified.id === review.id && candidateVerified.snapshot === review.snapshot && candidateVerified.repository.root === review.repository.root && candidateVerified.scope.kind === review.scope.kind && candidateVerified.scope.baseSha === review.scope.baseSha && candidateVerified.scope.headSha === review.scope.headSha && candidateVerified.scope.headRef === review.scope.headRef && candidateVerified.repository.headSha === review.repository.headSha ? candidateVerified : undefined;
      const candidates = Array.isArray(parsed.snapshots) ? parsed.snapshots.slice(0, MAX_HISTORY).map(readStoredReview).filter((candidate): candidate is ReviewResult => candidate !== undefined) : [];
      const snapshots = boundedSnapshots([...(review ? [verified ?? review] : []), ...candidates]);
      const history = parsed.history.slice(0, MAX_HISTORY).map(readSummary).filter((entry): entry is HistoryEntry => entry !== undefined)
        .map((entry) => ({ ...entry, snapshotAvailable: snapshots.some((snapshot) => snapshot.id === entry.id) }));
      return sanitizeText({ version: 2, ...(review ? { latest: { review, ...(verified ? { verified } : {}) } } : {}), history, snapshots });
    } catch {
      return empty;
    }
  }

  async findReview(id: string): Promise<ReviewResult | undefined> {
    return (await this.load()).snapshots.find((review) => review.id === id);
  }

  save(review: ReviewResult, verified: ReviewResult | undefined): Promise<void> {
    const operation = this.writing.catch(() => undefined).then(async () => {
      const file = this.file;
      if (!file || !this.directory) return;
      const state = await this.load();
      const safeReview = readStoredReview(sanitizeText(review));
      const safeVerified = verified ? readStoredReview(sanitizeText(verified)) : undefined;
      const effective = safeVerified ?? safeReview;
      const snapshots = boundedSnapshots([...(effective ? [effective] : []), ...state.snapshots.filter((snapshot) => snapshot.id !== review.id)]);
      const summary: HistoryEntry = { id: review.id, createdAt: review.createdAt, repository: review.repository.name, scope: review.scope.label, risk: (verified ?? review).risk.level, findings: (verified ?? review).findings.length };
      const latest = safeReview && Buffer.byteLength(JSON.stringify({ review: safeReview, verified: safeVerified })) <= MAX_SNAPSHOT_BYTES * 2
        ? { review: safeReview, ...(safeVerified ? { verified: safeVerified } : {}) } : undefined;
      const next: StoredState = { version: 2, ...(latest ? { latest } : {}), history: [summary, ...state.history.filter((entry) => entry.id !== review.id)].slice(0, MAX_HISTORY), snapshots };
      await mkdir(this.directory, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(sanitizeText(next)), 'utf8');
      await rename(temp, file);
    });
    this.writing = operation.catch(() => undefined);
    return operation;
  }

  async clear(): Promise<void> {
    await this.writing;
    if (this.file) await rm(this.file, { force: true });
  }
}
