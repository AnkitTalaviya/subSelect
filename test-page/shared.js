/**
 * Test-harness helpers.
 *
 * A **classic script**, not an ES module, and loaded with a plain <script src>. Chrome
 * blocks ES module imports over file:// — the origin is opaque, so the fetch fails CORS
 * and the importing script never executes at all. These pages have to work when opened
 * straight from disk, so everything hangs off one global instead.
 *
 * The videos are driven by a canvas MediaStream rather than a media file: a real, sized,
 * playing <video> whose currentTime advances, with nothing to download.
 */
var SubSelectTest = (function () {
  'use strict';

  /** German sample lines: umlauts, ß, compounds, contractions, hyphens, multi-line. */
  var LINES = [
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

  /** Paints a slow gradient so the video is visibly playing, and attaches its stream. */
  function startCanvasVideo(video, options) {
    var width = (options && options.width) || 1280;
    var height = (options && options.height) || 720;

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');

    var frame = 0;
    function draw() {
      frame += 1;
      var hue = (frame / 3) % 360;
      var gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, 'hsl(' + hue + ', 45%, 22%)');
      gradient.addColorStop(1, 'hsl(' + ((hue + 70) % 360) + ', 50%, 46%)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      // A bright band behind the caption area, so highlight contrast can be judged
      // against something other than a flat dark background.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillRect(0, height * 0.72, width, height * 0.06);

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = Math.round(height / 18) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SubSelect test pattern', width / 2, height * 0.3);

      requestAnimationFrame(draw);
    }
    draw();

    video.srcObject = canvas.captureStream(30);
    var played = video.play();
    if (played && played.catch) {
      played.catch(function () {
        // Autoplay can be refused; the page shows a Play button as a fallback.
      });
    }
  }

  /** Steps through LINES on an interval, handing each one to `render`. */
  function cycleLines(render, intervalMs) {
    var index = 0;
    function tick() {
      render(LINES[index % LINES.length], index);
      index += 1;
    }
    tick();
    return setInterval(tick, intervalMs || 3500);
  }

  /**
   * Reports what the *page* can see, which separates a broken page from a broken
   * extension. If the video is not playing or no caption text exists, the extension was
   * never given anything to work with.
   */
  function startDiagnostics(target, video, captionsFn) {
    function update() {
      var overlay = document.querySelector('.subselect-layer');
      var words = document.querySelectorAll('.subselect-word');
      var rows = [
        ['Page: video playing', video && !video.paused && video.readyState >= 2],
        ['Page: caption text on screen', Boolean(captionsFn && captionsFn())],
        ['SubSelect: overlay present', Boolean(overlay)],
        ['SubSelect: clickable words', words.length > 0 ? words.length + ' words' : false],
      ];

      target.replaceChildren.apply(
        target,
        rows.map(function (row) {
          var li = document.createElement('li');
          var ok = Boolean(row[1]);
          li.className = ok ? 'ok' : 'bad';
          li.textContent = (ok ? '✓ ' : '✗ ') + row[0] + (typeof row[1] === 'string' ? ' — ' + row[1] : '');
          return li;
        }),
      );
    }
    update();
    setInterval(update, 1000);
  }

  return {
    LINES: LINES,
    startCanvasVideo: startCanvasVideo,
    cycleLines: cycleLines,
    startDiagnostics: startDiagnostics,
  };
})();
