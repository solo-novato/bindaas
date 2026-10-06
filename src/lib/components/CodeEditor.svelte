<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState, Compartment } from '@codemirror/state';
  import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLine,
    drawSelection,
  } from '@codemirror/view';
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
  } from '@codemirror/commands';
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import {
    bracketMatching,
    defaultHighlightStyle,
    syntaxHighlighting,
    indentOnInput,
  } from '@codemirror/language';
  import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
  import { language } from '../languages';
  import type { Tab, Context } from '../types';
  let {
    tab,
    onchange,
    oncontext,
  }: {
    tab: Tab;
    onchange: (text: string) => void;
    oncontext: (context: Context) => void;
  } = $props();
  let host: HTMLDivElement;
  let view: EditorView | undefined;
  let selected = $state<{ text: string; from: number; to: number } | null>(
    null,
  );
  let error = $state('');
  let mounted = $state(false);
  const editable = new Compartment(),
    grammar = new Compartment(),
    access = new Compartment(),
    fileIdentity = new Compartment();
  let current = '';
  let previousEditing = false;
  let previousReserved = false;
  let previousTab: Tab | undefined;
  let request = 0;
  const theme = EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '13px',
        backgroundColor: 'var(--editor)',
      },
      '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto' },
      '.cm-content': { padding: '16px 0', caretColor: 'var(--text)' },
      '.cm-gutters': {
        backgroundColor: 'var(--editor)',
        color: 'var(--muted)',
        border: 'none',
      },
      '.cm-activeLine': { backgroundColor: 'var(--hover)' },
      '.cm-selectionBackground': { backgroundColor: '#46608466 !important' },
      '&.cm-focused': { outline: 'none' },
    },
    { dark: true },
  );
  function mode(editing: boolean) {
    return [
      ...(editing
        ? [
            history(),
            indentOnInput(),
            bracketMatching(),
            closeBrackets(),
            highlightActiveLine(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              ...closeBracketsKeymap,
              indentWithTab,
            ]),
          ]
        : []),
    ];
  }
  function editAccess(editing: boolean, reserved: boolean) {
    return [
      EditorState.readOnly.of(!editing || reserved),
      EditorView.editable.of(editing && !reserved),
    ];
  }
  function identity(path: string) {
    return EditorView.contentAttributes.of({
      'aria-label': `File contents: ${path}`,
    });
  }
  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        extensions: [
          lineNumbers(),
          drawSelection(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle),
          keymap.of(searchKeymap),
          theme,
          editable.of([]),
          grammar.of([]),
          access.of([]),
          fileIdentity.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onchange(update.state.doc.toString());
            if (update.selectionSet) {
              const range = update.state.selection.main;
              tab.cursor = range.head;
              selected = range.empty
                ? null
                : {
                    text: update.state.sliceDoc(range.from, range.to),
                    from: update.state.doc.lineAt(range.from).number,
                    to: update.state.doc.lineAt(range.to).number,
                  };
            }
          }),
        ],
      }),
    });
    mounted = true;
    return () => {
      if (view) {
        tab.scroll = view.scrollDOM.scrollTop;
        view.destroy();
        view = undefined;
      }
    };
  });
  $effect(() => {
    const path = tab.path,
      text = tab.content ?? '',
      editing = tab.editing,
      reserved = !!tab.fileOperation;
    const ready = mounted;
    if (!ready || !view) return;
    const changedTab = previousTab !== tab;
    if (changedTab) {
      if (previousTab && view) previousTab.scroll = view.scrollDOM.scrollTop;
      previousTab = tab;
      previousEditing = editing;
      previousReserved = reserved;
      selected = null;
      const extensions = [
        lineNumbers(),
        fileIdentity.of(identity(path)),
        drawSelection(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of(searchKeymap),
        theme,
        editable.of(mode(editing)),
        access.of(editAccess(editing, reserved)),
        grammar.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onchange(update.state.doc.toString());
          if (update.selectionSet) {
            const range = update.state.selection.main;
            tab.cursor = range.head;
            selected = range.empty
              ? null
              : {
                  text: update.state.sliceDoc(range.from, range.to),
                  from: update.state.doc.lineAt(range.from).number,
                  to: update.state.doc.lineAt(range.to).number,
                };
          }
        }),
      ];
      view.setState(
        EditorState.create({
          doc: text,
          selection: { anchor: Math.min(tab.cursor, text.length) },
          extensions,
        }),
      );
      view.scrollDOM.scrollTop = tab.scroll;
    } else {
      if (previousEditing !== editing || previousReserved !== reserved) {
        previousReserved = reserved;
        view.dispatch({
          effects: access.reconfigure(editAccess(editing, reserved)),
        });
      }
      if (previousEditing !== editing) {
        previousEditing = editing;
        view.dispatch({ effects: editable.reconfigure(mode(editing)) });
      }
      if (view.state.doc.toString() !== text)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
    }
    if (changedTab || current !== path) {
      current = path;
      error = '';
      view.dispatch({ effects: fileIdentity.reconfigure(identity(path)) });
      const ticket = ++request;
      language(path)
        .then((lang) => {
          if (ticket === request && view)
            view.dispatch({ effects: grammar.reconfigure(lang) });
        })
        .catch((cause) => {
          if (ticket === request) error = String(cause);
        });
    }
  });
</script>

{#if error}<p class="error">Syntax highlighting unavailable: {error}</p>{/if}
<div class="code-host" bind:this={host}></div>
{#if selected}<button
    class="selection-action"
    disabled={!!tab.fileOperation}
    onclick={() =>
      oncontext({
        id: crypto.randomUUID(),
        label: `${tab.path} · lines ${selected!.from}–${selected!.to}`,
        text: `File: ${tab.path}\nLines: ${selected!.from}–${selected!.to}\n\n${selected!.text}`,
      })}>Ask Codex about selection ↗</button
  >{/if}
