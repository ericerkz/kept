import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { buildSync } from 'esbuild';
import { startFixture } from '../test-support/session-fixture.cjs';

const fixture = await startFixture();
const password = 'test-password-123';
let token;
const api = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(fixture.origin + '/api' + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, await response.clone().text()); return response.status === 204 ? undefined : response.json();
};
const wait = async (fn, label) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
};
const helper = buildSync({ entryPoints: ['src/app/utils/code-blocks.ts'], bundle: true, format: 'iife', globalName: 'codeHelpers', write: false }).outputFiles[0].text;
let browser;
try {
  await api('/setup/admin', { username: 'owner', password });
  token = (await api('/auth/login', { username: 'owner', password })).token;
  for (const [engine, mobile] of [[process.env.KEPT_TEST_BROWSER === 'webkit' ? webkit : chromium, false], [process.env.KEPT_TEST_BROWSER === 'webkit' ? webkit : chromium, true]]) {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    if (engine.name() === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript({ content: helper + ";globalThis.codeHelpers = codeHelpers;" });
    await context.addInitScript(() => {
      window.__codeWorkerMessages = [];
      if (typeof Worker !== 'undefined') {
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(message, ...args) {
          window.__codeWorkerMessages.push(message.text);
          if (window.__delayCodeWorker) setTimeout(() => post.call(this, message, ...args), 300);
          else post.call(this, message, ...args);
        };
      }
      window.__writeRealClipboard = navigator.clipboard?.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedCode = text; } } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(fixture.origin + '/login');
    await page.getByLabel('Username', { exact: true }).fill('owner');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(fixture.origin + '/');
    await page.locator('app-notes').waitFor();

    // Exercise the same serializer used by saving, not a hand-written approximation.
    const exact = '  if (x < 2) {\n\tconst text = "<script>window.__codeXss=1</script>";\n\n}\n';
    const result = await page.evaluate(text => {
      const root = document.createElement('div'); root.innerHTML = window.codeHelpers.codeBlockHtml(text, 'javascript', 'user');
      const pre = root.firstElementChild;
      const header = document.createElement('div'); header.textContent = 'Copy JavaScript'; pre.prepend(header);
      window.codeHelpers.cleanCodeBlocks(root);
      const roundtrip = root.querySelector('code').textContent;
      const markdown = window.codeHelpers.codeBlocksToMarkdown(root);
      return { roundtrip, markdown };
    }, exact);
    assert.equal(result.roundtrip, exact); assert.ok(result.markdown.includes(exact)); assert.ok(!result.markdown.includes('&lt;script'));

    // Explicit formatting-menu insertion, selected text, paste, keyboard and save/reopen.
    if (mobile) await page.getByRole('button', { name: 'New note', exact: true }).click();
    else await page.getByPlaceholder('Take a note…').first().click();
    const editor = page.locator('app-input .note-main:visible').last();
    const title = `Code ${mobile ? 'mobile' : 'desktop'} fixture`;
    await editor.locator('.note-title[contenteditable]').fill(title);
    const body = editor.locator('.note-body[contenteditable="true"]').first();
    const rawPaste = "$wh = 'Hello, World!' | Write-Host\n$wo = 'Hello, World!' | Write-Output\n\nGet-Variable wh\n\nGet-Variable wo\n";
    const paste = async (value, reset = true) => body.evaluate((element, { value, reset }) => {
      if (reset) element.replaceChildren(); element.focus();
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const data = new DataTransfer(); data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      return { text: window.codeHelpers.codeText(element), blocks: element.querySelectorAll('pre.kept-code').length };
    }, { value, reset });
    const normalPaste = await paste('Shopping list\nMilk\nBread');
    assert.equal(normalPaste.text, 'Shopping list\nMilk\nBread');
    assert.equal(await page.evaluate(() => window.__codeWorkerMessages.includes('Shopping list\nMilk\nBread')), false, 'ordinary paste never starts syntax detection');
    await paste('x'.repeat(30001));
    assert.equal(await page.evaluate(() => window.__codeWorkerMessages.some(text => text.length > 30000)), false, 'oversized pastes never start syntax detection');
    await page.evaluate(() => window.__delayCodeWorker = true);
    const immediate = await paste(rawPaste);
    assert.equal(immediate.text, rawPaste, 'code paste is inserted before the worker answers');
    assert.equal(immediate.blocks, 0);
    await page.keyboard.type('User kept typing');
    await page.waitForTimeout(450);
    assert.equal(await editor.locator('pre.kept-code').count(), 0, 'late detection must not overwrite subsequent typing');
    assert.ok((await body.textContent()).includes('User kept typing'));
    await page.evaluate(() => window.__delayCodeWorker = false);
    await paste(rawPaste);
    await editor.locator('pre.kept-code textarea').waitFor({ state: 'visible' });
    assert.equal(await editor.locator('pre.kept-code textarea').inputValue(), rawPaste);
    await page.keyboard.press('Control+z');
    assert.equal(await editor.locator('pre.kept-code').count(), 0, 'automatic conversion can be undone to ordinary text');
    assert.equal(await body.evaluate(element => window.codeHelpers.codeText(element)), rawPaste);
    const csharpPaste = `// Outer loop
for (int i = 1; i <= 2; ++i)
{
  Console.WriteLine("Outer: " + i);  // Executes 2 times

  // Inner loop
  for (int j = 1; j <= 3; j++)
  {
    Console.WriteLine(" Inner: " + j); // Executes 6 times (2 * 3)
  }
}`;
    await body.evaluate(element => { element.replaceChildren(); element.focus(); });
    await page.evaluate(() => window.__delayCodeWorker = true);
    if (engine.name() === 'chromium') {
      await page.evaluate(text => window.__writeRealClipboard(text), csharpPaste);
      await body.press('ControlOrMeta+v');
    } else await paste(csharpPaste);
    const leadingBlock = editor.locator('pre.kept-code').first();
    await leadingBlock.locator('textarea').waitFor({ state: 'visible' });
    assert.equal(await leadingBlock.locator('textarea').inputValue(), csharpPaste);
    await page.evaluate(() => window.__delayCodeWorker = false);
    await wait(async () => (await leadingBlock.locator('.kept-code-language').textContent()).includes('C#'), 'C# Console syntax not detected');
    const leadingLine = body.locator(':scope > .kept-code-leading-line');
    await leadingLine.waitFor({ state: 'visible' });
    const beforeRect = await leadingLine.boundingBox(); const codeRect = await leadingBlock.boundingBox();
    assert.ok(beforeRect.height >= 24 && beforeRect.y + beforeRect.height <= codeRect.y, 'text hit area sits above the code');
    const emptyClean = await body.evaluate(element => { const div = element.cloneNode(true); window.codeHelpers.cleanCodeBlocks(div); return div.innerHTML; });
    assert.ok(emptyClean.startsWith('<pre'), 'empty text hit area is never saved');
    if (mobile) await leadingLine.tap(); else await leadingLine.click();
    await page.keyboard.type('An introduction above the code');
    const withIntro = await body.evaluate(element => { const div = element.cloneNode(true); window.codeHelpers.cleanCodeBlocks(div); return div.innerHTML; });
    assert.ok(withIntro.indexOf('An introduction above the code') < withIntro.indexOf('<pre'));
    assert.equal(await leadingBlock.locator('code').textContent(), csharpPaste, 'typing above leaves code untouched');
    await paste('```powershell\n' + rawPaste + '```');
    await editor.locator('pre.kept-code textarea').waitFor({ state: 'visible' });
    assert.equal(await editor.locator('pre.kept-code textarea').inputValue(), rawPaste.slice(0, -1), 'explicit fences are removed');
    await editor.getByRole('button', { name: 'Convert to text', exact: true }).click();
    await body.fill('Existing note text ');
    await paste(rawPaste, false);
    await page.waitForTimeout(100);
    assert.equal(await editor.locator('pre.kept-code').count(), 0, 'existing note text is never reinterpreted');
    if (mobile) {
      await body.fill('Keep this selection');
      await body.evaluate(element => {
        element.focus(); const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        window.__formatBlurs = 0; element.addEventListener('blur', () => window.__formatBlurs++);
      });
      const format = editor.locator('.mobile-icon.format');
      await format.tap();
      const toolbar = editor.locator('.mobile-format-toolbar');
      await toolbar.waitFor({ state: 'visible' });
      assert.equal(await body.evaluate(element => document.activeElement === element), true, 'opening formatting must retain editable focus');
      assert.equal(await page.evaluate(() => window.getSelection().toString()), 'Keep this selection');
      await toolbar.getByRole('button', { name: 'B', exact: true }).tap();
      assert.equal(await body.evaluate(element => document.activeElement === element), true, 'applying formatting must retain editable focus');
      assert.equal(await body.locator('b, strong').textContent(), 'Keep this selection');
      await toolbar.getByRole('button', { name: 'Highlight text', exact: true }).tap();
      assert.equal(await body.locator('mark.hl').textContent(), 'Keep this selection');
      await format.tap();
      assert.equal(await toolbar.count(), 0);
      assert.equal(await page.evaluate(() => window.__formatBlurs), 0, 'formatting must never blur then refocus the editor');
      await page.keyboard.type('Replacement');
      assert.equal(await body.textContent(), 'Replacement', 'typing resumes at the preserved selection');
      // Buttons still support keyboard activation for external keyboards and accessibility.
      await format.focus(); await format.press('Enter');
      await toolbar.waitFor({ state: 'visible' });
      await format.press('Enter');
      assert.equal(await toolbar.count(), 0);
    }
    if (!mobile) {
      await page.setViewportSize({ width: 650, height: 900 });
      await body.evaluate(element => { element.replaceChildren(document.createTextNode('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau')); element.focus(); });
      const points = await body.evaluate(element => {
        const text = element.firstChild;
        const point = offset => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); const rect = range.getBoundingClientRect(); return { x: rect.left + 1, y: rect.top + rect.height / 2 }; };
        return { start: point(4), end: point(85) };
      });
      await page.mouse.move(points.end.x, points.end.y); await page.mouse.down();
      await page.mouse.move(points.start.x, points.start.y, { steps: 12 });
      await page.waitForTimeout(100);
      assert.equal(await editor.locator('.selection-format-toolbar:visible').count(), 0, 'toolbar stays out of the pointer during backward selection');
      await page.mouse.up();
      const selectionBar = editor.locator('.selection-format-toolbar');
      await selectionBar.waitFor({ state: 'visible' });
      const layout = await selectionBar.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect().top);
        const selected = window.getSelection().getRangeAt(0).getBoundingClientRect();
        return { left: rect.left, right: rect.right, singleRow: Math.max(...buttons) - Math.min(...buttons) < 2,
          outsideSelection: rect.bottom <= selected.top || rect.top >= selected.bottom };
      });
      assert.ok(layout.singleRow, 'selection toolbar must not wrap');
      assert.ok(layout.left >= 0 && layout.right <= 650, 'selection toolbar stays within narrow viewport');
      assert.ok(layout.outsideSelection, 'selection toolbar does not cover the selected text');
      const selected = await page.evaluate(() => window.getSelection().toString());
      assert.ok(selected.length > 20);
      await selectionBar.getByRole('button', { name: 'Highlight text', exact: true }).click();
      const highlighted = await body.evaluate(element => {
        const selection = window.getSelection(); const range = selection.getRangeAt(0);
        return { text: selection.toString(), backward: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset,
          marked: [...element.querySelectorAll('mark.hl')].map(mark => mark.textContent).join('') };
      });
      assert.equal(highlighted.text, selected); assert.equal(highlighted.marked, selected);
      assert.ok(highlighted.backward, 'highlighting preserves the backward selection');
      await selectionBar.getByRole('button', { name: 'Highlight text', exact: true }).click();
      assert.equal(await body.locator('mark.hl').count(), 0, 'highlight toggles off without losing text');
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    // Converting a rich-text selection must preserve BR/DIV line breaks and blank lines.
    const powershell = "$wh = 'Hello, World!' | Write-Host\n$wo = 'Hello, World!' | Write-Output\n\nGet-Variable wh\n\nGet-Variable wo\n";
    await body.evaluate((element, text) => {
      element.replaceChildren();
      for (const value of ['Before prose', ...text.split('\n'), 'After prose']) {
        const line = document.createElement('div'); if (value) line.textContent = value; else line.append(document.createElement('br')); element.append(line);
      }
      element.focus(); const range = document.createRange(); range.setStart(element, 1); range.setEnd(element, element.childNodes.length - 1);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }, powershell);
    await editor.locator(mobile ? '.mobile-icon.format' : '.text-format-trigger').click();
    await editor.getByRole('button', { name: 'Code block', exact: true }).last().click();
    const converted = editor.locator('pre.kept-code').first();
    const convertedInput = converted.locator('textarea');
    await convertedInput.waitFor({ state: 'visible' });
    assert.equal(await convertedInput.inputValue(), powershell, 'selected HTML line breaks must survive conversion');
    await wait(async () => (await converted.locator('.kept-code-language').textContent()).includes('PowerShell'), 'PowerShell was not detected while editing');
    assert.ok(await converted.locator('code .hljs-string').count(), 'syntax colours appear while the input remains focused');
    assert.equal(await convertedInput.evaluate(element => element === document.activeElement), true);
    await convertedInput.evaluate((input, text) => {
      input.select(); const data = new DataTransfer(); data.setData('text/plain', text); input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, 'def greet(name):\n    print("Hello", name)\n\ngreet("World")');
    await wait(async () => (await converted.locator('.kept-code-language').textContent()).includes('Python'), 'pasted code was not re-detected');
    await convertedInput.fill(powershell);
    await converted.getByRole('button', { name: 'Convert to text', exact: true }).click();
    assert.equal(await editor.locator('pre.kept-code').count(), 0);
    const restoredText = await body.evaluate(element => window.codeHelpers.codeText(element));
    assert.ok(restoredText.includes(powershell), 'convert to text preserves blank lines');
    assert.ok(restoredText.includes('Before prose') && restoredText.includes('After prose'));
    await page.keyboard.press('Control+z');
    await editor.locator('pre.kept-code code[tabindex]').waitFor();
    assert.equal(await editor.locator('pre.kept-code code').textContent(), powershell, 'conversion can be undone');
    // BR-based pasted prose follows the same conversion path.
    await body.evaluate(element => {
      element.innerHTML = 'one<br><br>two<br>three'; element.focus(); const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await editor.locator(mobile ? '.mobile-icon.format' : '.text-format-trigger').click();
    await editor.getByRole('button', { name: 'Code block', exact: true }).last().click();
    await editor.locator('pre.kept-code textarea').waitFor({ state: 'visible' });
    assert.equal(await editor.locator('pre.kept-code textarea').inputValue(), 'one\n\ntwo\nthree');
    await body.evaluate(element => { element.replaceChildren(document.createTextNode('Text before')); element.focus(); const range = document.createRange(); range.selectNodeContents(element); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }); await body.press('Enter');
    await editor.locator(mobile ? '.mobile-icon.format' : '.text-format-trigger').click();
    await editor.getByRole('button', { name: 'Code block', exact: true }).last().click();
    const block = editor.locator('pre.kept-code').first();
    const code = block.locator('textarea');
    await code.waitFor(); await code.waitFor({ state: 'visible' });
    await code.fill(exact);
    await code.evaluate(input => input.setSelectionRange(0, input.value.length));
    await code.press('Tab'); await code.press('Shift+Tab');
    assert.equal(await code.inputValue(), exact, 'indent/outdent must not replace selected source');
    await code.evaluate((input, text) => {
      input.select(); const data = new DataTransfer(); data.setData('text/plain', text); data.setData('text/html', '<img src=x onerror=alert(1)>');
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, exact);
    assert.equal(await code.inputValue(), exact, 'paste uses literal text, never clipboard HTML');

    await block.getByRole('button', { name: 'Copy code', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__copiedCode), exact);
    await block.getByRole('button', { name: 'Choose code language' }).click();
    await block.getByRole('searchbox', { name: 'Search languages' }).fill('JavaScript');
    await block.getByRole('button', { name: 'JavaScript', exact: true }).click();
    await block.locator('code').focus(); await code.press('Control+Enter'); await page.keyboard.type('Text after');
    const cleanBody = await body.evaluate(element => { const div = document.createElement('div'); div.innerHTML = element.innerHTML; window.codeHelpers.cleanCodeBlocks(div); return div.innerHTML; });
    assert.ok(cleanBody.includes('Text before')); assert.ok(cleanBody.includes('Text after')); assert.match(cleanBody, /data-code-language="javascript"/);
    assert.doesNotMatch(cleanBody, /kept-code-header|hljs-|Continue writing|Copy code/);
    if (mobile) await editor.locator('.mobile-icon.back').click(); else await editor.locator('.close-btn').click();
    await wait(async () => (await api('/notes')).some(note => note.noteTitle === title && note.noteBody.includes('Text after')), 'code note did not save');
    let stored = (await api('/notes')).find(note => note.noteTitle === title);
    const raw = await page.evaluate(html => { const div = document.createElement('div'); div.innerHTML = html; return div.querySelector('code').textContent; }, stored.noteBody);
    assert.equal(raw, exact); assert.doesNotMatch(stored.noteBody, /kept-code-header|hljs-|data-code-chrome/);
    assert.equal(await page.evaluate(() => window.__codeXss), undefined);

    await page.reload();
    await page.getByText(title, { exact: true }).first().click();
    const reopened = page.locator('app-input .note-main:visible').last();
    assert.equal(await reopened.locator('pre.kept-code code').textContent(), exact);
    await reopened.locator('pre.kept-code code[tabindex]').waitFor();
    if (mobile) {
      const reopenedBody = reopened.locator('.note-body[contenteditable="true"]').first();
      await reopenedBody.evaluate(element => {
        element.focus(); const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const text = walker.nextNode();
        const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        window.__editFormatBlurs = 0; element.addEventListener('blur', () => window.__editFormatBlurs++);
      });
      const selectedText = await page.evaluate(() => window.getSelection().toString());
      await reopened.locator('.mobile-icon.format').tap();
      await reopened.locator('.mobile-format-toolbar').waitFor({ state: 'visible' });
      await reopened.locator('.mobile-icon.format').tap();
      assert.equal(await reopenedBody.evaluate(element => document.activeElement === element), true, 'reopened note retains editable focus');
      assert.equal(await page.evaluate(() => window.getSelection().toString()), selectedText);
      assert.equal(await page.evaluate(() => window.__editFormatBlurs), 0, 'reopened note must not blur when toggling formatting');
    }
    await reopened.locator('pre.kept-code code[tabindex]').focus();
    await reopened.locator('pre.kept-code textarea').fill('');
    await reopened.locator('pre.kept-code textarea').press('Backspace');

    assert.equal(await reopened.locator('pre.kept-code').count(), 0);
    await page.keyboard.press('Control+z');
    await wait(() => reopened.locator('pre.kept-code').count(), 'code delete undo failed');
    if (mobile) await reopened.locator('.mobile-icon.back').click(); else await reopened.locator('.close-btn').click();

    // The fence shortcut and plain prose containing literal backticks.
    if (mobile) await page.getByRole('button', { name: 'New note', exact: true }).click(); else await page.getByPlaceholder('Take a note…').first().click();
    const shortcut = page.locator('app-input .note-main:visible').last();
    await shortcut.locator('.note-body[contenteditable="true"]').first().fill('```');
    await shortcut.locator('.note-body[contenteditable="true"]').first().press('Enter');
    await shortcut.locator('pre.kept-code textarea').waitFor();
    await shortcut.locator('pre.kept-code textarea').fill('const key = "literal https://example.test";');
    await shortcut.locator('pre.kept-code textarea').press('Enter');
    await shortcut.locator('pre.kept-code textarea').press('Tab');
    await page.keyboard.type('next');
    assert.equal(await shortcut.locator('pre.kept-code textarea').inputValue(), 'const key = "literal https://example.test";\n  next');
    await shortcut.locator('pre.kept-code textarea').press('Shift+Tab');
    assert.equal(await shortcut.locator('pre.kept-code textarea').inputValue(), 'const key = "literal https://example.test";\nnext');
    if (mobile) await shortcut.locator('.mobile-icon.back').click(); else await shortcut.locator('.close-btn').click();

    const snippet = Array.from({ length: 24 }, (_, index) => `const item${index} = "<img src=x onerror=alert(1)>";`).join('\n');
    const previewBody = await page.evaluate(text => window.codeHelpers.codeBlockHtml(text, 'javascript', 'user') + '<div class="kept-checklist-anchor kept-list-tasks"></div>' + window.codeHelpers.codeBlockHtml('second', 'python', 'user'), snippet).catch(async () => {
      return page.evaluate(text => window.codeHelpers.codeBlockHtml(text, 'javascript', 'user') + '<div class="kept-checklist-anchor kept-list-tasks"></div>' + window.codeHelpers.codeBlockHtml('second', 'python', 'user'), snippet);
    });
    stored = await api('/notes', { noteTitle: `Preview ${mobile}`, noteBody: previewBody, isCbox: true, checkBoxes: [{ id: 1, listId: 'tasks', data: 'Keep this task', done: false, indentLevel: 0 }], bgColor: mobile ? '#1a4a4a' : '#fdcfe8' });
    await page.reload();
    const card = page.locator('app-notes .note-main').filter({ has: page.getByText(`Preview ${mobile}`, { exact: true }) });
    await card.scrollIntoViewIfNeeded();
    await card.getByText('+14 lines', { exact: true }).waitFor();
    await card.locator('.hljs-keyword').first().waitFor();
    assert.equal(await card.locator('.kept-code-language').first().textContent(), 'JavaScript');
    await card.getByText('+1 code block', { exact: true }).waitFor();
    assert.equal((await card.locator('pre.kept-code:not([hidden]) code').textContent()).split('\n').length, 10);
    await card.getByRole('button', { name: 'Copy code', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.__copiedCode), snippet);
    assert.equal(await page.locator('app-input .note-main:visible').count(), 0, 'copy must not open note');
    const overflow = await card.evaluate(element => { const pre = element.querySelector('pre.kept-code'); return pre.getBoundingClientRect().right > element.getBoundingClientRect().right + 1; });
    assert.equal(overflow, false);
    await card.getByText(`Preview ${mobile}`, { exact: true }).click();
    const previewEditor = page.locator('app-input .note-main:visible').last();
    await previewEditor.getByRole('button', { name: 'Choose code language' }).first().click();
    const menuBounds = await previewEditor.locator('.kept-code-menu').first().boundingBox();
    assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= (mobile ? 390 : 1280));
    await page.screenshot({ path: `/tmp/kept-code-editor-${mobile ? 'mobile' : 'desktop'}.png` });
    if (mobile) await previewEditor.locator('.mobile-icon.back').click(); else await previewEditor.locator('.close-btn').click();
    await previewEditor.waitFor({ state: 'hidden' });
    const hybrid = await api(`/notes/${stored.id}`);
    assert.equal(hybrid.checkBoxes[0].id, 1); assert.equal(hybrid.checkBoxes[0].data, 'Keep this task'); assert.ok(hybrid.noteBody.includes('second'));
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('note'));
    await context.addInitScript(() => { window.Worker = undefined; });
    await page.reload();
    await card.getByText('+14 lines', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Copy code', exact: true }).first().click();
    assert.equal(await page.evaluate(() => window.__copiedCode), snippet, 'blocked workers still allow full plain-code copy');
    assert.equal(await card.locator('.hljs-keyword').count(), 0);
    if (mobile) await page.getByRole('button', { name: 'New note', exact: true }).click(); else await page.getByPlaceholder('Take a note…').first().click();
    const noWorker = page.locator('app-input .note-main:visible').last().locator('.note-body[contenteditable="true"]').first();
    await noWorker.evaluate((element, value) => {
      element.focus(); const data = new DataTransfer(); data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, rawPaste);
    await page.waitForTimeout(100);
    assert.equal(await noWorker.locator('pre.kept-code').count(), 0);
    assert.equal(await noWorker.evaluate(element => window.codeHelpers.codeText(element)), rawPaste, 'unavailable worker keeps pasted text intact');
    await noWorker.evaluate((element, value) => {
      element.replaceChildren(); element.focus(); const data = new DataTransfer(); data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, csharpPaste);
    await noWorker.locator('pre.kept-code textarea').waitFor({ state: 'visible' });
    assert.equal(await noWorker.locator('pre.kept-code textarea').inputValue(), csharpPaste, 'obvious code converts even when workers are unavailable');


    await page.screenshot({ path: `/tmp/kept-code-${mobile ? 'mobile' : 'desktop'}.png` });
    const emptyExisting = await api('/notes', { noteTitle: `Empty paste target ${mobile}`, noteBody: '' });
    await page.goto(fixture.origin + '/');
    await page.getByText(emptyExisting.noteTitle, { exact: true }).first().click();
    const emptyEditorBody = page.locator('app-input .note-main:visible').last().locator('.note-body[contenteditable="true"]').first();
    await emptyEditorBody.waitFor({ state: 'visible' });
    await emptyEditorBody.evaluate((element, value) => {
      element.focus(); const data = new DataTransfer(); data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, csharpPaste);
    await emptyEditorBody.locator('pre.kept-code textarea').waitFor({ state: 'visible' });
    assert.equal(await emptyEditorBody.locator('pre.kept-code textarea').inputValue(), csharpPaste, 'a saved empty draft also accepts automatic code paste');
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: insert, copy, language, literal text, save/reopen, undo, fence, indentation and bounded preview passed`);
    await context.close(); await browser.close(); browser = undefined;
  }
} finally { await browser?.close(); await fixture.close(); }
