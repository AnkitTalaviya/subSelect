import { EXTENSION_NAME } from './constants';

/**
 * Diagnostics are off unless explicitly asked for, either in settings or per-page with
 * `localStorage.SUBSELECT_DEBUG = '1'` (see docs/COMPATIBILITY.md). Logging on a video
 * page is never free, so the check is a plain boolean read on every call.
 */
let enabled = false;

try {
  enabled = globalThis.localStorage?.getItem('SUBSELECT_DEBUG') === '1';
} catch {
  // localStorage throws on opaque origins and with site data blocked; not an error here.
}

export function setDebugLogging(value: boolean): void {
  enabled = enabled || value;
}

export function isDebugLogging(): boolean {
  return enabled;
}

const prefix = `[${EXTENSION_NAME}]`;

export const log = {
  debug(...args: unknown[]): void {
    if (enabled) console.debug(prefix, ...args);
  },
  info(...args: unknown[]): void {
    if (enabled) console.info(prefix, ...args);
  },
  warn(...args: unknown[]): void {
    if (enabled) console.warn(prefix, ...args);
  },
  /** Errors are always reported: they are the signal that the fail-safe path ran. */
  error(...args: unknown[]): void {
    console.error(prefix, ...args);
  },
};
