import { tr } from '../core/i18n';
import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type AIReviewProvider, type AiPrompt, type AiRawResponse } from './ai-provider';

/** Claude via the official Anthropic SDK. The API key lives in VS Code SecretStorage only. */
export class AnthropicProvider implements AIReviewProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';
  readonly destination = tr('Anthropic API (api.anthropic.com), using your API key');

  constructor(
    private readonly apiKey: () => Promise<string | undefined>,
    private readonly model: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return (await this.apiKey()) !== undefined;
  }

  async listModels(signal: AbortSignal): Promise<readonly string[]> {
    const client = await this.client();
    try {
      const ids: string[] = [];
      for await (const model of client.models.list(undefined, { signal })) {
        ids.push(model.id);
      }
      return ids;
    } catch (error) {
      throw this.translate(error, signal);
    }
  }

  private async client(): Promise<Anthropic> {
    const apiKey = await this.apiKey();
    if (!apiKey) {
      throw new AiProviderError(tr('No Anthropic API key configured. Run "Probato PR: Connect Your AI".'), 'unavailable');
    }
    return new Anthropic({ apiKey, maxRetries: 2 });
  }

  async complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse> {
    const client = await this.client();
    try {
      // Server-side fallback lets the API re-run a policy-declined request on a fallback model.
      const response = await client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: prompt.instructions,
          messages: [{ role: 'user', content: prompt.data }],
        },
        { signal },
      );
      if (response.stop_reason === 'refusal') {
        throw new AiProviderError(tr('The model declined to review this content.'), 'refused');
      }
      const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
      return { model: response.model, text };
    } catch (error) {
      throw this.translate(error, signal);
    }
  }

  /** Maps SDK errors to actionable provider errors; cancellations and unknown errors pass through. */
  private translate(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof AiProviderError || signal.aborted) {
      return error;
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return new AiProviderError(tr('Anthropic rejected the API key. Run "Probato PR: Connect Your AI" to set it again.'), 'auth');
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new AiProviderError(tr('Anthropic rate limit reached. Try again later.'), 'rate-limited');
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new AiProviderError(tr('Could not reach the Anthropic API. Local review results are unaffected.'), 'network');
    }
    if (error instanceof Anthropic.APIError) {
      return new AiProviderError(tr('Anthropic API error {0}: {1}', String(error.status), error.message), 'other');
    }
    return error;
  }
}
