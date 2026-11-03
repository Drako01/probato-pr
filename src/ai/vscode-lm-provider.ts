import { tr } from '../core/i18n';
import * as vscode from 'vscode';
import { AiProviderError, type AIReviewProvider, type AiPrompt, type AiRawResponse } from './ai-provider';

const modelKey = (model: vscode.LanguageModelChat): string => `${model.vendor}/${model.id}`;

/**
 * Uses a chat model the user already has in VS Code (Language Model API, e.g. GitHub Copilot).
 * VS Code itself asks the user to allow this extension to use the model.
 */
export class VsCodeLanguageModelProvider implements AIReviewProvider {
  readonly id = 'vscode-lm';
  readonly name = tr('VS Code language model');
  readonly destination = tr('the provider of the chat model selected in VS Code (for example GitHub Copilot)');

  /** @param modelId the chosen model ("vendor/id"); empty uses the first available model. */
  constructor(private readonly modelId: string) {}

  private async model(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels();
    return models.find((m) => modelKey(m) === this.modelId) ?? (this.modelId ? undefined : models[0]);
  }

  async isAvailable(): Promise<boolean> {
    return (await this.model()) !== undefined;
  }

  async listModels(): Promise<readonly string[]> {
    return (await vscode.lm.selectChatModels()).map(modelKey);
  }

  async complete(prompt: AiPrompt, signal: AbortSignal): Promise<AiRawResponse> {
    const model = await this.model();
    if (!model) {
      throw new AiProviderError(tr('No VS Code language model is available. Install or sign in to a chat model provider.'), 'unavailable');
    }
    const source = new vscode.CancellationTokenSource();
    const onAbort = (): void => {
      source.cancel();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // The LM API has no system role: instructions go first, data last, in separate messages.
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt.instructions), vscode.LanguageModelChatMessage.User(prompt.data)],
        { justification: vscode.l10n.t('Probato PR sends the reviewed change to the model to look for defects and summarize it.') },
        source.token,
      );
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      return { model: modelKey(model), text };
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        throw new AiProviderError(tr('Language model request failed: {0}', error.message), error.code === vscode.LanguageModelError.NoPermissions.name ? 'auth' : 'other');
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    }
  }
}
