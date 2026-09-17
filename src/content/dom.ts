/**
 * DOM helpers shared by the detectors.
 *
 * `document.querySelectorAll` does not pierce shadow boundaries and a MutationObserver on
 * `document` does not see inside one, so shadow support has to be explicit. It also has
 * to be bounded: on a page with tens of thousands of elements an unbounded walk on every
 * scan would be exactly the kind of cost docs/FEASIBILITY.md §7 forbids.
 */

/** Default element budget for one deep traversal. */
const DEFAULT_BUDGET = 15_000;

/** Open shadow roots reachable from `root`, breadth-first, within the element budget. */
export function collectShadowRoots(root: ParentNode, budget = DEFAULT_BUDGET): ShadowRoot[] {
  const remaining = { count: budget };
  const found: ShadowRoot[] = [];
  const queue: ParentNode[] = [root];

  while (queue.length > 0 && remaining.count > 0) {
    const current = queue.shift()!;
    const walker = document.createTreeWalker(current as Node, NodeFilter.SHOW_ELEMENT);

    while (walker.nextNode()) {
      if (--remaining.count <= 0) break;
      const shadow = (walker.currentNode as Element).shadowRoot;
      if (shadow) {
        found.push(shadow);
        queue.push(shadow);
      }
    }
  }

  return found;
}

/** `querySelectorAll` that also searches open shadow roots. */
export function deepQueryAll<T extends Element>(
  root: ParentNode,
  selector: string,
  budget = DEFAULT_BUDGET,
): T[] {
  const results: T[] = [...root.querySelectorAll<T>(selector)];
  for (const shadow of collectShadowRoots(root, budget)) {
    results.push(...shadow.querySelectorAll<T>(selector));
  }
  return results;
}

/** The root node an element lives in — its shadow root, or the document. */
export function rootOf(node: Node): Document | ShadowRoot {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

/** True when the element is rendered and has a non-zero box. */
export function isRendered(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.01;
}

/**
 * Best guess at the player container: the outermost ancestor that still bounds the video
 * reasonably tightly.
 *
 * This is the element that normally goes fullscreen and that holds the caption layer, so
 * it is where an overlay must be mounted — an overlay on `document.body` vanishes in
 * fullscreen, because only the fullscreen element's subtree renders.
 */
export function findPlayerRoot(video: HTMLVideoElement, maxDepth = 8): HTMLElement {
  const videoRect = video.getBoundingClientRect();
  const videoArea = Math.max(1, videoRect.width * videoRect.height);

  let best: HTMLElement = video.parentElement ?? document.body;
  let node: HTMLElement | null = video.parentElement;
  let depth = 0;

  while (node && depth < maxDepth && node !== document.body && node !== document.documentElement) {
    const rect = node.getBoundingClientRect();
    const area = rect.width * rect.height;

    // Stop as soon as an ancestor grows well beyond the video: past that point we would
    // be mounting into page chrome rather than into the player.
    if (area > videoArea * 2.2) break;
    best = node;

    node = node.parentElement;
    depth++;
  }

  return best;
}

/** Runs `fn` at most once per `ms`, always with the trailing call. */
export function throttleTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  let last = 0;

  const invoke = (args: A): void => {
    last = Date.now();
    pending = null;
    fn(...args);
  };

  const wrapped = (...args: A): void => {
    const elapsed = Date.now() - last;
    pending = args;
    if (elapsed >= ms && timer === null) {
      invoke(args);
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) invoke(pending);
    }, Math.max(0, ms - elapsed));
  };

  wrapped.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return wrapped;
}

/**
 * Runs `fn` on each of the next `frames` animation frames, then stops.
 *
 * A bounded burst, never a standing loop: it exists to let a CSS transition on the
 * player's caption box settle, and calling it again while one is running simply extends
 * the current burst rather than stacking a second one.
 */
export function createFrameBurst(fn: () => void, frames: number): {
  trigger: () => void;
  cancel: () => void;
} {
  let handle: number | null = null;
  let left = 0;

  const step = (): void => {
    handle = null;
    fn();
    if (--left > 0) handle = requestAnimationFrame(step);
  };

  return {
    trigger(): void {
      left = frames;
      if (handle === null) handle = requestAnimationFrame(step);
    },
    cancel(): void {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      left = 0;
    },
  };
}

/** Collects teardown functions so a component can be released in one call (§57). */
export class Disposer {
  private disposers: Array<() => void> = [];

  add(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  listen<K extends keyof DocumentEventMap>(
    target: Document | Window | Element,
    type: K | string,
    handler: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type as string, handler, options);
    this.disposers.push(() => target.removeEventListener(type as string, handler, options));
  }

  dispose(): void {
    // Reverse order, so a component tears down in the opposite order it was built.
    for (const dispose of this.disposers.reverse()) {
      try {
        dispose();
      } catch {
        // A failing teardown must not prevent the rest from running.
      }
    }
    this.disposers = [];
  }
}
