/**
 * Standalone replay reels: one HTML file that plays a clip's frames with the
 * gesture track drawn back on top — no server, no network, no dependencies.
 *
 * The reel is an ARTIFACT, not a live view: it exists so a session can be
 * handed to a human ("here is what the agent did") after the browser is gone.
 * Everything is inlined (base64 JPEGs + the event ring) and the served copy
 * rides a sandboxing Content-Security-Policy, so even a hostile page label
 * baked into a caption cannot phone home: `default-src 'none'` leaves the
 * document with data: images and its own inline script, nothing else.
 *
 * @module @dsh-community/dsh-browser/reels
 */

export interface ReelFrame {
  t: number
  base64: string
}

export interface ReelEvent {
  t: number
  type: string
  actor: string
  x?: number
  y?: number
  text: string
}

export interface ReelOptions {
  fps: number
  title: string
  url: string
  recordedAt: number
  frames: ReelFrame[]
  events: ReelEvent[]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Assemble the reel document. Deliberately plain ES5-flavoured JavaScript in
 * the player: the artifact outlives the plugin and may be opened years from
 * now in whatever browser exists then.
 */
export function buildReelHtml(options: ReelOptions): string {
  const imgs = options.frames.map(frame => `"${frame.base64}"`).join(',')
  const ts = options.frames.map(frame => String(frame.t)).join(',')
  const events = JSON.stringify(options.events.map(event => ({
    t: event.t,
    type: event.type,
    actor: event.actor,
    ...(typeof event.x === 'number' ? { x: event.x } : {}),
    ...(typeof event.y === 'number' ? { y: event.y } : {}),
    text: event.text,
  })))
  const when = new Date(options.recordedAt).toISOString().slice(0, 10)
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orderzx dsh-browser — agent replay reel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #010409; color: #e6edf3; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 22px 26px 14px; border-bottom: 1px solid rgba(103,232,249,.18); }
  header h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .2px; }
  header h1 b { color: #67e8f9; }
  header p { margin: 0; color: #8b949e; font-size: 12px; }
  header p code { color: #a5d6ff; background: rgba(88,166,255,.12); padding: 1px 6px; border-radius: 5px; }
  main { display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 18px; padding: 18px 26px 30px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .stage { position: relative; border: 1px solid rgba(103,232,249,.3); border-radius: 12px; overflow: hidden; background: #000; }
  .stage img { display: block; width: 100%; height: auto; }
  .mark { position: absolute; pointer-events: none; filter: drop-shadow(0 1px 3px rgba(0,0,0,.8)); }
  .ripple { position: absolute; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2px solid #67e8f9; border-radius: 50%; animation: pop .7s ease-out forwards; }
  .ripple.user { border-color: #f0883e; }
  @keyframes pop { from { transform: scale(.35); opacity: .95; } to { transform: scale(1.7); opacity: 0; } }
  .chip { position: absolute; left: 12px; bottom: 12px; max-width: 72%; padding: 4px 11px; border-radius: 999px; background: rgba(1,4,9,.85); border: 1px solid rgba(88,166,255,.45); color: #a5d6ff; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; backdrop-filter: blur(6px); }
  .chip b { color: #67e8f9; font-weight: 600; }
  .bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .bar button { border: 1px solid rgba(103,232,249,.4); background: rgba(103,232,249,.08); color: #67e8f9; border-radius: 7px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
  .bar input[type=range] { flex: 1; accent-color: #67e8f9; }
  .bar span { color: #8b949e; font-size: 12px; font-variant-numeric: tabular-nums; min-width: 64px; text-align: right; }
  aside { border: 1px solid rgba(139,148,158,.25); border-radius: 12px; padding: 12px 14px; background: rgba(22,27,34,.5); align-self: start; }
  aside h2 { margin: 2px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: #8b949e; }
  ol { margin: 0; padding: 0; list-style: none; }
  ol li { padding: 5px 8px; border-radius: 7px; font-size: 12px; color: #8b949e; display: flex; gap: 8px; align-items: baseline; }
  ol li.on { background: rgba(103,232,249,.12); color: #e6edf3; }
  ol li i { font-style: normal; color: #67e8f9; min-width: 46px; font-variant-numeric: tabular-nums; }
  footer { padding: 0 26px 26px; color: #586069; font-size: 11px; }
</style></head>
<body>
<header>
  <h1><b>Orderzx</b> dsh-browser — agent replay reel</h1>
  <p>recorded ${escapeHtml(when)} · target <code>${escapeHtml(options.url || 'live page')}</code>${escapeHtml(options.title ? ` · ${options.title}` : '')} · ${options.frames.length} frames @ ${options.fps}fps · ${options.events.length} gestures · every frame a genuine page capture, every mark a real tool call</p>
</header>
<main>
  <div>
    <div class="stage" id="stage">
      <img id="frame" alt="agent replay frame">
      <div id="marks"></div>
      <div class="chip" id="chip">press play — the agent's hand draws itself</div>
    </div>
    <div class="bar">
      <button id="play" type="button">❚❚ pause</button>
      <input id="scrub" type="range" min="0" max="${Math.max(0, options.frames.length - 1)}" value="0" step="1" aria-label="frame scrubber">
      <span id="counter">1/${options.frames.length}</span>
    </div>
  </div>
  <aside>
    <h2>gesture track</h2>
    <ol id="track"></ol>
  </aside>
</main>
<footer>Frames are 0o600 JPEGs from the session capture store; the gesture track is the same InteractionRecord ring the live dashboard overlay consumes. Nothing here is simulated.</footer>
<script>
var FRAMES = [${imgs}];
var TS = [${ts}];
var EVENTS = ${events};
var FPS = ${options.fps};
var img = document.getElementById('frame');
var marksEl = document.getElementById('marks'), chip = document.getElementById('chip');
var playBtn = document.getElementById('play'), scrub = document.getElementById('scrub'), counter = document.getElementById('counter');
var trackEl = document.getElementById('track');
var idx = 0, playing = true, timer = null;
var t0 = TS[0] || Date.now();
function escapeHtml(s) { var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
EVENTS.forEach(function (e, i) {
  var li = document.createElement('li');
  li.id = 'ev' + i;
  li.innerHTML = '<i>' + (((e.t - t0) / 1000).toFixed(1)) + 's</i><span>' + (e.actor === 'user' ? 'you · ' : '') + escapeHtml(e.text) + '</span>';
  trackEl.appendChild(li);
});
function frameEnd(i) { return i + 1 < TS.length ? TS[i + 1] : TS[i] + Math.round(1000 / FPS); }
function render() {
  img.src = 'data:image/jpeg;base64,' + FRAMES[idx];
  scrub.value = String(idx);
  counter.textContent = (idx + 1) + '/' + FRAMES.length;
  var start = TS[idx], end = frameEnd(idx);
  var bits = '';
  EVENTS.forEach(function (e) {
    if (typeof e.x !== 'number' || e.t < start || e.t >= end) return;
    var left = (e.x * 100).toFixed(2) + '%', top = (e.y * 100).toFixed(2) + '%';
    bits += '<div class="mark" style="left:' + left + ';top:' + top + '">';
    if (e.type === 'click' || e.type === 'down') bits += '<div class="ripple' + (e.actor === 'user' ? ' user' : '') + '"></div>';
    bits += '<svg width="18" height="18" viewBox="0 0 14 14" fill="none"><path d="M2 1.5 11 7.2 6.6 8.1 8.8 12.4 6.8 13.3 4.7 9 2 11.6Z" fill="' + (e.actor === 'user' ? '#f0883e' : '#58a6ff') + '" stroke="#010409" stroke-width="0.8"/></svg></div>';
  });
  marksEl.innerHTML = bits;
  var caption = null;
  EVENTS.forEach(function (e) { if (e.t <= start) caption = e; });
  chip.innerHTML = caption ? '<b>' + (caption.actor === 'user' ? 'you' : 'agent') + '</b> · ' + escapeHtml(caption.text) : 'press play — the agent\\'s hand draws itself';
  EVENTS.forEach(function (e, i) {
    var li = document.getElementById('ev' + i);
    if (li) li.className = (caption && caption.t === e.t) ? 'on' : '';
  });
}
function tick() { idx = (idx + 1) % FRAMES.length; render(); }
function setPlaying(on) {
  playing = on;
  playBtn.textContent = on ? '❚❚ pause' : '▶ play';
  if (timer) { clearInterval(timer); timer = null; }
  if (on) timer = setInterval(tick, Math.round(1000 / FPS));
}
playBtn.addEventListener('click', function () { setPlaying(!playing); });
scrub.addEventListener('input', function () { idx = Number(scrub.value); render(); });
render();
setPlaying(true);
</script>
</body></html>
`
}
