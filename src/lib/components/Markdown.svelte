<script lang="ts">
  import { markdown, linkTarget } from '../markdown';
  import { api } from '../api';
  let {
    text,
    path,
    onopen,
    projectRoot,
  }: {
    text: string;
    path: string;
    onopen: (path: string) => void;
    projectRoot?: string;
  } = $props();
  let error = $state('');
  async function click(event: MouseEvent) {
    const copy = (event.target as Element).closest<HTMLButtonElement>(
      '[data-copy-code]',
    );
    if (copy) {
      try {
        await navigator.clipboard.writeText(
          copy.closest('.code-block')?.querySelector('pre code')?.textContent ??
            '',
        );
        copy.textContent = 'Copied ✓';
      } catch {
        error = 'Could not copy code. Select it and copy manually.';
      }
      return;
    }
    const a = (event.target as Element).closest('a');
    if (!a) return;
    event.preventDefault();
    try {
      const target = linkTarget(
        a.getAttribute('href') ?? '',
        path,
        projectRoot,
      );
      if (target.external) await api.external(target.external);
      else if (target.path) onopen(target.path);
    } catch (e) {
      error = String(e);
    }
  }
</script>

{#if error}<p class="error">{error}</p>{/if}
<!-- Links inside the rendered article are keyboard accessible; clicks are delegated here. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<article class="markdown" onclick={click}>{@html markdown(text)}</article>
