import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type AIReviewProvider, type AiPrompt, type AiRawResponse } from './ai-provider';

/** Claude via the official Anthropic SDK. The API key lives in VS Code SecretStorage only. */
export class AnthropicProvider implements AIReviewProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';
  readonly destination = 'Anthropic API (api.anthropic.com), using your API key';

  constructor(
    private readonly apiKey: () => Promise<string | undefined>,
    private readonly model: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    return (await this.apiKey()) !== undefined;
  }

  async complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse> {
    const apiKey = await this.apiKey();
    if (!apiKey) {
      throw new AiProviderError('No Anthropic API key configured. Run "Probato PR: Set Anthropic API Key".', 'unavailable');
    }
    const client = new Anthropic({ apiKey, maxRetries: 2 });
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
        throw new AiProviderError('The model declined to review this content.', 'refused');
      }
      const text = response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
      return { model: response.model, text };
    } catch (error) {
      if (error instanceof AiProviderError || signal.aborted) {
        throw error;
      }
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError('Anthropic rejected the API key. Set a valid key and try again.', 'auth');
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new AiProviderError('Anthropic rate limit reached. Try again later.', 'rate-limited');
      }
      if (error instanceof Anthropic.APIConnectionError) {
        throw new AiProviderError('Could not reach the Anthropic API. Local review results are unaffected.', 'network');
      }
      if (error instanceof Anthropic.APIError) {
        throw new AiProviderError(`Anthropic API error ${String(error.status)}: ${error.message}`, 'other');
      }
      throw error;
    }
  }
}
