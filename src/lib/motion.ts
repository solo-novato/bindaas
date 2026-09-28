import { flushSync } from 'svelte';
import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

// Motion is presentation only. Power saving (or macOS Reduce Motion) makes every
// helper here a zero-duration no-op, and app.css removes CSS animations.
export type MotionMode = 'expressive' | 'saving';

const reducedQuery =
  typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null;

export function applyMotionMode(mode: MotionMode | undefined) {
  document.documentElement.dataset.motion =
    mode === 'saving' ? 'saving' : 'expressive';
}

export function motionEnabled() {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.dataset.motion !== 'saving' &&
    !reducedQuery?.matches
  );
}

/** A gentle spring: settles quickly with a small overshoot. */
export function spring(t: number) {
  return 1 - Math.cos(t * Math.PI * 1.35) * Math.exp(-t * 6.2);
}

const none: TransitionConfig = { duration: 0 };

export function rise(
  _node: Element,
  { delay = 0, y = 8, duration = 280 } = {},
): TransitionConfig {
  if (!motionEnabled()) return none;
  return {
    delay,
    duration,
    easing: cubicOut,
    css: (t, u) => `opacity:${t};transform:translateY(${u * y}px)`,
  };
}

/** Springs in from above (from: -1) or rises up from below (from: 1). */
export function drop(
  _node: Element,
  { delay = 0, duration = 460, from = -1 } = {},
): TransitionConfig {
  if (!motionEnabled()) return none;
  return {
    delay,
    duration,
    easing: spring,
    css: (t, u) =>
      `opacity:${Math.min(1, t * 2)};transform:translateY(${14 * from * u}px) scale(${0.97 + 0.03 * t})`,
  };
}

export function pop(
  _node: Element,
  { delay = 0, duration = 320 } = {},
): TransitionConfig {
  if (!motionEnabled()) return none;
  return {
    delay,
    duration,
    easing: spring,
    css: (t) =>
      `opacity:${Math.min(1, t * 1.6)};transform:scale(${0.86 + 0.14 * t})`,
  };
}

/** Numbers roll upward when they change. */
export function roll(
  _node: Element,
  { duration = 260 } = {},
): TransitionConfig {
  if (!motionEnabled()) return none;
  return {
    duration,
    easing: cubicOut,
    css: (t, u) => `opacity:${t};transform:translateY(${u * 60}%)`,
  };
}

// The composer records where a message leaves from; the new bubble flies from there once.
let launch: DOMRect | null = null;
export function markLaunch(from: Element | null | undefined) {
  launch = from && motionEnabled() ? from.getBoundingClientRect() : null;
}
export function flight(node: Element): TransitionConfig {
  const origin = launch;
  launch = null;
  if (!origin || !motionEnabled()) return none;
  const target = node.getBoundingClientRect();
  const dx = origin.left + 16 - target.left;
  const dy = origin.top - target.top;
  if (Math.abs(dy) > innerHeight) return rise(node);
  return {
    duration: 520,
    easing: spring,
    css: (t, u) =>
      `opacity:${Math.min(1, 0.25 + t)};transform:translate(${dx * u}px,${dy * u}px) scale(${0.94 + 0.06 * t});transform-origin:left top`,
  };
}

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

/**
 * Runs a synchronous UI update inside a View Transition when motion is enabled.
 * `animate` receives the transition once its snapshots are ready.
 */
export function viewTransition(update: () => void, animate?: () => void): void {
  const doc = document as TransitionDocument;
  if (!motionEnabled() || !doc.startViewTransition) {
    update();
    return;
  }
  const transition = doc.startViewTransition(() => flushSync(update));
  if (animate) transition.ready.then(animate).catch(() => {});
}

/** Circular theme reveal from a point on screen. */
export function revealFrom(x: number, y: number) {
  const radius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );
  document.documentElement.animate(
    {
      clipPath: [
        `circle(0px at ${x}px ${y}px)`,
        `circle(${radius}px at ${x}px ${y}px)`,
      ],
    },
    {
      duration: 560,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      pseudoElement: '::view-transition-new(root)',
    },
  );
}

/** Soft light that follows the pointer across cards (event-driven, no loops). */
export function spotlight(node: HTMLElement) {
  function move(event: PointerEvent) {
    if (!motionEnabled()) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-spotlight]',
    );
    if (!target || !node.contains(target)) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${event.clientX - box.left}px`);
    target.style.setProperty('--my', `${event.clientY - box.top}px`);
  }
  node.addEventListener('pointermove', move);
  return { destroy: () => node.removeEventListener('pointermove', move) };
}

/**
 * Positions a single highlight behind the active item of a group, so selection
 * glides instead of jumping. Reacts to attribute changes only.
 */
export function slidingIndicator(node: HTMLElement, selector: string) {
  let current = selector;
  function place() {
    const active = node.querySelector<HTMLElement>(current);
    if (!active) {
      node.style.setProperty('--indicator-opacity', '0');
      return;
    }
    node.style.setProperty('--indicator-x', `${active.offsetLeft}px`);
    node.style.setProperty('--indicator-y', `${active.offsetTop}px`);
    node.style.setProperty('--indicator-w', `${active.offsetWidth}px`);
    node.style.setProperty('--indicator-h', `${active.offsetHeight}px`);
    node.style.setProperty('--indicator-opacity', '1');
  }
  const observer = new MutationObserver(place);
  observer.observe(node, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'aria-pressed', 'aria-current', 'aria-selected'],
  });
  const resize = new ResizeObserver(place);
  resize.observe(node);
  place();
  return {
    update(next: string) {
      current = next;
      place();
    },
    destroy() {
      observer.disconnect();
      resize.disconnect();
    },
  };
}
