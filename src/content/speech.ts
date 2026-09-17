import { log } from '@shared/logger';

/**
 * Pronunciation via the browser's own speech synthesis (§28).
 *
 * No provider, no configuration, no network request of our own — which is why this is
 * usable now rather than waiting for the provider work in Phase 4/6.
 *
 * **One privacy caveat, handled explicitly.** Chrome exposes both local (OS) voices and
 * Google's network voices; `SpeechSynthesisVoice.localService` tells them apart. A network
 * voice means the selected word is sent to Google to be spoken. So a local voice for the
 * requested language is always preferred, and `willUseRemoteVoice` lets the UI disclose it
 * when only a network voice exists (§33).
 */

export function isSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Voices whose language matches `language`, exact region first, then the base language. */
function candidatesFor(language: string | undefined): SpeechSynthesisVoice[] {
  const voices = window.speechSynthesis.getVoices();
  if (!language) return voices;

  const wanted = language.toLowerCase();
  const base = wanted.split('-')[0] ?? wanted;

  const exact = voices.filter((voice) => voice.lang.toLowerCase() === wanted);
  const sameBase = voices.filter(
    (voice) => voice.lang.toLowerCase().split('-')[0] === base && !exact.includes(voice),
  );
  return [...exact, ...sameBase];
}

function pickVoice(language: string | undefined): SpeechSynthesisVoice | null {
  const candidates = candidatesFor(language);
  return candidates.find((voice) => voice.localService) ?? candidates[0] ?? null;
}

/**
 * True when speaking this language would go through a network voice.
 *
 * The voice list can be empty until the engine has loaded it, in which case this reports
 * false — we do not warn about something we cannot yet determine.
 */
export function willUseRemoteVoice(language: string | undefined): boolean {
  if (!isSpeechAvailable()) return false;
  const voice = pickVoice(language);
  return voice ? !voice.localService : false;
}

export function speak(text: string, language?: string): boolean {
  if (!isSpeechAvailable() || !text.trim()) return false;

  try {
    const synth = window.speechSynthesis;
    // Replace whatever is being said rather than queueing behind it: the user asked for
    // this word, not for a backlog.
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(language);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else if (language) {
      utterance.lang = language;
    }

    synth.speak(utterance);
    return true;
  } catch (error) {
    log.warn('speech synthesis failed', error);
    return false;
  }
}

export function stopSpeaking(): void {
  if (!isSpeechAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Nothing to stop.
  }
}
