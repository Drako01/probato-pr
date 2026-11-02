import { z } from 'zod';
import { AiProviderError, type AIReviewProvider, type AiPrompt, type AiRawResponse } from './ai-provider';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class InvalidBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBaseUrlError';
  }
}

/**
 * Validates the API base URL. HTTPS is required, except for local servers (Ollama, LM Studio) on loopback;
 * credentials embedded in the URL are refused so keys only travel in the Authorization header.
 */
export function parseAiBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidBaseUrlError('Enter a full URL, for example https://api.openai.com/v1 or http://localhost:11434/v1.');
  }
  if (url.username || url.password) {
    throw new InvalidBaseUrlError('Do not put credentials in the URL; the API key is asked for separately.');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InvalidBaseUrlError('Use https:// (plain http:// is only allowed for servers on this machine).');
  }
  if (url.search || url.hash) {
    throw new InvalidBaseUrlError('The base URL cannot contain a query string or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function isOpenAi(baseUrl: URL): boolean {
  return baseUrl.origin === new URL(OPENAI_BASE_URL).origin;
}

/** Name of the SecretStorage entry for a server: a key saved for one origin is never sent to another. */
export function apiKeySecretName(baseUrl: URL): string {
  return `probatoPR.aiKey:${baseUrl.origin}`;
}

const ChatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }) }))
    .min(1),
});
const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });

/**
 * Any server that speaks the OpenAI Chat Completions API: OpenAI, Azure OpenAI, OpenRouter, Ollama, LM Studio…
 * Uses the platform fetch (no SDK). The API key is optional for local servers.
 */
export class OpenAiCompatibleProvider implements AIReviewProvider {
  readonly id = 'openai-compatible';
  readonly name: string;
  readonly destination: string;

  constructor(
    private readonly baseUrl: URL,
    private readonly model: string,
    private readonly apiKey: () => Promise<string | undefined>,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    const openAi = isOpenAi(baseUrl);
    this.name = openAi ? 'OpenAI' : `OpenAI-compatible API (${baseUrl.host})`;
    this.destination = `${baseUrl.origin}${openAi ? ' (OpenAI)' : ''}, using your API key if one is set`;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.model.length > 0);
  }

  async listModels(signal: AbortSignal): Promise<readonly string[]> {
    const body = await this.request('models', { method: 'GET', signal });
    const parsed = ModelListSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiProviderError(`${this.baseUrl.host} did not return a model list.`, 'other');
    }
    return parsed.data.data.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  }

  async complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse> {
    if (!this.model) {
      throw new AiProviderError('No model selected. Run "Probato PR: Connect Your AI".', 'unavailable');
    }
    const body = await this.request('chat/completions', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: prompt.instructions },
          { role: 'user', content: prompt.data },
        ],
      }),
    });
    const parsed = ChatResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiProviderError(`${this.baseUrl.host} returned an unexpected response.`, 'other');
    }
    const message = parsed.data.choices[0]?.message;
    if (message?.refusal) {
      throw new AiProviderError('The model declined to review this content.', 'refused');
    }
    return { model: parsed.data.model ?? this.model, text: message?.content ?? '' };
  }

  private async request(path: string, init: { method: string; signal: AbortSignal; body?: string }): Promise<unknown> {
    const key = await this.apiKey();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.href}/${path}`, {
        method: init.method,
        signal: init.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      if (init.signal.aborted) {
        throw error;
      }
      throw new AiProviderError(`Could not reach ${this.baseUrl.host}. Local review results are unaffected.`, 'network');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError(`${this.baseUrl.host} rejected the API key. Run "Probato PR: Connect Your AI" to set it again.`, 'auth');
    }
    if (response.status === 429) {
      throw new AiProviderError(`${this.baseUrl.host} rate limit reached. Try again later.`, 'rate-limited');
    }
    if (!response.ok) {
      throw new AiProviderError(`${this.baseUrl.host} returned HTTP ${response.status}.`, 'other');
    }
    try {
      const json: unknown = await response.json();
      return json;
    } catch {
      throw new AiProviderError(`${this.baseUrl.host} returned a response that is not JSON.`, 'other');
    }
  }
}
