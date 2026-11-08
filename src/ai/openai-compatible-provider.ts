import { tr } from '../core/i18n';
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
    throw new InvalidBaseUrlError(tr('Enter a full URL, for example https://api.openai.com/v1 or http://localhost:11434/v1.'));
  }
  if (url.username || url.password) {
    throw new InvalidBaseUrlError(tr('Do not put credentials in the URL; the API key is asked for separately.'));
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InvalidBaseUrlError(tr('Use https:// (plain http:// is only allowed for servers on this machine).'));
  }
  if (url.search || url.hash) {
    throw new InvalidBaseUrlError(tr('The base URL cannot contain a query string or fragment.'));
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
    this.name = openAi ? 'OpenAI' : tr('OpenAI-compatible API ({0})', baseUrl.host);
    this.destination = tr('{0}, using your API key if one is set', `${baseUrl.origin}${openAi ? ' (OpenAI)' : ''}`);
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.model.length > 0);
  }

  async listModels(signal: AbortSignal): Promise<readonly string[]> {
    const body = await this.request('models', { method: 'GET', signal });
    const parsed = ModelListSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiProviderError(tr('{0} did not return a model list.', this.baseUrl.host), 'other');
    }
    return parsed.data.data.map((m) => m.id).sort((a, b) => a.localeCompare(b));
  }

  async complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse> {
    if (!this.model) {
      throw new AiProviderError(tr('No model selected. Run "Probato PR: Connect Your AI".'), 'unavailable');
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
      throw new AiProviderError(tr('{0} returned an unexpected response.', this.baseUrl.host), 'other');
    }
    const message = parsed.data.choices[0]?.message;
    if (message?.refusal) {
      throw new AiProviderError(tr('The model declined to review this content.'), 'refused');
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
        // A redirect would resend the repository data (307/308 keep the body) to a server the base URL policy never
        // checked, possibly over plain http. Never follow one.
        redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      if (init.signal.aborted) {
        throw error;
      }
      throw new AiProviderError(tr('Could not reach {0}. Local review results are unaffected.', this.baseUrl.host), 'network');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new AiProviderError(tr('{0} answered with a redirect, which is never followed. Set the final API URL with "Probato PR: Connect Your AI".', this.baseUrl.host), 'other');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError(tr('{0} rejected the API key. Run "Probato PR: Connect Your AI" to set it again.', this.baseUrl.host), 'auth');
    }
    if (response.status === 429) {
      throw new AiProviderError(tr('{0} rate limit reached. Try again later.', this.baseUrl.host), 'rate-limited');
    }
    if (!response.ok) {
      throw new AiProviderError(tr('{0} returned HTTP {1}.', this.baseUrl.host, response.status), 'other');
    }
    try {
      const json: unknown = await response.json();
      return json;
    } catch {
      throw new AiProviderError(tr('{0} returned a response that is not JSON.', this.baseUrl.host), 'other');
    }
  }
}
