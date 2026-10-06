import { describe, expect, it } from 'vitest';
import {
  assertFileContextDraft,
  contextBytes,
  createFileReference,
  createSelectionContext,
  MAX_FROZEN_CONTEXT_BYTES,
} from '../../src/lib/fileContext';
import { buildDraftPrompt, MAX_PROMPT_BYTES } from '../../src/lib/prompt';
import type { Context } from '../../src/lib/types';

const root = '/projects/bindaas';
const generic = (text: string, label = 'Plan 🐈'): Context => ({
  id: 'plan',
  label,
  text,
});
function fullSizeSnapshot(path: string): Context {
  const capture = { path, fromLine: 1, toLine: 1, text: 'x', dirty: true };
  const overhead = contextBytes(createSelectionContext(root, capture).text) - 1;
  return createSelectionContext(root, {
    ...capture,
    text: 'x'.repeat(MAX_FROZEN_CONTEXT_BYTES - overhead),
  });
}

describe('native prompt payload', () => {
  it('preserves typed text and all generic and file context in capture order', () => {
    const reference = createFileReference(root, 'src/雪.ts');
    const context = generic('First line\nSecond line');
    expect(
      buildDraftPrompt(
        { prompt: 'Explain 🐈\n', contexts: [context, reference] },
        root,
      ),
    ).toBe(
      'Explain 🐈\n' +
        `\n\n--- Context: Plan 🐈 ---\nFirst line\nSecond line` +
        `\n\n--- Context: src/雪.ts ---\n${reference.text}`,
    );
  });

  it('accepts an exactly capped plain message and rejects one extra byte', () => {
    const prompt = 'x'.repeat(MAX_PROMPT_BYTES);
    expect(buildDraftPrompt({ prompt, contexts: [] }, root)).toBe(prompt);
    expect(() =>
      buildDraftPrompt({ prompt: prompt + 'x', contexts: [] }, root),
    ).toThrow(/at most 128 KiB/);
  });

  it('uses UTF-8 bytes rather than character or UTF-16 counts', () => {
    const prompt = '🐈'.repeat(MAX_PROMPT_BYTES / 4);
    expect(prompt.length).toBeLessThan(MAX_PROMPT_BYTES);
    expect(buildDraftPrompt({ prompt, contexts: [] }, root)).toBe(prompt);
    expect(() =>
      buildDraftPrompt({ prompt: prompt + 'é', contexts: [] }, root),
    ).toThrow(/including typed text and attached context/);
  });

  it('counts generic context labels and delimiters at the exact wire boundary', () => {
    const label = '雪 🐈';
    const prefix = `Typed text\n\n--- Context: ${label} ---\n`;
    const text = 'x'.repeat(MAX_PROMPT_BYTES - contextBytes(prefix));
    const draft = { prompt: 'Typed text', contexts: [generic(text, label)] };
    const result = buildDraftPrompt(draft, root);
    expect(result).toBe(prefix + text);
    expect(contextBytes(result)).toBe(MAX_PROMPT_BYTES);
    expect(() =>
      buildDraftPrompt({ ...draft, prompt: draft.prompt + 'x' }, root),
    ).toThrow(/128 KiB/);
    expect(() =>
      buildDraftPrompt(
        { ...draft, contexts: [generic(text, label + 'x')] },
        root,
      ),
    ).toThrow(/128 KiB/);
  });

  it('counts framing for every context and preserves the original on overflow', () => {
    const contexts = [generic('a'), { ...generic('b', 'Next'), id: 'next' }];
    const framing = contextBytes(
      buildDraftPrompt({ prompt: '', contexts }, root),
    );
    const prompt = 'x'.repeat(MAX_PROMPT_BYTES - framing);
    const draft = { prompt, contexts };
    expect(contextBytes(buildDraftPrompt(draft, root))).toBe(MAX_PROMPT_BYTES);
    const before = structuredClone(draft);
    expect(() =>
      buildDraftPrompt(
        { ...draft, contexts: [...contexts, generic('', 'Extra')] },
        root,
      ),
    ).toThrow(/128 KiB/);
    expect(draft).toEqual(before);
  });

  it('rejects legal frozen-context totals that exceed the complete payload cap', () => {
    const contexts = [fullSizeSnapshot('src/a'), fullSizeSnapshot('src/b')];
    expect(() => assertFileContextDraft(contexts, root)).not.toThrow();
    expect(
      contexts.reduce((sum, context) => sum + contextBytes(context.text), 0),
    ).toBe(MAX_PROMPT_BYTES);
    const draft = { prompt: '', contexts };
    expect(() => buildDraftPrompt(draft, root)).toThrow(
      /typed text and attached context/,
    );
    expect(draft.contexts).toBe(contexts);
    expect(draft.contexts[0]).toBe(contexts[0]);
  });

  it('validates file provenance and recovered caps before creating a payload', () => {
    const context = createFileReference(root, 'src/main.ts');
    expect(() =>
      buildDraftPrompt({ prompt: '', contexts: [context] }, '/projects/other'),
    ).toThrow(/another project/);
    expect(() =>
      buildDraftPrompt(
        { prompt: '', contexts: [{ ...context, id: 'forged' }] },
        root,
      ),
    ).toThrow(/invalid source identity/);
    expect(() =>
      buildDraftPrompt(
        {
          prompt: '',
          contexts: Array.from({ length: 17 }, (_, i) =>
            createFileReference(root, `src/file-${i}`),
          ),
        },
        root,
      ),
    ).toThrow(/at most 16/);
  });

  it('allows an empty prompt for attachment-only drafts but still requires a project', () => {
    expect(buildDraftPrompt({ prompt: '', contexts: [] }, root)).toBe('');
    expect(() => buildDraftPrompt({ prompt: '', contexts: [] }, '')).toThrow(
      /Choose a project/,
    );
  });
});
