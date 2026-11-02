import * as vscode from 'vscode';
import { z } from 'zod';
import { OPENAI_BASE_URL } from '../ai/openai-compatible-provider';

export const AI_PROVIDERS = ['none', 'vscode-lm', 'anthropic', 'openai-compatible'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

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
    provider: z.enum(AI_PROVIDERS).default('none'),
    anthropicModel: z.string().trim().min(1).default('claude-opus-5-5'),
    vscodeLmModel: z.string().trim().default(''),
    openaiCompatible: z.object({
      baseUrl: z.string().trim().default(OPENAI_BASE_URL),
      model: z.string().trim().default(''),
    }),
    includeFileContent: z.boolean().default(true),
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
      vscodeLmModel: config.get('ai.vscodeLmModel'),
      openaiCompatible: {
        baseUrl: config.get('ai.openaiCompatible.baseUrl'),
        model: config.get('ai.openaiCompatible.model'),
      },
      includeFileContent: config.get('ai.includeFileContent'),
      maxContextChars: config.get('ai.maxContextChars'),
      exclude: config.get('ai.exclude'),
    },
  };
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) {
    return { ...parsed.data, maxFileBytes: MAX_FILE_BYTES };
  }
  onInvalid(`Invalid Probato PR settings, defaults used: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return { ...SettingsSchema.parse({ review: {}, verification: {}, ai: { openaiCompatible: {} } }), maxFileBytes: MAX_FILE_BYTES };
}
