/**
 * Test-harness helpers.
 *
 * The videos here are driven by a canvas MediaStream rather than a media file: it gives a
 * real, sized, playing <video> whose currentTime advances, with nothing to download and
 * no CORS involved. That is enough to exercise ActiveVideoDetector, both adapters,
 * PositionTracker and SelectionManager.
 */

/** German sample lines: umlauts, ß, compounds, contractions, hyphens, multi-line. */
export const LINES = [
  'Ich möchte morgen nach Berlin fahren.',
  'Hallo, wie geht’s?',
  'Ich muss mich heute entscheiden.',
  'Das ist allerdings schwierig.',
  'Die Arbeitslosenversicherung zahlt nicht.',
  'Wir brauchen eine Kfz-Versicherung.',
  'Ich habe gestern\neinen interessanten Film gesehen.',
  'Größe, Mädchen, Straße und Fußball.',
  'Obwohl ich müde bin, lerne ich Deutsch.',
  'Er hat sich für einen neuen Job entschieden.',
];

/** Paints a slow gradient so the video is visibly playing, and returns its stream. */
export function startCanvasVideo(video, { width = 1280, height = 720 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  let frame = 0;
  const draw = () => {
    frame += 1;
    const hue = (frame / 3) % 360;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${hue}, 45%, 22%)`);
    gradient.addColorStop(1, `hsl(${(hue + 70) % 360}, 50%, 46%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // A bright band behind the caption area, so highlight contrast can be judged
    // against something other than a flat dark background.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(0, height * 0.72, width, height * 0.06);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${Math.round(height / 18)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('SubSelect test pattern', width / 2, height * 0.3);

    requestAnimationFrame(draw);
  };
  draw();

  video.srcObject = canvas.captureStream(30);
  video.play().catch(() => {
    // Autoplay can be refused; the page shows a Play button as a fallback.
  });
}

/** Steps through LINES on an interval, handing each one to `render`. */
export function cycleLines(render, intervalMs = 3500) {
  let index = 0;
  const tick = () => {
    render(LINES[index % LINES.length], index);
    index += 1;
  };
  tick();
  return setInterval(tick, intervalMs);
}
