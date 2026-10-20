const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sass = require('sass');
const { chromium } = require('playwright');

// CSS fixture test, not an authenticated application or kept-test check.
const compile = file => sass.compile(file, { logger: sass.Logger.silent }).css;
const globalCss = compile('src/styles.scss');
const rgb = hex => hex.match(/\w\w/g).map(v => parseInt(v, 16));
const luminance = hex => rgb(hex).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const controls = `<div class="icons-container"><div class="icons"><div class="alarm alarm-active"></div><div class="archive"></div><div class="archive disabled"></div></div></div>
<div class="reminder-chip"><img>Active</div><div class="reminder-chip reminder-chip--past"><img>Past</div>
<div class="attachment-card"><span class="attachment-name">File</span><span class="attachment-type">file</span><span class="attachment-size">1 MB</span><button class="attachment-download">Download</button><button class="attachment-remove">Remove</button></div>
<div class="lp-card"><div class="lp-title">Title</div><div class="lp-domain">example.com</div><div class="lp-actions"><button class="lp-action-btn">Open</button></div></div>`;

test('note contrast CSS matrix: both themes, colors, editor, images and states', async () => {
  const { encapsulateStyle } = await import('@angular/compiler');
  const css = globalCss + ['notes', 'input', 'link-preview'].map(name => encapsulateStyle(compile(`src/app/components/${name}/${name}.component.scss`), 'fixture')).join('');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    for (const light of [false, true]) {
      for (const bg of ['fff8b8', 'e2f6d3', 'd3bfdb', '442c2e', '1e3a5f', '264d3c', '', 'image']) {
        const image = bg === 'image';
        const background = image ? 'fff8b8' : bg || (light ? 'ffffff' : '202124');
        const ink = image || (bg && rgb(bg).reduce((s, v, i) => s + v * [299, 587, 114][i], 0) / 1000 > 160) ? '202124' : bg ? 'e8eaed' : light ? '202124' : 'e8eaed';
        assert.ok(ratio(ink, background) >= 4.5, `${bg}: text contrast`);
        for (const editor of [false, true]) {
          const attrs = bg ? `data-note-ink="#${ink}" style="--note-ink:#${ink};background:#${background};color:#${ink}"` : `style="background:#${background};color:#${ink}"`;
          await page.setContent(`<style>${css} * { transition:none !important; animation:none !important; }</style><body class="${light ? 'light-theme' : ''}"><section class="${editor ? 'note-main' : 'note-container'}" ${attrs}>${controls}</section><aside><div class="icons-container"><div class="icons"><div class="archive"></div></div></div></aside></body>`);
          await page.locator('section, section *').evaluateAll(elements => elements.forEach(el => { el.setAttribute('_ngcontent-fixture', ''); el.setAttribute('_nghost-fixture', ''); }));
          if (image) {
            const svg = fs.readFileSync('src/assets/images/backgrounds/groceries.svg').toString('base64');
            await page.locator('section').evaluate((el, svg) => { el.style.backgroundImage = `url(data:image/svg+xml;base64,${svg})`; }, svg);
          }
          if (bg) {
            for (const selector of ['.attachment-name', '.attachment-size', '.attachment-type', '.attachment-download', '.attachment-remove', '.reminder-chip', '.reminder-chip--past', '.lp-title', '.lp-domain', '.lp-action-btn']) {
              assert.equal(await page.locator(selector).first().evaluate(el => getComputedStyle(el).color), `rgb(${rgb(ink).join(', ')})`, `${light}/${bg}/${editor}/${selector}`);
            }
            assert.equal(await page.locator('section .archive:not(.disabled)').evaluate(el => getComputedStyle(el, '::after').backgroundColor), `rgb(${rgb(ink).join(', ')})`);
            await page.locator('.reminder-chip--past').hover();
            assert.equal(await page.locator('.reminder-chip--past').evaluate(el => getComputedStyle(el).color), `rgb(${rgb(ink).join(', ')})`);
          }
          const clockFilter = await page.locator('.reminder-chip img').first().evaluate(el => getComputedStyle(el).filter);
          assert.equal(clockFilter.includes('invert(1)'), bg ? ink === 'e8eaed' : !light, 'clock matches actual surface');
          const opacity = await page.locator('section .disabled').evaluate(el => +getComputedStyle(el).opacity);
          assert.ok(opacity <= .28, 'disabled state stays muted');
          assert.equal(await page.locator('aside .archive').evaluate(el => getComputedStyle(el, '::after').backgroundColor), light ? 'rgb(95, 99, 104)' : 'rgb(189, 193, 198)', 'outside menus unchanged');
        }
      }
    }
  } finally { await browser.close(); }
});
