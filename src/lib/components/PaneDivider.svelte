<script lang="ts">
  let {
    label,
    controls,
    value,
    min,
    max,
    defaultValue,
    reverse = false,
    onresize,
    oncommit,
  }: {
    label: string;
    controls: string;
    value: number;
    min: number;
    max: number;
    defaultValue: number;
    reverse?: boolean;
    onresize: (value: number) => void;
    oncommit: () => void;
  } = $props();
  let drag: { id: number; x: number; width: number } | null = null;
  let changed = false;
  function set(next: number) {
    const bounded = Math.round(Math.min(max, Math.max(min, next)));
    if (bounded !== value) {
      changed = true;
      onresize(bounded);
    }
  }
  function commit() {
    if (changed) oncommit();
    changed = false;
  }
  function keydown(event: KeyboardEvent) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.shiftKey ? 40 : 10;
    const direction = reverse ? -1 : 1;
    switch (event.key) {
      case 'ArrowLeft':
        set(value - step * direction);
        break;
      case 'ArrowRight':
        set(value + step * direction);
        break;
      case 'Home':
        set(min);
        break;
      case 'End':
        set(max);
        break;
      case 'Enter':
        set(defaultValue);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
</script>

<!-- A focusable ARIA separator is an adjustable splitter, with range values and keyboard controls. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="resize-handle"
  class:right-resize={reverse}
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-controls={controls}
  aria-orientation="vertical"
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-valuetext={`${value} pixels`}
  title={`${label}: ← → resize, Shift for larger steps, Home/End for limits, Enter or double-click to reset`}
  onkeydown={keydown}
  onkeyup={commit}
  onblur={commit}
  ondblclick={() => {
    set(defaultValue);
    commit();
  }}
  onpointerdown={(event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag = { id: event.pointerId, x: event.clientX, width: value };
    event.currentTarget.setPointerCapture(event.pointerId);
  }}
  onpointermove={(event) => {
    if (drag?.id !== event.pointerId) return;
    set(drag.width + (event.clientX - drag.x) * (reverse ? -1 : 1));
  }}
  onpointerup={(event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    commit();
  }}
  onlostpointercapture={() => {
    drag = null;
    commit();
  }}
></div>
