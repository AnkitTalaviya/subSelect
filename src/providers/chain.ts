import { ProviderError, type ProviderOutcome } from './types';

/**
 * Tries providers in order and returns the first answer.
 *
 * A single fixed provider turned every outage into a dead end: a rate-limited service, a
 * public instance answering 400 without a key, or a language pair one vendor simply does
 * not carry all reached the user as plain failure. Here a provider that cannot answer is
 * skipped, and only when every one has failed does the user see anything — and then they
 * see what each of them said, which is what makes the problem diagnosable instead of
 * mysterious.
 *
 * Kept free of `chrome.*` so the ordering and error-reporting behaviour is testable; the
 * permission and consent checks arrive through `gate`.
 */

export interface ChainMember {
  meta: { label: string; remote: boolean };
}

export interface Refusal {
  kind: 'not-configured' | 'no-permission';
  message: string;
  /**
   * True when the reason applies to the whole chain, not this provider — lookups being
   * switched off, say. The run stops there and reports the reason once, rather than
   * repeating it behind every provider's name.
   */
  global?: boolean;
}

/** Returns a reason this provider cannot be called, or null if it can. */
export type Gate<P extends ChainMember> = (provider: P) => Promise<Refusal | null>;

/**
 * How long one provider gets before the chain moves on.
 *
 * Without this the chain can stall indefinitely on its first member and the user watches
 * "Translating…" forever: Chrome's on-device translator may have to fetch a language pack
 * on first use, and a wedged public instance can hold a socket open just as long. Moving
 * on is almost always better than waiting — and the download it started continues in the
 * background, so the next attempt is instant.
 */
const PROVIDER_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProviderError('network', `${label} did not respond in time.`)),
      PROVIDER_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runChain<P extends ChainMember, T>(
  providers: readonly P[],
  call: (provider: P) => Promise<T>,
  options: { gate?: Gate<P>; emptyMessage: string },
): Promise<ProviderOutcome<T>> {
  if (providers.length === 0) {
    return { ok: false, kind: 'not-configured', message: options.emptyMessage };
  }

  const failures: string[] = [];
  let blocked = false;

  for (const provider of providers) {
    const refusal = options.gate ? await options.gate(provider) : null;
    if (refusal) {
      if (refusal.global) return { ok: false, kind: refusal.kind, message: refusal.message };
      if (refusal.kind === 'no-permission') blocked = true;
      failures.push(`${provider.meta.label}: ${refusal.message}`);
      continue;
    }

    try {
      return { ok: true, data: await withTimeout(call(provider), provider.meta.label) };
    } catch (error) {
      const message =
        error instanceof ProviderError ? error.message : `${provider.meta.label} failed.`;
      failures.push(`${provider.meta.label}: ${message}`);
    }
  }

  return {
    ok: false,
    // A permission problem is the user's to fix and gets a different message in the UI
    // from a service simply not having the word.
    kind: blocked ? 'no-permission' : 'provider',
    message: failures.join('\n'),
  };
}
