// The Rufi dog. Not under the Apache License: the Rufi name and everything in
// packages/brand/mark/ belong to mahesh0431. All rights reserved. See TRADEMARKS.md.

// Rufi, the folded-paper dog: the one source for the mark.
// Everything (palette, expression, size, ground) is an option; nothing is drawn twice.
// A plain ES module with no dependencies: the website, the app and the build script all import it.

// ---- palettes: three colours make a palette; every tone of light and fold comes from them ----
const PALETTES = {
  inkApricot:   { name: 'Ink & apricot', bg: '#1B2430', paper: '#F6F4EF', accent: '#EE9A5B', ink: '#1B2430', tongue: '#EE9A5B' },
  onApricot:    { name: 'On apricot',    bg: '#EE9A5B', paper: '#F8F5EF', accent: '#C9662E', ink: '#3A4556', tongue: '#D9733F' },
  onPeriwinkle: { name: 'On periwinkle', bg: '#C9D0FF', paper: '#FFFFFF', accent: '#EE9A5B', ink: '#3A4556', tongue: '#F2A07B' },
};

// ---- expressions: a mouth, the motion classes (see motion.css), and a few static face settings ----
const EXPRESSIONS = {
  calm:      { name: 'Calm',            mouth: 'open',   motion: 'blink twitch', use: 'The logo; idle' },
  hello:     { name: 'Hello',           mouth: 'open',   motion: 'blink2',       use: 'First run, a new chat' },
  listening: { name: 'Listening',       mouth: 'smile',  motion: 'lift blink',   use: 'You are speaking' },
  typing:    { name: 'You are typing',  mouth: 'smile',  motion: 'typing blink', use: 'You are typing' },
  thinking:  { name: 'Thinking',        mouth: 'line',   motion: 'look',         sign: 'dots',     use: 'The AI is working' },
  reading:   { name: 'Reading',         mouth: 'smile',  motion: 'read',         use: 'Reading a report you added' },
  found:     { name: 'Found something', mouth: 'o',      motion: 'wide lift',    sign: 'sparkle',  use: 'Curious, not alarmed' },
  question:  { name: 'Question',        mouth: 'smile',  motion: 'curious tilt blink', sign: 'question', use: 'Rufi needs you to decide' },
  done:      { name: 'Done',            mouth: 'laugh',  motion: 'happy hop',    sign: 'check',    use: 'A job is finished' },
  playful:   { name: 'Playful',         mouth: 'tongue', motion: 'happy',        use: 'A light moment; rarely' },
  tip:       { name: 'Tip',             mouth: 'smile',  motion: 'wink',         sign: 'spark',    use: 'A hint' },
  steady:    { name: 'Steady',          mouth: 'line',   motion: 'blink',        look: [0, 14],   use: 'A serious topic' },
  sorry:     { name: 'Sorry',           mouth: 'line',   motion: 'earsdown blink', look: [-10, 16], use: 'Rufi could not do it' },
  sleepy:    { name: 'Sleepy',          mouth: 'smile',  motion: 'sleepy',       eyeShape: 'lid',  use: 'About to pause' },
  resting:   { name: 'Resting',         mouth: 'smile',  motion: 'earsdown breathe', eyeShape: 'closed', sign: 'z', use: 'Paused or offline' },
  alert:     { name: 'Alert',           mouth: 'open',   motion: 'blink oneear', use: 'Something new came in' },
};

// ---- helpers ----
let uid = 0;
const hex = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
const mirror = (pts) => pts.map(([x, y]) => [1000 - x, y]);
const poly = (pts) => 'M' + pts.map((p) => p.join(' ')).join('L') + 'Z';

// a polygon with every corner rounded by r
function roundPoly(P, r) {
  const n = P.length; let d = '';
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n];
    const v1 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    const ang = Math.acos((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2));
    const t = Math.min(r / Math.tan(ang / 2), l1 / 2, l2 / 2), rr = t * Math.tan(ang / 2);
    const a = [p1[0] + v1[0] / l1 * t, p1[1] + v1[1] / l1 * t], b = [p1[0] + v2[0] / l2 * t, p1[1] + v2[1] / l2 * t];
    const sweep = (v1[0] * v2[1] - v1[1] * v2[0]) < 0 ? 1 : 0;
    d += (i ? 'L' : 'M') + a[0].toFixed(1) + ' ' + a[1].toFixed(1) + `A${rr.toFixed(1)} ${rr.toFixed(1)} 0 0 ${sweep} ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
  }
  return d + 'Z';
}

// the app-icon shape (a superellipse)
function squircle(cx, cy, r, n = 5) {
  let d = '';
  for (let i = 0; i <= 360; i += 2) {
    const t = i * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    d += (i ? 'L' : 'M') + (cx + r * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(1) + ' ' + (cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(1);
  }
  return d + 'Z';
}

// ---- geometry, on a 1000 grid (centre x = 500). The left side is drawn; the right is its mirror. ----
const G = {
  flap: [[355, 155], [130, 290], [187, 462]],                 // the ear flap; its crease runs from the first to the last point
  fold: [[355, 155], [187, 462], [280, 365], [362, 285]],     // the turned-over paper between the crease and the head
  back: [[355, 155], [422, 220], [362, 285]],                 // the small facet behind the ear
  body: [[355, 155], [422, 220], [578, 220], [645, 155], [813, 462], [720, 365], [750, 600], [615, 735], [500, 778], [385, 735], [250, 600], [280, 365], [187, 462]],
  headL: [[422, 220], [500, 220], [500, 778], [385, 735], [250, 600], [280, 365]],
  headR: [[500, 220], [578, 220], [720, 365], [750, 600], [615, 735], [500, 778]],
  muzzleL: [[250, 600], [440, 578], [500, 668], [385, 735]],
  muzzleR: [[750, 600], [560, 578], [500, 668], [615, 735]],
  chinL: [[385, 735], [500, 668], [500, 778]],
  chinR: [[615, 735], [500, 668], [500, 778]],
  eyes: [382, 615], eyeY: 410, eyeW: 60, eyeH: 108,
  nose: [[437, 545], [563, 545], [572, 560], [510, 616], [490, 616], [428, 560]],
  stroke: 18, mouthY: 646,
};

// ---- the face ----
function face(o, P) {
  const e = P.ink, st = `fill="none" stroke="${e}" stroke-width="${G.stroke}" stroke-linecap="round" stroke-linejoin="round"`;
  const [lx, ly] = o.look || [0, 0], es = o.eyes ?? 1;
  let s = '';
  const bot = G.eyeY + G.eyeH; // eyes close downwards, so lids and closed eyes sit low
  s += `<g class="eyes">`;
  for (const x0 of G.eyes) {
    const x = x0 + lx;
    if (o.eyeShape === 'closed') { s += `<rect class="eye closed" x="${x - 46}" y="${bot - 40 + ly}" width="92" height="26" rx="13" fill="${e}"/>`; continue; }
    if (o.eyeShape === 'lid') { const w = 78, t = G.eyeY + G.eyeH * 0.4 + ly, b = bot + ly, r = w / 2;
      s += `<path class="eye lid" d="M${x - r + 8} ${t}H${x + r - 8}Q${x + r} ${t} ${x + r} ${t + 8}V${b - r}A${r} ${r} 0 0 1 ${x - r} ${b - r}V${t + 8}Q${x - r} ${t} ${x - r + 8} ${t}Z" fill="${e}"/>`; continue; }
    const sq = es !== 1 ? ` style="transform:scaleY(${es});transform-box:fill-box;transform-origin:center"` : '';
    s += `<rect class="eye" x="${x - G.eyeW / 2}" y="${G.eyeY + ly}" width="${G.eyeW}" height="${G.eyeH}" rx="${G.eyeW / 2}" fill="${e}"${sq}/>`;
  }
  s += `</g><path d="${roundPoly(G.nose, 6)}" fill="${e}"/>`;
  // mouths take their size from the nose (144 wide): open 1.3x, laugh 1.6x, line 1x
  const tr = (tw, bw, d, my, r) => roundPoly([[500 - tw / 2, my], [500 + tw / 2, my], [500 + bw / 2, my + d], [500 - bw / 2, my + d]], r);
  const my = G.mouthY, m = o.mouth || 'open', phil = (y) => `<path d="M500 610V${y}" ${st}/>`;
  if (m === 'line') s += `<path d="M500 610V652M430 656H570" ${st}/>`;
  if (m === 'smile') s += phil(650) + `<path d="${tr(180, 92, 36, my, 15)}" fill="${e}"/>`;
  if (m === 'o') s += phil(666) + `<path d="${tr(86, 64, 52, 664, 20)}" fill="${e}"/>`;
  if (m === 'open' || m === 'laugh' || m === 'tongue') {
    const L = m === 'laugh', tw = L ? 232 : 188, d = L ? 88 : 64, sh = tr(tw, tw * 0.52, d, my, 18), id = 'rm' + (uid++);
    if (!o.small) s += phil(my);
    s += `<path d="${sh}" fill="${e}"/>`;
    if (!o.small) s += `<clipPath id="${id}"><path d="${sh}"/></clipPath><ellipse cx="500" cy="${my + d + 2}" rx="${tw * 0.3}" ry="${d * 0.52}" fill="${P.tongue}" clip-path="url(#${id})"/>`;
    if (m === 'tongue') s += `<path d="M462 ${my + d - 14}H538V${my + d + 22}A38 38 0 0 1 462 ${my + d + 22}Z" fill="${P.tongue}"/><path d="M500 ${my + d - 6}V${my + d + 26}" stroke="${mix(P.tongue, '#000000', 0.15)}" stroke-width="6" stroke-linecap="round"/>`;
  }
  return s;
}

// ---- signs: small marks by the right ear, in the fold colour, only where they add meaning (hidden at 32 px and below) ----
function sign(k, c, inTile) {
  const wrap = (g) => `<g transform="${inTile ? 'translate(840 222) scale(1.1)' : 'translate(880 182) scale(1.4)'} translate(-890 -168)">${g}</g>`;
  const st = `fill="none" stroke="${c}" stroke-linecap="round" stroke-linejoin="round"`;
  if (k === 'z') return wrap(`<g class="sign sign-z" ${st} stroke-width="14"><path class="z1" d="M836 250h36l-36 40h36"/><path class="z2" d="M884 168h26l-26 29h26" stroke-width="11"/></g>`);
  if (k === 'question') return wrap(`<g class="sign sign-q"><path d="M864 116c0-22 17-37 38-37s38 15 38 35c0 26-36 29-36 54" ${st} stroke-width="16"/><circle cx="904" cy="210" r="11" fill="${c}"/></g>`);
  if (k === 'dots') return wrap(`<g class="sign sign-dots" fill="${c}"><circle class="d1" cx="836" cy="186" r="15"/><circle class="d2" cx="884" cy="186" r="15"/><circle class="d3" cx="932" cy="186" r="15"/></g>`);
  const star = (x, y, r) => `M${x} ${y - r}L${x + r * 0.28} ${y - r * 0.28}L${x + r} ${y}L${x + r * 0.28} ${y + r * 0.28}L${x} ${y + r}L${x - r * 0.28} ${y + r * 0.28}L${x - r} ${y}L${x - r * 0.28} ${y - r * 0.28}Z`;
  if (k === 'sparkle') return wrap(`<g class="sign sign-sparkle" fill="${c}"><path class="s1" d="${star(880, 150, 44)}"/><path class="s2" d="${star(940, 238, 22)}"/></g>`);
  if (k === 'spark') return wrap(`<g class="sign sign-sparkle" fill="${c}"><path class="s1" d="${star(890, 160, 36)}"/></g>`);
  if (k === 'check') return wrap(`<g class="sign sign-check"><path d="M842 168L878 204L944 124" ${st} stroke-width="20" pathLength="100"/></g>`);
  return '';
}

// ---- the mark: one folded sheet. Sharp shared corners inside, only the outline rounded; light from the top left. ----
// o: { palette, mouth, look, eyes (a squeeze, 0..1), eyeShape ('closed' | 'lid'), sign, small, flat }
function mark(o = {}) {
  const P = { ...PALETTES.inkApricot, ...(typeof o.palette === 'string' ? PALETTES[o.palette] : o.palette || {}) };
  const id = 'r' + (uid++), flat = o.flat || o.small, W = '#FFFFFF', K = '#000000';
  const L = (t) => mix(P.paper, W, t), D = (t) => mix(P.paper, K, t), AD = (t) => mix(P.accent, K, t);
  const F = (pts, fill, cls) => `<path${cls ? ` class="${cls}"` : ''}${cls === 'back' ? ' opacity="0"' : ''} d="${poly(pts)}" fill="${fill}" stroke="${fill}" stroke-width="1.2" stroke-linejoin="round"/>`;
  const grad = (n, x1, y1, x2, y2, a, b) => `<linearGradient id="${id}${n}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
  const f = (n, solid) => (flat ? solid : `url(#${id}${n})`);

  let s = `<defs><clipPath id="${id}c"><path d="${roundPoly(G.body, 6)}"/></clipPath>`
    + `<clipPath id="${id}l"><path d="${roundPoly(G.flap, 6)}"/></clipPath><clipPath id="${id}r"><path d="${roundPoly(mirror(G.flap), 6)}"/></clipPath>`;
  if (!flat) {
    s += grad('fl', 130, 290, 271, 308, L(0.4), D(0.045)) + grad('fr', 870, 290, 729, 308, D(0.02), D(0.1))
      + grad('kl', 271, 308, 331, 341, AD(0.13), P.accent) + grad('kr', 729, 308, 669, 341, AD(0.24), AD(0.06))
      + grad('bl', 355, 155, 392, 250, D(0.03), D(0.08)) + grad('br', 645, 155, 608, 250, D(0.07), D(0.14))
      + grad('hl', 300, 220, 420, 778, L(0.3), D(0.02)) + grad('hr', 700, 220, 580, 778, D(0.035), D(0.075))
      + grad('ml', 250, 600, 440, 740, D(0.003), D(0.045)) + grad('mr', 750, 600, 560, 740, D(0.05), D(0.1));
  }
  s += `</defs>`;
  // the inside of each ear, seen only when a flap lifts (hidden here so a still drawing needs no CSS; motion.css shows it)
  s += `<g class="under" opacity="0">${F(G.flap, AD(0.24))}${F(mirror(G.flap), AD(0.3))}</g>`;
  s += `<g clip-path="url(#${id}c)">`
    + F(G.fold, f('kl', P.accent)) + F(mirror(G.fold), f('kr', P.accent))
    + F(G.headL, f('hl', P.paper)) + F(G.headR, f('hr', P.paper));
  if (!flat) s += F(G.muzzleL, `url(#${id}ml)`) + F(G.muzzleR, `url(#${id}mr)`) + F(G.chinL, D(0.035)) + F(G.chinR, D(0.075));
  s += F(G.back, f('bl', P.paper)) + F(mirror(G.back), f('br', P.paper));
  if (!flat) s += `<path d="M355 155L362 285M645 155L638 285" stroke="${L(0.7)}" stroke-opacity=".55" stroke-width="2" fill="none"/>`;
  s += `</g>`;
  // the ear flaps turn on their crease; front is the paper, back is the accent
  s += `<g class="flapL"><g clip-path="url(#${id}l)">${F(G.flap, f('fl', P.paper), 'front')}${F(G.flap, f('kl', P.accent), 'back')}</g></g>`;
  s += `<g class="flapR"><g clip-path="url(#${id}r)">${F(mirror(G.flap), f('fr', P.paper), 'front')}${F(mirror(G.flap), f('kr', P.accent), 'back')}</g></g>`;
  s += `<g class="face">${face(o, P)}</g>`;
  if (o.sign && !o.small) s += sign(o.sign, P.accent, o.inTile);
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
  const bg = ground === 'circle' ? `<circle cx="500" cy="500" r="490" fill="${P.bg}"/>` : `<path d="${squircle(500, 500, 490)}" fill="${P.bg}"/>`;
  const k = small ? 1.14 : 1.02; // the small drawing fills more of its ground
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" viewBox="0 0 1000 1000" width="${size}" height="${size}" role="img" aria-label="Rufi">${bg}<g transform="translate(500 500) scale(${k}) translate(-500 -466)">${inner}</g></svg>`;
}

// ---- the eyes follow the pointer. follow(svgElement) starts it and returns a function that stops it.
//      The eyes move at most `max` units (of the 1000 grid) towards the pointer and drift back when it rests.
//      Nothing moves when the system asks for reduced motion. ----
function follow(svgEl, { max = 18, rest = 2500 } = {}) {
  const eyes = svgEl && svgEl.querySelector('.eyes');
  if (!eyes || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) return () => {};
  eyes.style.transition = 'transform .18s ease-out';
  let timer;
  const move = (ev) => {
    const r = eyes.getBoundingClientRect(), dx = ev.clientX - (r.left + r.width / 2), dy = ev.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260) * max; // near the face the eyes move less
    eyes.style.transform = `translate(${(dx / d * k).toFixed(1)}px, ${(dy / d * k * 0.8).toFixed(1)}px)`;
    clearTimeout(timer); timer = setTimeout(() => { eyes.style.transform = ''; }, rest);
  };
  addEventListener('pointermove', move, { passive: true });
  return () => { removeEventListener('pointermove', move); clearTimeout(timer); eyes.style.transform = ''; };
}

export { PALETTES, EXPRESSIONS, G, mark, svg, follow, roundPoly, squircle, mix };
