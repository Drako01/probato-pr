import * as vscode from 'vscode';
import type { AIReviewProvider } from '../ai/ai-provider';
import { AnthropicProvider } from '../ai/anthropic-provider';
import { apiKeySecretName, OpenAiCompatibleProvider, parseAiBaseUrl } from '../ai/openai-compatible-provider';
import { VsCodeLanguageModelProvider } from '../ai/vscode-lm-provider';
import type { Settings } from './settings';

export const ANTHROPIC_KEY_SECRET = 'probatoPR.anthropicApiKey';

/** Builds the configured provider; undefined when AI is off. Single source for reviews and the setup wizard. */
export function createAiProvider(ai: Settings['ai'], secrets: vscode.SecretStorage): AIReviewProvider | undefined {
  switch (ai.provider) {
    case 'none':
      return undefined;
    case 'vscode-lm':
      return new VsCodeLanguageModelProvider(ai.vscodeLmModel);
    case 'anthropic':
      return new AnthropicProvider(() => Promise.resolve(secrets.get(ANTHROPIC_KEY_SECRET)), ai.anthropicModel);
    case 'openai-compatible': {
      const baseUrl = parseAiBaseUrl(ai.openaiCompatible.baseUrl);
      return new OpenAiCompatibleProvider(baseUrl, ai.openaiCompatible.model, () => Promise.resolve(secrets.get(apiKeySecretName(baseUrl))));
    }
  }
}

/** Short label for the UI, e.g. "Anthropic Claude · claude-opus-5-5"; undefined when AI is off. */
export function aiProviderLabel(ai: Settings['ai']): string | undefined {
  switch (ai.provider) {
    case 'none':
      return undefined;
    case 'vscode-lm':
      return ai.vscodeLmModel ? `VS Code · ${ai.vscodeLmModel}` : vscode.l10n.t('VS Code chat model');
    case 'anthropic':
      return `Anthropic Claude · ${ai.anthropicModel}`;
    case 'openai-compatible': {
      let host: string;
      try {
        host = parseAiBaseUrl(ai.openaiCompatible.baseUrl).host;
      } catch {
        host = ai.openaiCompatible.baseUrl; // display only: an invalid URL is reported loudly when the provider is used
      }
      return [host, ai.openaiCompatible.model].filter(Boolean).join(' · ');
    }
  }
}
