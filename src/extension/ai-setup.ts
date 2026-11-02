import * as vscode from 'vscode';
import { AiProviderError } from '../ai/ai-provider';
import { apiKeySecretName, InvalidBaseUrlError, isOpenAi, OPENAI_BASE_URL, parseAiBaseUrl } from '../ai/openai-compatible-provider';
import { ANTHROPIC_KEY_SECRET, aiProviderLabel, createAiProvider } from './ai-providers';
import { SETTINGS_SECTION, type AiProviderId, type Settings } from './settings';

type Choice = { readonly provider: AiProviderId; readonly baseUrl?: string };

/** globalState list of the SecretStorage entries written here (SecretStorage cannot list keys on VS Code 1.99). */
const STORED_KEYS = 'probatoPR.storedAiKeys';

/**
 * Guided "Connect your AI" flow: provider → API key (stored in SecretStorage) → model picked from the
 * provider's own list (which also proves the credentials work) → saved to user settings.
 * Nothing is sent to a model here; only the provider's model list is requested.
 */
export class AiSetup {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly globalState: vscode.Memento,
    private readonly settings: () => Settings,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async run(): Promise<void> {
    const choice = await this.pickProvider();
    if (!choice) {
      return;
    }
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    if (choice.provider === 'none') {
      await config.update('ai.provider', 'none', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(vscode.l10n.t('AI review turned off. Deterministic review and verification keep working.'));
      return;
    }

    let draft: Settings['ai'] = { ...this.settings().ai, provider: choice.provider };
    if (choice.provider === 'openai-compatible') {
      const baseUrl = choice.baseUrl ?? (await this.askBaseUrl(draft.openaiCompatible.baseUrl));
      if (!baseUrl) {
        return;
      }
      draft = { ...draft, openaiCompatible: { baseUrl, model: '' } };
    }
    if (choice.provider !== 'vscode-lm' && !(await this.ensureKey(draft))) {
      return;
    }

    const model = await this.pickModel(draft);
    if (!model) {
      return;
    }
    draft = withModel(draft, model);

    const target = vscode.ConfigurationTarget.Global;
    await config.update('ai.provider', draft.provider, target);
    await config.update('ai.anthropicModel', draft.anthropicModel, target);
    await config.update('ai.vscodeLmModel', draft.vscodeLmModel, target);
    await config.update('ai.openaiCompatible.baseUrl', draft.openaiCompatible.baseUrl, target);
    await config.update('ai.openaiCompatible.model', draft.openaiCompatible.model, target);
    this.log.info(`AI provider configured: ${aiProviderLabel(draft) ?? draft.provider}`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('AI connected: {0}. Run "AI Review" on any review; you confirm the files before anything is sent.', aiProviderLabel(draft) ?? ''),
    );
  }

  /** Removes every API key this extension stored. */
  async forgetKeys(): Promise<void> {
    const keys = new Set([ANTHROPIC_KEY_SECRET, ...this.globalState.get<string[]>(STORED_KEYS, [])]);
    await Promise.all([...keys].map((k) => this.secrets.delete(k)));
    await this.globalState.update(STORED_KEYS, []);
    void vscode.window.showInformationMessage(vscode.l10n.t('Stored AI API keys deleted.'));
  }

  private async pickProvider(): Promise<Choice | undefined> {
    const items: (vscode.QuickPickItem & { choice: Choice })[] = [
      {
        label: `$(copilot) ${vscode.l10n.t('Chat models already in VS Code')}`,
        description: vscode.l10n.t('GitHub Copilot or another installed provider. No API key needed.'),
        choice: { provider: 'vscode-lm' },
      },
      { label: '$(key) Anthropic Claude', description: vscode.l10n.t('Your Anthropic API key'), choice: { provider: 'anthropic' } },
      { label: '$(key) OpenAI', description: vscode.l10n.t('Your OpenAI API key'), choice: { provider: 'openai-compatible', baseUrl: OPENAI_BASE_URL } },
      {
        label: `$(server) ${vscode.l10n.t('Other OpenAI-compatible API')}`,
        description: vscode.l10n.t('OpenRouter, Azure OpenAI, Ollama, LM Studio… (custom URL)'),
        choice: { provider: 'openai-compatible' },
      },
      { label: `$(circle-slash) ${vscode.l10n.t('Turn AI off')}`, description: vscode.l10n.t('Deterministic review only'), choice: { provider: 'none' } },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Probato PR: connect your AI'),
      placeHolder: vscode.l10n.t('Current: {0}. Code is only sent after you confirm the exact files, every time.', aiProviderLabel(this.settings().ai) ?? vscode.l10n.t('off')),
      ignoreFocusOut: true,
    });
    return picked?.choice;
  }

  private async askBaseUrl(current: string): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t('API base URL'),
      prompt: vscode.l10n.t('The URL that ends before /chat/completions. Examples: https://openrouter.ai/api/v1, http://localhost:11434/v1 (Ollama).'),
      value: current === OPENAI_BASE_URL ? '' : current,
      placeHolder: 'https://openrouter.ai/api/v1',
      ignoreFocusOut: true,
      validateInput: (input) => {
        try {
          parseAiBaseUrl(input);
          return undefined;
        } catch (error) {
          return error instanceof InvalidBaseUrlError ? error.message : String(error);
        }
      },
    });
    return value === undefined ? undefined : parseAiBaseUrl(value).href;
  }

  /** Asks for a key unless one is stored and the user keeps it. Local servers may have no key. */
  private async ensureKey(ai: Settings['ai']): Promise<boolean> {
    const secretName = ai.provider === 'anthropic' ? ANTHROPIC_KEY_SECRET : apiKeySecretName(parseAiBaseUrl(ai.openaiCompatible.baseUrl));
    if (await this.secrets.get(secretName)) {
      const keep = vscode.l10n.t('Keep the stored key');
      const replace = vscode.l10n.t('Enter a new key');
      const answer = await vscode.window.showQuickPick([keep, replace], { title: vscode.l10n.t('An API key is already stored for this provider'), ignoreFocusOut: true });
      if (answer === undefined) {
        return false;
      }
      if (answer === keep) {
        return true;
      }
    }
    const optional = ai.provider === 'openai-compatible' && !isOpenAi(parseAiBaseUrl(ai.openaiCompatible.baseUrl));
    const key = await vscode.window.showInputBox({
      title: vscode.l10n.t('API key'),
      prompt: optional
        ? vscode.l10n.t('Stored in your OS keychain (VS Code SecretStorage) and only sent to this server. Leave empty if the server needs no key.')
        : vscode.l10n.t('Stored in your OS keychain (VS Code SecretStorage) and only sent to this provider.'),
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (optional || input.trim() ? undefined : vscode.l10n.t('An API key is required for this provider.')),
    });
    if (key === undefined) {
      return false;
    }
    if (key.trim()) {
      await this.secrets.store(secretName, key.trim());
      const stored = new Set(this.globalState.get<string[]>(STORED_KEYS, []));
      await this.globalState.update(STORED_KEYS, [...stored.add(secretName)]);
    } else {
      await this.secrets.delete(secretName);
    }
    return true;
  }

  private async pickModel(ai: Settings['ai']): Promise<string | undefined> {
    const provider = createAiProvider(ai, this.secrets);
    if (!provider) {
      return undefined;
    }
    let models: readonly string[];
    try {
      models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking the connection with {0}…', provider.name), cancellable: true },
        (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => {
            controller.abort();
          });
          return provider.listModels(controller.signal).finally(() => {
            subscription.dispose();
          });
        },
      );
    } catch (error) {
      const message = error instanceof AiProviderError ? error.message : String(error);
      this.log.warn(`AI setup: could not list models: ${message}`);
      void vscode.window.showErrorMessage(vscode.l10n.t('Could not connect: {0}', message));
      return undefined;
    }
    const current = currentModel(ai);
    if (models.length === 0) {
      return vscode.window.showInputBox({
        title: vscode.l10n.t('Model'),
        prompt: ai.provider === 'vscode-lm' ? vscode.l10n.t('No chat model is available in VS Code. Install or sign in to GitHub Copilot, then try again.') : vscode.l10n.t('The provider listed no models. Enter the model ID.'),
        value: current,
        ignoreFocusOut: true,
      });
    }
    const picked = await vscode.window.showQuickPick(
      models.map((id) => ({ label: id, ...(id === current ? { description: vscode.l10n.t('current') } : {}) })),
      { title: vscode.l10n.t('Choose the model for code review'), placeHolder: vscode.l10n.t('Stronger reasoning models give better reviews; they also cost more per review.'), ignoreFocusOut: true },
    );
    return picked?.label;
  }
}

function currentModel(ai: Settings['ai']): string {
  switch (ai.provider) {
    case 'anthropic':
      return ai.anthropicModel;
    case 'vscode-lm':
      return ai.vscodeLmModel;
    case 'openai-compatible':
      return ai.openaiCompatible.model;
    case 'none':
      return '';
  }
}

function withModel(ai: Settings['ai'], model: string): Settings['ai'] {
  switch (ai.provider) {
    case 'anthropic':
      return { ...ai, anthropicModel: model };
    case 'vscode-lm':
      return { ...ai, vscodeLmModel: model };
    case 'openai-compatible':
      return { ...ai, openaiCompatible: { ...ai.openaiCompatible, model } };
    case 'none':
      return ai;
  }
}
