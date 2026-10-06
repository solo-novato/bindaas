import { assertFileContextDraft, contextBytes } from './fileContext';
import type { Draft } from './types';

export const MAX_PROMPT_BYTES = 128 * 1024;

/** Validate the complete native payload before its draft or queue changes owner. */
export function buildDraftPrompt(
  draft: Pick<Draft, 'prompt' | 'contexts'>,
  projectRoot: string,
): string {
  assertFileContextDraft(draft.contexts, projectRoot);
  const full =
    draft.prompt +
    draft.contexts
      .map(
        (context) => `\n\n--- Context: ${context.label} ---\n${context.text}`,
      )
      .join('');
  // The native send/steer cap includes typed text, labels, and delimiters too.
  if (full.length > MAX_PROMPT_BYTES || contextBytes(full) > MAX_PROMPT_BYTES)
    throw new Error(
      'A message can be at most 128 KiB including typed text and attached context. Shorten the message, remove context, or add a smaller selection.',
    );
  return full;
}
