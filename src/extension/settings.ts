import * as vscode from 'vscode';
import { z } from 'zod';

const SettingsSchema = z.object({
  review: z.object({
    baseBranch: z.string().trim().default(''),
    maxFiles: z.number().int().min(1).max(5000).default(300),
    maxDiffBytes: z.number().int().min(10_000).default(4_000_000),
    exclude: z.array(z.string()).default([]),
  }),
  verification: z.object({
    timeoutSeconds: z.number().int().min(5).max(7200).default(600),
    maxOutputBytes: z.number().int().min(10_000).default(1_000_000),
    baseline: z.enum(['ask', 'always', 'never']).default('ask'),
  }),
  ai: z.object({
    provider: z.enum(['none', 'vscode-lm', 'anthropic']).default('none'),
    anthropicModel: z.string().trim().min(1).default('claude-opus-5-5'),
    maxContextChars: z.number().int().min(2000).max(1_000_000).default(120_000),
    exclude: z.array(z.string()).default([]),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const SETTINGS_SECTION = 'probatoPR';
const MAX_FILE_BYTES = 2_000_000;

/** Reads and validates settings; invalid user values fall back to defaults and are reported, not silently used. */
export function readSettings(onInvalid: (message: string) => void): Settings & { readonly maxFileBytes: number } {
  const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  const raw = {
    review: {
      baseBranch: config.get('review.baseBranch'),
      maxFiles: config.get('review.maxFiles'),
      maxDiffBytes: config.get('review.maxDiffBytes'),
      exclude: config.get('review.exclude'),
    },
    verification: {
      timeoutSeconds: config.get('verification.timeoutSeconds'),
      maxOutputBytes: config.get('verification.maxOutputBytes'),
      baseline: config.get('verification.baseline'),
    },
    ai: {
      provider: config.get('ai.provider'),
      anthropicModel: config.get('ai.anthropicModel'),
      maxContextChars: config.get('ai.maxContextChars'),
      exclude: config.get('ai.exclude'),
    },
  };
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) {
    return { ...parsed.data, maxFileBytes: MAX_FILE_BYTES };
  }
  onInvalid(`Invalid Probato PR settings, defaults used: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { ...SettingsSchema.parse({ review: {}, verification: {}, ai: {} }), maxFileBytes: MAX_FILE_BYTES };
}
