// The Rufi dog. Not under the Apache License: the Rufi name and everything in
// packages/brand/mark/ belong to mahesh0431. All rights reserved. See TRADEMARKS.md.

// Rufi, the folded-paper dog: the one source for the mark.
// Everything (palette, expression, size, ground) is an option; nothing is drawn twice.
// A plain ES module with no dependencies: the website, the app and the build script all import it.
// The face: slim pill eyes, a rounded triangle nose and line mouths; the eyes and the mouth change shape smoothly between
// expressions in live(). White paper with the folds in the fold colour; the head and ears are flat with a few quiet tones.

// ---- palettes: the ground (bg), the paper, the folds (accent), the face (ink) and the signs ----
const PALETTES = {
  inkApricot:   { name: 'Ink & apricot', bg: '#1B2430', paper: '#F6F4EF', accent: '#EE9A5B', ink: '#1B2430', sign: '#EE9A5B' },
  onApricot:    { name: 'On apricot',    bg: '#EE9A5B', paper: '#F8F5EF', accent: '#C9662E', ink: '#3A4556', sign: '#C9662E' },
  onPeriwinkle: { name: 'On periwinkle', bg: '#C9D0FF', paper: '#FFFFFF', accent: '#EE9A5B', ink: '#3A4556', sign: '#EE9A5B' },
};

// ---- expressions: line mouths only, the smile by default ('flat' for serious moments) ----
// eyeForm is a PILL form (both eyes, or [left, right]) and mouth a MOUTH form. live() also uses gaze (follow: the pointer, with
// small glances when it rests; think, read, type: moves of their own), blink, and enter (a short first beat). motion: the CSS moves
// (motion.css) of the ears and the whole mark, and of the eyes when live() is not running.
const EXPRESSIONS = {
  calm:      { name: 'Calm',            mouth: 'smile', motion: 'blink twitch', eyeForm: 'open', gaze: 'follow', blink: 1, use: 'The logo; idle' },
  hello:     { name: 'Hello',           mouth: 'smile', motion: 'blink2',       eyeForm: 'open', gaze: 'follow', blink: 1, enter: { eyeForm: 'happy', mouth: 'grin', ms: 1100 }, use: 'First run, a new chat' },
  listening: { name: 'Listening',       mouth: 'smile', motion: 'lift blink',   eyeForm: 'wide', gaze: 'follow', blink: 1, look: [0, -4], use: 'You are speaking' },
  typing:    { name: 'You are typing',  mouth: 'small', motion: 'typing blink', eyeForm: 'open', gaze: 'type', blink: 1, look: [-6, 10], use: 'You are typing' },
  thinking:  { name: 'Thinking',        mouth: 'flat',  motion: 'look',         eyeForm: 'soft', gaze: 'think', blink: 1, sign: 'dots', use: 'The AI is working' },
  reading:   { name: 'Reading',         mouth: 'small', motion: 'read',         eyeForm: 'soft', gaze: 'read', blink: 1, use: 'Reading a report you added' },
  found:     { name: 'Found something', mouth: 'grin',  motion: 'wide lift',    eyeForm: 'wide', gaze: 'follow', blink: 1, enter: { eyeForm: 'pop', ms: 420, bounce: 1 }, sign: 'sparkle', use: 'Curious, not alarmed' },
  question:  { name: 'Question',        mouth: 'small', motion: 'curious tilt blink', eyeForm: ['wide', 'soft'], gaze: 'follow', blink: 1, look: [6, -6], sign: 'question', use: 'Rufi needs you to decide' },
  done:      { name: 'Done',            mouth: 'grin',  motion: 'happy hop',    eyeForm: 'happy', use: 'A job is finished' },
  playful:   { name: 'Playful',         mouth: 'grin',  motion: 'happy',        eyeForm: 'happy', gaze: 'follow', use: 'A light moment; rarely' },
  tip:       { name: 'Tip',             mouth: 'smile', motion: 'wink',         eyeForm: ['open', 'happy'], look: [4, -3], sign: 'spark', use: 'A hint' },
  steady:    { name: 'Steady',          mouth: 'flat',  motion: 'blink',        eyeForm: 'soft', blink: 1, look: [0, 12], use: 'A serious topic' },
  sorry:     { name: 'Sorry',           mouth: 'frown', motion: 'earsdown blink', eyeForm: 'low', blink: 1, look: [-10, 14], use: 'Rufi could not do it' },
  sleepy:    { name: 'Sleepy',          mouth: 'small', motion: 'sleepy',       eyeShape: 'lid', eyeForm: 'sleepy', blink: 'slow', look: [0, 6], use: 'About to pause' },
  resting:   { name: 'Resting',         mouth: 'small', motion: 'earsdown breathe', eyeShape: 'closed', eyeForm: 'closed', sign: 'z', use: 'Paused or offline' },
  alert:     { name: 'Alert',           mouth: 'smile', motion: 'blink oneear', eyeForm: 'open', gaze: 'follow', blink: 1, enter: { eyeForm: 'wide', ms: 700, bounce: 1 }, use: 'Something new came in' },
};

// ---- helpers ----
let uid = 0;
const hex = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');const mirror = (pts) => pts.map(([x, y]) => [1000 - x, y]);
const poly = (pts) => 'M' + pts.map((p) => p.join(' ')).join('L') + 'Z';

// r is the corner radius; with even = true, r is how far each corner is cut back instead, so wide corners soften as much as sharp ones
function roundPoly(P, r, even = false) {
  const n = P.length; let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n];
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    const ang = Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2));
    const t = Math.min(even ? r : r / Math.tan(ang / 2), l1 / 2, l2 / 2), rr = t * Math.tan(ang / 2);
    const a = [p1[0] + v1[0] / l1 * t, p1[1] + v1[1] / l1 * t], b = [p1[0] + v2[0] / l2 * t, p1[1] + v2[1] / l2 * t];
    const sweep = (v1[0] * v2[1] - v1[1] * v2[0]) < 0 ? 1 : 0;
    d += (i ? 'L' : 'M') + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + `A${rr.toFixed(1)} ${rr.toFixed(1)} 0 0 ${sweep} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return d + 'Z';
}
function squircle(cx, cy, r, n = 5) {
  let d = '';
  for (let i = 0; i <= 360; i += 2) {
    const t = i * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    d += (i ? 'L' : 'M') + (cx + r * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(1) + ' ' + (cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(1);
  }
  return d + 'Z';
}

// ---- geometry, on the 1000 grid; the left side is drawn, the right is its mirror ----
const G = {
  flap: [[355, 155], [130, 290], [187, 462]],                 // the ear flap; its crease runs from the first to the last point
  fold: [[355, 155], [187, 462], [280, 365], [362, 285]],     // the turned-over paper between the crease and the head
  back: [[355, 155], [422, 220], [362, 285]],                 // the small facet behind the ear
  body: [[355, 155], [422, 220], [578, 220], [645, 155], [813, 462], [720, 365], [750, 600], [576, 776], [424, 776], [250, 600], [280, 365], [187, 462]],
  // the whole outline (body and both ear flaps); rounding this one shape keeps the ear tips clean
  outline: [[355, 155], [422, 220], [578, 220], [645, 155], [870, 290], [813, 462], [720, 365], [750, 600], [576, 776], [424, 776], [250, 600], [280, 365], [187, 462], [130, 290]],
  headL: [[422, 220], [500, 220], [500, 776], [424, 776], [250, 600], [280, 365]],
  headR: [[500, 220], [578, 220], [720, 365], [750, 600], [576, 776], [500, 776]],
  eyes: [387, 613], eyeY: 486,                         // the pill eyes' centres
  nose: [[424, 568], [576, 568], [500, 660]],          // a small rounded triangle
  stroke: 22, strokeSmall: 28,                          // the line under the nose and the smile; heavier in small icons
};

// ---- pill eyes: each eye is one path made from five numbers, so any form can turn smoothly into any other ----
const PILL = {
  open:   { w: 32, t: 54, b: 54, d: 0, k: 0.82, lid: 0 },
  wide:   { w: 34, t: 59, b: 57, d: 0, k: 0.82, lid: 0 },     // attentive
  pop:    { w: 37, t: 66, b: 61, d: 0, k: 0.82, lid: 0 },     // the first moment of a surprise
  soft:   { w: 32, t: 40, b: 53, d: 4, k: 0.8, lid: 0.55 },   // the upper lid a little down: calm, busy
  low:    { w: 33, t: 18, b: 48, d: 8, k: 0.8, lid: 1, tilt: 11 },    // sorry: heavy lids that droop to the outside
  sleepy: { w: 33, t: 4, b: 48, d: 6, k: 0.8, lid: 1 },       // heavy lids
  shut:   { w: 34, t: -22, b: 38, d: 24, k: 0.5, lid: 1 },    // a blink, at its closed moment: the upper lid comes down to a line low in the eye
  closed: { w: 35, t: -24, b: 44, d: 14, k: 0.5, lid: 0.3 },  // closed and content, like a soft u
  happy:  { w: 35, t: 36, b: -12, d: 22, k: 0.62, lid: 0 },   // smiling eyes, like an upside-down u
};
const PILL_DEPTH = 0.06;   // looking sideways, the far pill gets only this much narrower than the near one
function pillPath(cx, cy, { w, t, b, d, k, lid = 0, tilt = 0 }, side = 1) {
  const m = 0.56, ey = cy + d, ty = cy - t, by = cy + b, a = side * tilt * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const P = (x, y) => { const u = x - cx, v = y - cy; return (cx + u * ca - v * sa).toFixed(1) + ' ' + (cy + u * sa + v * ca).toFixed(1); };
  const l = Math.sqrt(Math.max(0, lid)), kt = k * (1 - 0.9 * l), mt = m + 0.44 * l;   // the top: a lid gives it short corners and a flat middle;
  // the square root makes the top go flat early in a change, before the eye gets small
  return `M${P(cx - w, ey)}C${P(cx - w, ey + (ty - ey) * kt)} ${P(cx - w * mt, ty)} ${P(cx, ty)}C${P(cx + w * mt, ty)} ${P(cx + w, ey + (ty - ey) * kt)} ${P(cx + w, ey)}`
    + `C${P(cx + w, ey + (by - ey) * k)} ${P(cx + w * m, by)} ${P(cx, by)}C${P(cx - w * m, by)} ${P(cx - w, ey + (by - ey) * k)} ${P(cx - w, ey)}Z`;
}
// eye i (0 left, 1 right) in form p, looking [lx, ly]: it moves that way and gets a little narrower or shorter, as the solid eyes do
function pillAt(i, p, lx = 0, ly = 0) {
  const [sx, sy] = turnScale(lx, ly, i, PILL_DEPTH);
  return pillPath(G.eyes[i] + lx, G.eyeY + ly, { ...p, w: p.w * sx, t: p.t * sy, b: p.b * sy, d: p.d * sy }, i ? 1 : -1);
}
// ---- mouths: the line under the nose, then the mouth line. cw = half the width, yc = the corners' height, yb = the middle's, f = half the flat middle
const MOUTH = {
  smile: { cw: 70, yc: 678, yb: 706, f: 34 },
  small: { cw: 58, yc: 688, yb: 704, f: 26 },
  grin:  { cw: 80, yc: 668, yb: 716, f: 38 },
  flat:  { cw: 52, yc: 702, yb: 702, f: 52 },
  frown: { cw: 50, yc: 714, yb: 701, f: 22 },
};
function mouthPath({ cw, yc, yb, f }) {
  const L = 500 - cw, A = 500 - f, n = (v) => v.toFixed(1);
  const c1 = [L + (A - L) * 0.2, yc + (yb - yc) * 0.68], c2 = [A - (A - L) * 0.35, yb];
  return `M500 650V${n(yb)}M${n(L)} ${n(yc)}C${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(yb)} ${n(A)} ${n(yb)}H${n(1000 - A)}`
    + `C${n(1000 - c2[0])} ${n(yb)} ${n(1000 - c1[0])} ${n(c1[1])} ${n(1000 - L)} ${n(yc)}`;
}
// a form is a name or its numbers; eyes take one form for both, or [left, right]
const formsOf = (f) => (Array.isArray(f) ? f : [f, f]).map((n) => ({ lid: 0, tilt: 0, ...(n && typeof n === 'object' ? n : PILL[n] || PILL.open) }));
const mouthOf = (m) => (m && typeof m === 'object' ? m : MOUTH[m] || MOUTH.smile);
// ---- the face: pill eyes, a triangle nose, line mouths ----
// Looking at [lx, ly] (lx up to 18, ly up to 14) the eyes move that way and get a little narrower (sideways; the far eye more,
// as when a head turns) or shorter (up or down); the nose and mouth follow by FEAT, so the whole face turns.
const FEAT = 0.5, NARROW = 0.12, FLAT = 0.16;
function turnScale(lx, ly, i, depth) {
  let u = lx / 18, v = ly / 14; const m = Math.hypot(u, v); if (m > 1) { u /= m; v /= m; }
  const far = i ? u > 0 : u < 0;
  return [1 - NARROW * Math.abs(u) - (far ? depth * Math.abs(u) : 0), 1 - FLAT * Math.abs(v)];
}
function face(o, P) {
  const e = P.ink, sw = o.small ? G.strokeSmall : G.stroke, st = `fill="none" stroke="${e}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`;
  const [lx, ly] = o.look || [0, 0], turn = !o.small, forms = formsOf(o.eyeForm);
  let s = `<g class="eyes">`;
  for (const i of [0, 1]) {
    // the eye is drawn where it looks; live() redraws its path on every frame. In small icons it stays still.
    s += `<g class="eye pill"><path${o.small ? '' : ` class="eye-shape" data-i="${i}"`} d="${o.small ? pillAt(i, forms[i]) : pillAt(i, forms[i], lx, ly)}" fill="${e}"/></g>`;
  }
  s += `</g><g class="feat"${turn ? ` data-turn="${FEAT}"` : ''}${turn && (lx || ly) ? ` transform="translate(${lx * FEAT} ${ly * FEAT})"` : ''}>`;
  s += `<path d="${roundPoly(G.nose, 18)}" fill="${e}"/>`;
  s += `<path class="mouth" d="${mouthPath(mouthOf(o.mouth))}" ${st}/>`;
  return s + '</g>';
}

// ---- signs, by the right ear (hidden at 32 px and below) ----
function sign(k, c, inTile) {
  const wrap = (g) => `<g transform="${inTile ? 'translate(840 222) scale(1.1)' : 'translate(880 182) scale(1.4)'} translate(-890 -168)">${g}</g>`;
  const st = `fill="none" stroke="${c}" stroke-linecap="round" stroke-linejoin="round"`;
  if (k === 'z') return wrap(`<g class="sign sign-z" ${st} stroke-width="14"><path class="z1" d="M836 250h36l-36 40h36"/><path class="z2" d="M884 168h26l-26 29h26" stroke-width="11"/></g>`);
  if (k === 'question') return wrap(`<g class="sign sign-q"><path d="M864 116c0-22 17-37 38-37s38 15 38 35c0 26-36 29-36 54" ${st} stroke-width="16"/><circle cx="904" cy="210" r="11" fill="${c}"/></g>`);
  if (k === 'dots') return wrap(`<g class="sign sign-dots" fill="${c}"><circle class="d1" cx="836" cy="186" r="15"/><circle class="d2" cx="884" cy="186" r="15"/><circle class="d3" cx="932" cy="186" r="15"/></g>`);
  const star = (x, y, r) => `M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z`;
  if (k === 'sparkle') return wrap(`<g class="sign sign-sparkle" fill="${c}"><path class="s1" d="${star(880, 150, 44)}"/><path class="s2" d="${star(940, 238, 22)}"/></g>`);
  if (k === 'spark') return wrap(`<g class="sign sign-sparkle" fill="${c}"><path class="s1" d="${star(890, 160, 36)}"/></g>`);
  return '';
}

// ---- the mark: one folded sheet, flat, with a few quiet tones; light from the top left ----
function mark(o = {}) {
  const P = { ...PALETTES.inkApricot, ...(typeof o.palette === 'string' ? PALETTES[o.palette] : o.palette || {}) };
  const id = 'v' + (uid++), flat = o.flat || o.small, K = '#000000';
  const D = (t) => mix(P.paper, K, t), AD = (t) => mix(P.accent, K, t), AL = (t) => mix(P.accent, '#FFFFFF', t);
  const F = (pts, fill, cls) => `<path${cls ? ` class="${cls}"` : ''}${cls === 'back' ? ' opacity="0"' : ''} d="${poly(pts)}" fill="${fill}" stroke="${fill}" stroke-width="1.2" stroke-linejoin="round"/>`;
  const stop = (o, c) => `<stop offset="${o}" stop-color="${c}"/>`;
  const grad = (n, x1, y1, x2, y2, a, b) => `<linearGradient id="${id}${n}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stop(0, a)}${stop(1, b)}</linearGradient>`;
  const PF = (pts, t, cls) => F(pts, D(t), cls), PG = (pts, n, t) => (flat ? PF(pts, t) : F(pts, `url(#${id}${n})`));
  const f = (n, solid) => (flat ? solid : `url(#${id}${n})`);
  const R = o.round ?? 18;   // how far every corner of the outline is cut back: 18 is slightly soft (4 is sharp)
  let s = `<defs><clipPath id="${id}c"><path d="${roundPoly(G.outline, R, true)}"/></clipPath>`
    + `<clipPath id="${id}l"><path d="${poly(G.flap)}"/></clipPath><clipPath id="${id}r"><path d="${poly(mirror(G.flap))}"/></clipPath>`;
  // only the folds and the facets behind the ears carry a soft gradient; everything else is flat
  if (!flat) s += grad('kl', 250, 300, 330, 260, AD(0.08), AL(0.12)) + grad('kr', 729, 308, 669, 341, AD(0.16), AD(0.02))
    + grad('bl', 360, 180, 400, 250, D(0.04), D(0.12)) + grad('br', 640, 180, 600, 250, D(0.08), D(0.16));
  s += `</defs>`;
  s += `<g class="under" opacity="0" clip-path="url(#${id}c)">${F(G.flap, AD(0.12))}${F(mirror(G.flap), AD(0.18))}</g>`;
  s += `<g clip-path="url(#${id}c)">`
    + F(G.fold, f('kl', P.accent)) + F(mirror(G.fold), f('kr', AD(0.08)))
    + PF(G.headL, 0) + PF(G.headR, 0.04);
  s += PG(G.back, 'bl', 0.04) + PG(mirror(G.back), 'br', 0.08);
  s += `</g>`;
  // each flap is cut by its own shape and by the rounded outline (which turns with the flap when it moves)
  s += `<g class="flapL"><g clip-path="url(#${id}c)"><g clip-path="url(#${id}l)">${PF(G.flap, 0, 'front')}${F(G.flap, f('kl', P.accent), 'back')}</g></g></g>`;
  s += `<g class="flapR"><g clip-path="url(#${id}c)"><g clip-path="url(#${id}r)">${PF(mirror(G.flap), 0.025, 'front')}${F(mirror(G.flap), f('kr', P.accent), 'back')}</g></g></g>`;
  s += `<g class="face">${face(o, P)}</g>`;
  if (!o.small) s += `<g class="signs" data-c="${P.sign || P.accent}"${o.inTile ? ' data-tile="1"' : ''}>${o.sign ? sign(o.sign, P.sign || P.accent, o.inTile) : ''}</g>`;
  return s;
}

// ---- a complete <svg>. opts: { palette, expression, size, ground: 'none'|'tile'|'circle', ...mark options }
//      motion: false = still; a string of class names (e.g. 'blink lift') = your own motion; omitted = the expression's ----
function svg(opts = {}) {
  const e = EXPRESSIONS[opts.expression || 'calm'] || {};
  const moves = opts.motion === false ? '' : typeof opts.motion === 'string' ? opts.motion : e.motion || '';
  const x = { ...e, ...opts };
  const size = x.size || 256, small = x.small ?? size <= 32, ground = x.ground || 'none';
  const P = { ...PALETTES.inkApricot, ...(typeof x.palette === 'string' ? PALETTES[x.palette] : x.palette || {}) };
  const cls = ['rufi', ...moves.split(' ').filter(Boolean).map((c) => 'm-' + c), ...(moves && x.sign ? ['m-sign'] : [])].join(' ');
  const inner = `<g class="all">${mark({ ...x, palette: P, small, inTile: ground !== 'none' })}</g>`;
  if (ground === 'none') return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="60 40 920 800" width="${Math.round(size * 920 / 800)}" height="${size}" role="img" aria-label="Rufi">${inner}</svg>`;
  const bg = ground === 'circle' ? `<circle class="ground" cx="500" cy="500" r="490" fill="${P.bg}"/>` : `<path class="ground" d="${squircle(500, 500, 490)}" fill="${P.bg}"/>`;
  const k = small ? 1.14 : 1.02;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 1000 1000" width="${size}" height="${size}" role="img" aria-label="Rufi">${bg}<g transform="translate(500 500) scale(${k}) translate(-500 -466)">${inner}</g></svg>`;
}

// ---- the eyes follow the pointer: live() for the expression the mark was drawn with. follow(svgElement) starts it and
//      returns a function that stops it. Still under reduced motion. ----
function follow(svgEl, { max = 18, expression = 'calm' } = {}) {
  if (!svgEl) return () => {};
  const r = live(svgEl, { expression, max });
  return () => r.stop();
}

// ---- live: one face that moves from expression to expression without a jump ----
// Use it on an <svg> made by svg() with the pill eyes: const r = live(el, { expression: 'calm' }); r.set('thinking'); r.stop().
// Every number of the eyes, the mouth and the gaze is a spring that moves toward its target, so a change of expression, a blink or a
// look at the pointer can start at any moment and still look smooth. The ears and the whole mark keep their CSS moves (motion.css);
// when they change, the old pose blends into the new move. With reduced motion the face changes at once and does nothing by itself,
// also when the setting changes while the face is shown: it settles, and moves again when the setting is turned off.
const EYE_MOVES = new Set(['blink', 'blink2', 'look', 'read', 'happy', 'wink', 'sleepy', 'wide']);   // live() does these itself
const SPEED = { eyes: 17, blink: 55, open: 26, mouth: 13, gaze: 17 };   // how fast each part follows (higher is faster)
function live(svgEl, { expression = 'calm', pointer = true, max = 18 } = {}) {
  const paths = [...svgEl.querySelectorAll('.eye-shape')], mouth = svgEl.querySelector('.mouth'), feat = svgEl.querySelector('.feat');
  const eyesG = svgEl.querySelector('.eyes'), signs = svgEl.querySelector('.signs');
  if (paths.length !== 2 || !mouth) return { set() {}, stop() {} };
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  let still = reduce?.matches ?? false;
  const KE = ['w', 't', 'b', 'd', 'k', 'lid', 'tilt'], KM = ['cw', 'yc', 'yb', 'f'];
  const ch = (v, w, z = 1) => ({ x: v, v: 0, to: v, w, z });   // one number; w: how fast, z: damping (1 = no overshoot)
  const E = formsOf('open').map((f) => Object.fromEntries(KE.map((k) => [k, ch(f[k], SPEED.eyes)])));
  const M = Object.fromEntries(KM.map((k) => [k, ch(MOUTH.smile[k], SPEED.mouth, 0.8)]));
  const Z = [ch(0, SPEED.gaze), ch(0, SPEED.gaze)], all = [...E.flatMap(Object.values), ...Object.values(M), ...Z];
  const [SHUT] = formsOf('shut'), [CLOSED] = formsOf('closed');
  const val = (o) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, c.x]));
  let x = {}, forms = formsOf('open'), shut = false, gazeTo = [0, 0], ptrAt = -1e9, timers = [], raf, last;
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const eyesTo = (f, w = SPEED.eyes, z = 1) => {
    forms = formsOf(f);
    E.forEach((e, i) => KE.forEach((k) => Object.assign(e[k], { to: (shut ? SHUT : forms[i])[k], w, z })));
  };
  const mouthTo = (m) => KM.forEach((k) => { M[k].to = mouthOf(m)[k]; });
  const look = (g) => { gazeTo = g; Z[0].to = g[0]; Z[1].to = g[1]; };
  const rest = () => x.look || [0, 0];

  // a blink closes fast and opens a little slower, into whatever form the eyes have by then
  function blink() {
    if (shut) return;
    shut = true; E.forEach((e) => KE.forEach((k) => Object.assign(e[k], { to: SHUT[k], w: SPEED.blink, z: 1 })));
    setTimeout(() => { shut = false; E.forEach((e, i) => KE.forEach((k) => Object.assign(e[k], { to: forms[i][k], w: SPEED.open }))); }, 95);
  }
  const blinkLoop = () => later(rnd(2400, 5600), () => {
    if (x.blink === 'slow') { E.forEach((e) => KE.forEach((k) => Object.assign(e[k], { to: CLOSED[k], w: 6 }))); later(rnd(900, 1500), () => { eyesTo(x.eyeForm, 5); later(900, () => eyesTo(x.eyeForm)); }); }
    else { blink(); if (Math.random() < 0.2) later(220, () => blink()); }
    blinkLoop();
  });
  // looking by itself: a small glance now and then when the pointer rests (follow), or the moves of thinking
  const glanceLoop = () => later(rnd(2600, 6000), () => {
    if (performance.now() - ptrAt > 2500 && Math.random() < 0.55) {
      const [bx, by] = rest(); look([bx + rnd(-14, 14), by + rnd(-9, 5)]);
      if (x.blink && Math.random() < 0.35) blink();
      later(rnd(700, 1500), () => { if (performance.now() - ptrAt > 2500) look(rest()); });
    }
    glanceLoop();
  });
  const THINK = [[13, -11], [-12, -10], [7, -13], [-4, -8]];
  const thinkLoop = (n = 0) => { look(THINK[n % THINK.length]); if (n && Math.random() < 0.3) blink(); later(rnd(1300, 2100), () => thinkLoop(n + 1 + (Math.random() < 0.3 ? 1 : 0))); };

  // the CSS moves of the ears and the whole mark; the pose they had blends into the new move instead of jumping
  const parts = ['.all', '.flapL', '.flapR'].map((q) => svgEl.querySelector(q)).filter(Boolean);
  function classes() {
    const moves = (x.motion || '').split(' ').filter((m) => m && !EYE_MOVES.has(m));
    const before = parts.map((el) => getComputedStyle(el).transform);
    svgEl.setAttribute('class', ['rufi', ...moves.map((m) => 'm-' + m), ...(x.sign ? ['m-sign'] : [])].join(' '));
    if (!still && parts[0].animate) parts.forEach((el, i) => { if (getComputedStyle(el).transform !== before[i]) el.animate([{ transform: before[i], offset: 0 }], { duration: 420, easing: 'ease-out' }); });
    if (!signs) return;
    for (const old of signs.children) { old.style.transition = 'opacity .2s'; old.style.opacity = 0; setTimeout(() => old.remove(), 220); }
    if (x.sign) signs.insertAdjacentHTML('beforeend', sign(x.sign, signs.dataset.c, !!signs.dataset.tile));
  }

  // the face's own moves (thinking, glances, blinks): none while still
  function loops() {
    if (x.gaze === 'think' && !still) thinkLoop(); else look(rest());
    if (x.gaze === 'follow' && !still) glanceLoop();
    if (x.blink && !still) blinkLoop();
  }

  function set(name) {
    x = EXPRESSIONS[name] || EXPRESSIONS.calm;
    timers.forEach(clearTimeout); timers = [];
    classes();
    const base = () => { eyesTo(x.eyeForm); mouthTo(x.mouth); };
    if (x.enter && !still) { eyesTo(x.enter.eyeForm || x.eyeForm, SPEED.open, x.enter.bounce ? 0.45 : 1); mouthTo(x.enter.mouth || x.mouth); later(x.enter.ms, () => eyesTo(x.eyeForm, SPEED.eyes, x.enter.bounce ? 0.6 : 1)); later(x.enter.ms, () => mouthTo(x.mouth)); }
    else base();
    loops();
  }

  // reduced motion turned on or off while the face is shown: everything pending stops, the face settles in the
  // expression's pose, and its own moves start again only when motion is allowed
  const onReduce = () => {
    still = reduce.matches;
    timers.forEach(clearTimeout); timers = []; clearTimeout(move.t); shut = false;
    eyesTo(x.eyeForm); mouthTo(x.mouth);
    loops();
  };
  reduce?.addEventListener('change', onReduce);

  // the pointer, as follow() does it
  const move = (ev) => {
    if (x.gaze !== 'follow' || still) return;
    const r = eyesG.getBoundingClientRect(), dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260) * max;
    look([dx / d * k, dy / d * k * 0.8]); ptrAt = performance.now();
    clearTimeout(move.t); move.t = setTimeout(() => look(rest()), 2500);
  };
  if (pointer) addEventListener('pointermove', move, { passive: true });

  const step = (c, dt) => { c.v += (c.w * c.w * (c.to - c.x) - 2 * c.z * c.w * c.v) * dt; c.x += c.v * dt; };
  function frame(now) {
    const dt = Math.min(0.05, ((now - (last ?? now)) || 16) / 1000); last = now;
    // reading: the eyes go slowly along a line, then quickly back and one line lower; typing: the same, short, where you type
    if ((x.gaze === 'read' || x.gaze === 'type') && !still) {
      const [len, back, x0, x1, y0] = x.gaze === 'read' ? [1500, 320, -15, 15, 8] : [1100, 260, -10, 3, 10];
      const n = Math.floor(now / (len + back)), p = (now % (len + back)) / len;
      Z[0].to = p < 1 ? x0 + (x1 - x0) * p : x0; Z[1].to = y0 + (n % 3) * 3;
    }
    for (const c of all) if (still) { c.x = c.to; c.v = 0; } else for (let s = 0; s < 3; s++) step(c, dt / 3);
    const lx = Z[0].x, ly = Z[1].x;
    paths.forEach((el, i) => el.setAttribute('d', pillAt(i, val(E[i]), lx, ly)));
    mouth.setAttribute('d', mouthPath(val(M)));
    if (feat) feat.setAttribute('transform', `translate(${(lx * FEAT).toFixed(1)} ${(ly * FEAT).toFixed(1)})`);
    raf = requestAnimationFrame(frame);
  }
  // start from the face as it is drawn, so there is no jump at the start
  set(expression);
  for (const c of all) { c.x = c.to; c.v = 0; }
  raf = requestAnimationFrame(frame);
  return {
    set,
    get expression() { return Object.keys(EXPRESSIONS).find((k) => EXPRESSIONS[k] === x); },
    stop() { cancelAnimationFrame(raf); timers.forEach(clearTimeout); clearTimeout(move.t); removeEventListener('pointermove', move); reduce?.removeEventListener('change', onReduce); },
  };
}

export { PALETTES, EXPRESSIONS, G, PILL, MOUTH, mark, svg, follow, live, roundPoly, squircle, mix };
