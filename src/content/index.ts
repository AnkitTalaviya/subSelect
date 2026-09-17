import type { ExtensionMessage } from '@shared/messages';
import { sendMessage } from '@shared/messages';
import { log, setDebugLogging } from '@shared/logger';
import { getSettings, onSettingsChanged } from '@shared/storage';
import type { Settings } from '@shared/settings';
import { SubtitleEngine } from './SubtitleEngine';

/**
 * Content-script entry point.
 *
 * One instance per frame, including cross-origin iframes — the parent frame can never
 * reach into a child frame's DOM, so a player inside an iframe is handled by the engine
 * running in that iframe (see docs/FEASIBILITY.md §3). A frame with no video settles to a
 * single idle observer and no timers.
 */

const GUARD = '__subselectContentScript';

interface GuardedWindow {
  [GUARD]?: boolean;
}

function main(): void {
  const guarded = window as unknown as GuardedWindow;
  if (guarded[GUARD]) return;
  guarded[GUARD] = true;

  let engine: SubtitleEngine | null = null;

  const apply = (settings: Settings): void => {
    setDebugLogging(settings.debug);

    if (!settings.enabled) {
      // Off means gone: no overlay, no observers, no listeners, no cost (§42).
      engine?.stop();
      engine = null;
      return;
    }

    if (!engine) {
      engine = new SubtitleEngine(settings, (selection) => {
        void sendMessage({ type: 'SELECTION_CHANGED', selection });
      });
      engine.start();
      return;
    }

    engine.updateSettings(settings);
  };

  chrome.runtime.onMessage.addListener((raw, _sender, respond) => {
    const message = raw as ExtensionMessage;

    switch (message.type) {
      case 'GET_FRAME_STATUS':
        respond(engine?.getStatus() ?? { state: 'disabled', url: location.href });
        return false;

      default:
        return false;
    }
  });

  onSettingsChanged(apply);

  void getSettings()
    .then(apply)
    .catch((error: unknown) => log.error('could not read settings', error));

  window.addEventListener(
    'pagehide',
    () => {
      engine?.stop();
      engine = null;
    },
    { once: true },
  );
}

try {
  main();
} catch (error) {
  // Nothing here may ever affect the page. If the extension cannot start, the page must
  // behave exactly as if it were not installed (§58).
  log.error('content script failed to start', error);
}
