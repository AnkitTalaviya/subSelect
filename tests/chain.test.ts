import { describe, expect, it, vi } from 'vitest';
import { runChain } from '../src/providers/chain';
import { ProviderError } from '../src/providers/types';

const member = (label: string, remote = true) => ({ meta: { label, remote } });

describe('runChain', () => {
  it('uses the first provider that answers', async () => {
    const call = vi.fn().mockResolvedValue('fireworks');
    const outcome = await runChain([member('A'), member('B')], call, { emptyMessage: 'off' });

    expect(outcome).toEqual({ ok: true, data: 'fireworks' });
    // B is never asked, so a working first provider costs exactly one request.
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next provider when one fails', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('provider', 'returned 400'))
      .mockResolvedValueOnce('fireworks');

    const outcome = await runChain([member('LibreTranslate'), member('MyMemory')], call, {
      emptyMessage: 'off',
    });

    expect(outcome).toEqual({ ok: true, data: 'fireworks' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps going past several failures', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('network', 'unreachable'))
      .mockRejectedValueOnce(new ProviderError('provider', 'no entry'))
      .mockResolvedValueOnce('found');

    const outcome = await runChain([member('A'), member('B'), member('C')], call, {
      emptyMessage: 'off',
    });
    expect(outcome).toEqual({ ok: true, data: 'found' });
  });

  it('reports what every provider said when all fail', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new ProviderError('provider', 'returned 400'))
      .mockRejectedValueOnce(new ProviderError('provider', 'daily limit reached'));

    const outcome = await runChain([member('LibreTranslate'), member('MyMemory')], call, {
      emptyMessage: 'off',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('provider');
    expect(outcome.message).toContain('LibreTranslate: returned 400');
    expect(outcome.message).toContain('MyMemory: daily limit reached');
  });

  it('does not leak an unexpected error to the user', async () => {
    const call = vi.fn().mockRejectedValue(new TypeError('x is not a function'));
    const outcome = await runChain([member('A')], call, { emptyMessage: 'off' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe('A: A failed.');
    expect(outcome.message).not.toContain('not a function');
  });

  it('skips providers the gate refuses, and still uses one it allows', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    const gate = vi.fn(async (p: { meta: { label: string } }) =>
      p.meta.label === 'Blocked' ? { kind: 'no-permission' as const, message: 'no permission' } : null,
    );

    const outcome = await runChain([member('Blocked'), member('Allowed')], call, {
      gate,
      emptyMessage: 'off',
    });

    expect(outcome).toEqual({ ok: true, data: 'ok' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports a permission problem distinctly from a provider failure', async () => {
    const outcome = await runChain([member('A')], vi.fn(), {
      gate: async () => ({ kind: 'no-permission' as const, message: 'lookups are off' }),
      emptyMessage: 'off',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The UI offers a settings link for this kind, so the distinction is load-bearing.
    expect(outcome.kind).toBe('no-permission');
  });

  it('moves on when a provider hangs instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        // Chrome's on-device translator can sit here fetching a language pack.
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce('fireworks');

      const pending = runChain([member('On-device'), member('MyMemory')], call, {
        emptyMessage: 'off',
      });
      await vi.advanceTimersByTimeAsync(9000);

      expect(await pending).toEqual({ ok: true, data: 'fireworks' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a chain-wide refusal once, not once per provider', async () => {
    // "Lookups are off" is about the whole chain; prefixing it with each provider's name
    // turned one fact into a wall of identical lines.
    const outcome = await runChain([member('A'), member('B'), member('C')], vi.fn(), {
      gate: async () => ({ kind: 'no-permission' as const, message: 'Lookups are off.', global: true }),
      emptyMessage: 'off',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe('Lookups are off.');
  });

  it('reports the empty message when nothing is configured', async () => {
    const outcome = await runChain([], vi.fn(), { emptyMessage: 'Translation is off.' });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe('not-configured');
    expect(outcome.message).toBe('Translation is off.');
  });
});
