/** Prompt split into trusted instructions and untrusted repository data. */
export interface AiPrompt {
  readonly instructions: string;
  readonly data: string;
}

export interface AiRawResponse {
  readonly model: string;
  readonly text: string;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'auth' | 'rate-limited' | 'refused' | 'network' | 'other',
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/**
 * Optional AI reviewer. Providers only transport text; context building, redaction and response
 * validation are shared and provider-independent. Responses are untrusted and never executed.
 */
export interface AIReviewProvider {
  readonly id: string;
  readonly name: string;
  /** Human-readable destination shown in the consent dialog (who receives the code). */
  readonly destination: string;
  isAvailable(): Promise<boolean>;
  /** Model IDs this provider offers with the current credentials; also proves the credentials work. */
  listModels(signal: AbortSignal): Promise<readonly string[]>;
  complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse>;
}
