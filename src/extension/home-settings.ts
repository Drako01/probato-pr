import { z } from 'zod';

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const target = z.enum(['user', 'workspace']);
const setting = <K extends string, V extends z.ZodType>(key: K, value: V) => z.object({ key: z.literal(key), value, target }).strict();

const HomeSettingSchema = z.discriminatedUnion('key', [
  setting('review.onSave', z.boolean()),
  setting('review.baseBranch', z.string().max(200).refine(hasNoControlCharacters).transform((value) => value.trim())),
  setting('review.maxFiles', z.number().int().min(1).max(5000)),
  setting('verification.baseline', z.enum(['ask', 'always', 'never'])),
  setting('verification.timeoutSeconds', z.number().int().min(5).max(7200)),
  setting('ai.provider', z.enum(['none', 'vscode-lm', 'anthropic', 'openai-compatible'])),
  setting('ai.includeFileContent', z.boolean()),
  setting('home.openOnStartup', z.boolean()),
  setting('mutation.timeoutSeconds', z.number().int().min(5).max(7200)),
  setting('mutation.concurrency', z.number().int().min(1).max(8)),
  setting('mutation.memoryMb', z.number().int().min(256).max(8192)),
  setting('mutation.maxFiles', z.number().int().min(1).max(100)),
  setting('mutation.gateEnabled', z.boolean()),
  setting('mutation.failOnDegradation', z.boolean()),
  setting('mutation.minimumScore', z.number().min(0).max(100)),
  setting('mutation.tolerancePoints', z.number().min(0).max(100)),
]);

export type HomeSetting = z.infer<typeof HomeSettingSchema>;

/** The control center can edit only these settings; credentials and executable definitions are excluded. */
export function parseHomeSetting(raw: unknown): HomeSetting | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const properties = Object.getOwnPropertyDescriptors(raw);
  if (Object.keys(properties).length !== 3 || !['key', 'value', 'target'].every((key) => Object.hasOwn(properties, key) && Object.hasOwn(properties[key] ?? {}, 'value'))) return undefined;
  const parsed = HomeSettingSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
