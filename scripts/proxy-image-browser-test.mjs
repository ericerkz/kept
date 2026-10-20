import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fixtureModule from '../test-support/image-proxy-fixture.js';

const fixture = await fixtureModule.startImageProxyFixture();
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixture.baseUrl);
  await page.evaluate(() => localStorage.setItem('gk_session', 'victim-test-session'));
  // Check actual pixel output, not only the presence of headers or an SVG element.
  const colors = await page.evaluate(async url => {
    const image = new Image(); image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 20;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return Array.from(canvas.getContext('2d').getImageData(10, 10, 1, 1).data);
  }, fixture.proxyUrl());
  assert.deepEqual(colors, [255, 0, 0, 255], 'SVG style must still render');
  for (const url of [fixture.proxyUrl(), fixture.proxyUrl('/redirect')]) {
    const response = await page.goto(url);
    assert.equal(response.status(), 200);
    assert.equal(await page.evaluate(() => !!window.proxyScriptRan || !!window.proxyOnloadRan), false);
    assert.equal(await page.evaluate(() => window.proxyStorage), undefined);
    assert.equal(await page.evaluate(() => { try { localStorage.getItem('gk_session'); return true; } catch { return false; } }), false,
      'top-level SVG must have an opaque sandbox origin');
    assert.equal(await page.locator('rect').evaluate(element => getComputedStyle(element).fill), 'rgb(255, 0, 0)');
  }
  assert.equal(fixture.probes, 0, 'SVG must not make authenticated-origin requests');
  await page.goto(fixture.baseUrl);
  assert.equal(await page.evaluate(() => localStorage.getItem('gk_session')), 'victim-test-session');
  assert.equal(await page.evaluate(async url => { const image = new Image(); image.src = url; await image.decode(); return image.naturalWidth; }, fixture.proxyUrl('/pixel.png')), 1);
  await page.close(); await context.close();
  console.log('Image proxy browser regression passed: styled SVG/raster rendering preserved; SVG scripts, event handlers, storage access and requests blocked, including after redirects.');
} finally {
  await browser?.close(); await fixture.close();
}
