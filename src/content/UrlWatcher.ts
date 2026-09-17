import { TIMING } from '@shared/constants';
import { Disposer, throttleTrailing } from './dom';

/**
 * Detects SPA navigation (§36).
 *
 * YouTube, Netflix and the rest move between videos without a page load, so the content
 * script is never re-injected and has to notice for itself. `popstate` and `hashchange`
 * only cover part of it — a `history.pushState` from the page fires neither, and patching
 * `history` would require running in the page's world, which the architecture avoids.
 *
 * So the fallback is a throttled observer on the document element that compares
 * `location.href`. The handler is a single string comparison, and it only runs on the
 * trailing edge of a 300 ms window.
 */
export class UrlWatcher {
  private readonly disposer = new Disposer();
  private observer: MutationObserver | null = null;
  private lastUrl = location.href;

  constructor(private readonly onChange: (url: string) => void) {}

  start(): void {
    const check = throttleTrailing(() => {
      if (location.href === this.lastUrl) return;
      this.lastUrl = location.href;
      this.onChange(this.lastUrl);
    }, TIMING.urlWatchMs);

    this.disposer.add(() => check.cancel());
    this.disposer.listen(window, 'popstate', () => check());
    this.disposer.listen(window, 'hashchange', () => check());

    // The Navigation API reports same-document navigations directly, including the
    // pushState calls that fire no other event. Where it exists, the DOM observer below
    // is pure overhead and is skipped.
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    if (navigation && typeof navigation.addEventListener === 'function') {
      const onNavigate = (): void => {
        // The URL updates after the event dispatches, so check on the next task.
        setTimeout(() => check(), 0);
      };
      navigation.addEventListener('navigatesuccess', onNavigate);
      navigation.addEventListener('currententrychange', onNavigate);
      this.disposer.add(() => {
        navigation.removeEventListener('navigatesuccess', onNavigate);
        navigation.removeEventListener('currententrychange', onNavigate);
      });
      return;
    }

    this.observer = new MutationObserver(() => check());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.disposer.dispose();
  }
}
