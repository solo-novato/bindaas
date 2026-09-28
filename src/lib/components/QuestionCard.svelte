<script lang="ts">
  import { tick } from 'svelte';
  import { api } from '../api';
  import { agentName, harnessOf } from '../harness';
  import type { Approval } from '../types';
  import { cubicOut } from 'svelte/easing';
  import { drop, motionEnabled } from '../motion';
  let {
    approval,
    onresolved,
  }: { approval: Approval; onresolved: (id: string) => void } = $props();
  const agentLabel = $derived(agentName(harnessOf(approval.threadId)));
  let multiple = $state<Record<string, string[]>>({});
  let index = $state(0);
  let direction = 1;
  // Steps slide in from the side you are moving toward.
  function step(_node: Element) {
    if (!motionEnabled()) return { duration: 0 };
    const x = 24 * direction;
    return {
      duration: 260,
      easing: cubicOut,
      css: (t: number, u: number) =>
        `opacity:${t};transform:translateX(${u * x}px)`,
    };
  }
  let selected = $state<Record<string, string>>({});
  let custom = $state<Record<string, string>>({});
  let busy = $state(false);
  let error = $state('');
  let heading = $state<HTMLHeadingElement>();
  let body = $state<HTMLDivElement>();
  const questions = $derived(approval.questions ?? []);
  const current = $derived(questions[index]);
  function answer(id: string): string | string[] {
    if (
      questions.find((q) => q.id === id)?.multiSelect &&
      selected[id] !== '__custom'
    )
      return multiple[id] ?? [];

    return selected[id] === '__custom' ||
      !questions.find((q) => q.id === id)?.options?.length
      ? (custom[id] ?? '').trim()
      : (selected[id] ?? '');
  }
  const answered = $derived(
    questions.filter((q) => answer(q.id).length > 0).length,
  );
  async function go(next: number) {
    direction = next >= index ? 1 : -1;
    index = next;
    await tick();
    if (body) body.scrollTop = 0;
    heading?.focus({ preventScroll: true });
  }
  function revealAnswer(field: HTMLElement) {
    if (!body) return;
    body.scrollTop +=
      field.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  }
  async function chooseCustom() {
    await tick();
    const field = body?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '.custom-answer input, .custom-answer textarea',
    );
    if (field) {
      field.focus({ preventScroll: true });
      revealAnswer(field);
    }
  }
  $effect(() => {
    if (!body) return;
    const observer = new ResizeObserver(() => {
      const field = document.activeElement;
      if (
        field instanceof HTMLElement &&
        body?.contains(field) &&
        field.matches('.custom-answer input, .custom-answer textarea')
      )
        revealAnswer(field);
    });
    observer.observe(body);
    return () => observer.disconnect();
  });
  async function submit() {
    if (busy || answered !== questions.length || !questions.length) return;
    busy = true;
    error = '';
    try {
      await api.respond(
        approval.generation,
        approval.requestId,
        null,
        Object.fromEntries(questions.map((q) => [q.id, answer(q.id)])),
        approval.threadId,
      );
      onresolved(approval.requestId);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section
  class="question-card"
  aria-label={`Questions from ${agentLabel}`}
  in:drop|global={{ from: 1 }}
>
  <div class="question-topline">
    <span>✳ {agentLabel} needs your input</span><span aria-live="polite"
      >{index + 1} of {questions.length}</span
    >
  </div>
  {#if current}
    {#if questions.length > 1}<nav
        class="question-steps"
        aria-label="Questions"
      >
        {#each questions as question, i}<button
            class:chosen={i === index}
            aria-current={i === index ? 'step' : undefined}
            disabled={busy}
            onclick={() => go(i)}
            >{answer(question.id).length ? '✓' : i + 1}
            {question.header}</button
          >{/each}
      </nav>{/if}
    <div class="question-body" bind:this={body}>
      {#key index}<div class="question-step" in:step>
          <h3 bind:this={heading} tabindex="-1">{current.question}</h3>
          <fieldset disabled={busy} class="question-options">
            <legend class="sr-only"
              >{current.header || 'Choose an answer'}</legend
            >
            {#each current.options ?? [] as option, i}
              <label
                class="question-option"
                class:selected={current.multiSelect
                  ? multiple[current.id]?.includes(option.label)
                  : selected[current.id] === option.label}
              >
                {#if current.multiSelect}<input
                    type="checkbox"
                    checked={multiple[current.id]?.includes(option.label) ??
                      false}
                    onchange={(e) => {
                      selected[current.id] = '';
                      multiple[current.id] = e.currentTarget.checked
                        ? [...(multiple[current.id] ?? []), option.label]
                        : (multiple[current.id] ?? []).filter(
                            (v) => v !== option.label,
                          );
                    }}
                  />{:else}
                  <input
                    type="radio"
                    name={`question-${approval.requestId}-${current.id}`}
                    value={option.label}
                    bind:group={selected[current.id]}
                  />{/if}
                <span class="option-number">{i + 1}</span>
                <span
                  ><strong>{option.label}</strong>{#if option.description}<small
                      >{option.description}</small
                    >{/if}</span
                >
              </label>
            {/each}
            {#if current.options?.length}<label
                class="question-option"
                class:selected={selected[current.id] === '__custom'}
              >
                <input
                  type="radio"
                  name={`question-${approval.requestId}-${current.id}`}
                  value="__custom"
                  bind:group={selected[current.id]}
                  onchange={chooseCustom}
                />
                <span
                  ><strong>Write your own answer</strong><small
                    >Add a different approach or more context.</small
                  ></span
                >
              </label>{/if}
            {#if !current.options?.length || selected[current.id] === '__custom'}
              <label class="custom-answer"
                >Your answer
                {#if current.isSecret}<input
                    type="password"
                    autocomplete="off"
                    maxlength="16000"
                    bind:value={custom[current.id]}
                    onfocus={(event) => revealAnswer(event.currentTarget)}
                  />
                {:else}<textarea
                    rows="3"
                    maxlength="16000"
                    placeholder={`Tell ${agentLabel} what you’d like…`}
                    bind:value={custom[current.id]}
                    onfocus={(event) => revealAnswer(event.currentTarget)}
                  ></textarea>{/if}
              </label>
            {/if}
          </fieldset>
        </div>{/key}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>
    <div class="question-footer">
      <span>{answered} of {questions.length} answered</span>
      <div>
        <button disabled={busy || index === 0} onclick={() => go(index - 1)}
          >Back</button
        >
        {#if index < questions.length - 1}<button
            class="primary"
            disabled={busy || !answer(current.id).length}
            onclick={() => go(index + 1)}>Next →</button
          >
        {:else}<button
            class="primary"
            disabled={busy || answered !== questions.length}
            onclick={submit}>{busy ? 'Sending…' : 'Submit answers'}</button
          >{/if}
      </div>
    </div>
  {/if}
</section>
