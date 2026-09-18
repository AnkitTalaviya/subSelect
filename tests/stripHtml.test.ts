import { describe, expect, it } from 'vitest';
import { hostOf, originOf, stripHtml } from '../src/providers/url';

describe('stripHtml', () => {
  it('keeps the text and drops the tags', () => {
    expect(stripHtml('a <b>display</b> of <i>fireworks</i>')).toBe('a display of fireworks');
  });

  it('drops a stylesheet and its body', () => {
    /*
     * Regression, seen in a real Wiktionary definition: the gloss arrives with an inline
     * <style> in it, and removing only the tags left the CSS spliced into the middle —
     * "to decide, to make a decision .mw-parser-output .deprecated{color:olivedrab}".
     */
    const gloss =
      'to decide<style data-mw-deduplicate="x">.mw-parser-output .deprecated{color:var(--x,olivedrab)}</style>, to make a decision';
    expect(stripHtml(gloss)).toBe('to decide, to make a decision');
  });

  it('drops a script and its body', () => {
    expect(stripHtml('safe<script>alert(1)</script> text')).toBe('safe text');
  });

  it('decodes the entities a definition actually contains', () => {
    expect(stripHtml('Gr&ouml;&szlig;e &amp; more &#8212; yes')).toBe('Gr&ouml;&szlig;e & more — yes');
    expect(stripHtml('a&nbsp;b &lt;tag&gt;')).toBe('a b <tag>');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('  a \n\n  b  ')).toBe('a b');
  });

  it('leaves German characters intact', () => {
    expect(stripHtml('<b>Größe</b> und <i>Straße</i>')).toBe('Größe und Straße');
  });
});

describe('hostOf / originOf', () => {
  it('reads the host and the match pattern', () => {
    expect(hostOf('https://api.example.com/v2/translate')).toBe('api.example.com');
    expect(originOf('https://api.example.com/v2/translate')).toBe('https://api.example.com/*');
  });

  it('keeps the scheme and port of a self-hosted endpoint', () => {
    // A local LibreTranslate is plain http on a port; assuming https made it unapprovable.
    expect(originOf('http://localhost:5000/translate')).toBe('http://localhost:5000/*');
  });

  it('refuses a non-http scheme and malformed input', () => {
    expect(originOf('ftp://example.com/x')).toBeUndefined();
    expect(originOf('not a url')).toBeUndefined();
    expect(hostOf('not a url')).toBeUndefined();
  });
});
