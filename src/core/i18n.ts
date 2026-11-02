/** A user-facing message: an English template with `{0}`-style placeholders, filled in when it is rendered. */
export type MessageArg = string | number;

export interface Message {
  readonly template: string;
  readonly args: readonly MessageArg[];
}

export type Translator = (template: string, ...args: MessageArg[]) => string;

/** Fills `{0}`, `{1}`… placeholders; this is the English rendering and the fallback for every locale. */
export function formatMessage(template: string, args: readonly MessageArg[]): string {
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}

const english: Translator = (template, ...args) => formatMessage(template, args);
let translator = english;

/**
 * Installs the locale-aware translator (the extension passes `vscode.l10n.t`). The core never imports
 * `vscode`, so the host injects it once at activation. Without it, messages render in English.
 */
export function setTranslator(next: Translator | undefined): void {
  translator = next ?? english;
}

/** Declares a message without rendering it, so ids and keys can use the English text while display uses the locale. */
export function msg(template: string, ...args: MessageArg[]): Message {
  return { template, args };
}

/** Renders a message (or a plain template) in the active locale. */
export function tr(template: string, ...args: MessageArg[]): string {
  return translator(template, ...args);
}

export function render(message: Message): string {
  return tr(message.template, ...message.args);
}

/** The English text of a message; locale-independent, used for stable ids. */
export function renderEnglish(message: Message): string {
  return formatMessage(message.template, message.args);
}
