// The Rufi dog. Not under the Apache License: the Rufi name and everything in
// packages/brand/mark/ belong to mahesh0431. All rights reserved. See TRADEMARKS.md.

// Makes assets/ from the one source: the files people use without running code.
// Run after changing rufi.js or motion.css: pnpm --filter @rufi/brand regenerate
// (assets/ is kept in git; never edit it by hand). The PNGs need Chromium through
// Playwright; without it this stops before it touches assets/. Everything is made
// in a new folder first and takes the place of assets/ only when all of it is made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Rufi from './rufi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'assets');
const NEW = path.join(here, `assets.new-${process.pid}`);
const NOTE = '<!-- The Rufi dog. Not under the Apache License: all rights reserved by mahesh0431. See TRADEMARKS.md. -->';

function fail(message, cause) {
  console.error(`No assets made: ${message}`);
  if (cause) console.error(cause);
  fs.rmSync(NEW, { recursive: true, force: true });
  process.exit(1);
}

// The renderer first: nothing is written or removed before it runs.
let browser;
try {
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch();
} catch (cause) {
  fail('Playwright\'s Chromium could not start. Run `pnpm install`, then `pnpm exec playwright install chromium`, and try again.', cause);
}

const css = fs.readFileSync(path.join(here, 'motion.css'), 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(NEW, f)), { recursive: true }); fs.writeFileSync(path.join(NEW, f), NOTE + '\n' + s + '\n'); };
// a moving SVG carries its own motion rules, so it works on its own (in a browser, or an <img>)
const moving = (s) => s.replace(/(<svg[^>]*>)/, `$1<style>${css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')}</style>`);
const still = (o) => Rufi.svg({ motion: false, ...o });

try {
  // every palette: the mark, the small mark (32 px and below), the app tile and the round badge
  for (const key of Object.keys(Rufi.PALETTES)) {
    write(`svg/${key}/mark.svg`, still({ palette: key, size: 512 }));
    write(`svg/${key}/mark-small.svg`, still({ palette: key, size: 32 }));
    write(`svg/${key}/app-icon.svg`, still({ palette: key, size: 1024, ground: 'tile' }));
    write(`svg/${key}/badge.svg`, still({ palette: key, size: 512, ground: 'circle' }));
  }
  // the moving expressions: on ink (the app), and on apricot (light pages)
  for (const key of ['inkApricot', 'onApricot'])
    for (const ex of Object.keys(Rufi.EXPRESSIONS)) write(`svg/${key}/moving/${ex}.svg`, moving(Rufi.svg({ palette: key, expression: ex, size: 512 })));
  write('favicon/favicon.svg', still({ size: 32, ground: 'tile' }));

  const page = await browser.newPage();
  // pad: the empty margin around the drawing, in pixels on each side
  async function png(svg, n, file, pad = 0) {
    await page.setViewportSize({ width: n, height: n });
    await page.setContent(`<html><body style="margin:0;padding:${pad}px;background:transparent">${svg}</body></html>`);
    fs.mkdirSync(path.dirname(path.join(NEW, file)), { recursive: true });
    await page.screenshot({ path: path.join(NEW, file), omitBackground: true, clip: { x: 0, y: 0, width: n, height: n } });
  }
  for (const n of [1024, 512, 256, 128, 64, 32, 16]) await png(still({ size: n, ground: 'tile' }), n, `png/app-icon-${n}.png`);
  // the Mac's app icon: the tile on the Mac's icon grid (824 of 1024), so it sits in the Dock at the size of the others;
  // 512 px, the largest the Mac's own converter (sips) makes an .icns from
  await png(still({ size: 412, ground: 'tile' }), 512, 'png/mac-icon-512.png', 50);
  for (const n of [512, 256, 128]) await png(still({ palette: 'onApricot', size: n, ground: 'tile' }), n, `png/on-apricot-tile-${n}.png`);
  for (const n of [16, 32, 48]) await png(still({ size: n, ground: 'tile' }), n, `favicon/favicon-${n}.png`);
  await png(still({ size: 180, ground: 'tile' }), 180, 'favicon/apple-touch-icon.png');
} catch (cause) {
  await browser.close();
  fail('making them failed; assets/ is as it was.', cause);
}
await browser.close();

fs.rmSync(OUT, { recursive: true, force: true });
fs.renameSync(NEW, OUT);
console.log('assets/ written: svg/, png/, favicon/');
