import { AfterViewInit, Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output } from '@angular/core';
import { CodeHighlightService } from '../../services/code-highlight.service';
import { CODE_SELECTOR, codeLanguages, codePreview, codeText, readCodeLanguage, indentCode } from '../../utils/code-blocks';
import { sanitizeNoteHtml } from '../../utils/note-html';
import { uiPlural, uiText } from '../../i18n/messages';
import { codeSurface } from '../../utils/code-surface';

type Block = { timer?: ReturnType<typeof setTimeout>; input?: HTMLTextAreaElement; code: HTMLElement; text: string; label: HTMLButtonElement | HTMLSpanElement; version: number; signature: string; focused: boolean };

/** Editor chrome is transient. PRE/CODE text and language metadata are the only saved content. */
@Directive({ selector: '[appCodeBlocks]', standalone: false })
export class CodeBlocksDirective implements AfterViewInit, OnDestroy {
  @Input() appCodeBlocks: 'editor' | 'preview' = 'preview';
  @Output() codeEditStart = new EventEmitter<void>();
  @Output() codeEdited = new EventEmitter<void>();
  private observer?: MutationObserver;
  private appearanceObserver?: MutationObserver;
  private intersection?: IntersectionObserver;
  private visible = false;
  private frame = 0;
  private destroyed = false;
  private blocks = new Map<HTMLElement, Block>();
  private readonly onKey = (event: Event) => this.key(event as KeyboardEvent);
  private readonly onPaste = (event: Event) => this.paste(event as ClipboardEvent);
  private readonly onBeforeInput = (event: Event) => {
    if (this.editableCode(event.target)) this.codeEditStart.emit();
  };
  private readonly onInput = (event: Event) => {
    const pre = this.editableCode(event.target);
    if (!pre) return;
    const state = this.blocks.get(pre);
    if (state) { state.text = state.input!.value; state.code.textContent = state.text; this.sizeInput(state.input!); state.signature = ''; state.version++; }
    // The parent saves through codeEdited; do not also treat this as rich-text input.
    event.stopPropagation(); this.codeEdited.emit(); this.schedule();
  };

  constructor(private element: ElementRef<HTMLElement>, private zone: NgZone, private highlighter: CodeHighlightService) {}

  ngAfterViewInit() {
    const host = this.element.nativeElement;
    this.zone.runOutsideAngular(() => {
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(host, { childList: true, subtree: true, characterData: true });
      if (typeof IntersectionObserver !== 'undefined') {
        this.intersection = new IntersectionObserver(entries => { this.visible = entries.some(entry => entry.isIntersecting); if (this.visible) this.schedule(); });
        this.intersection.observe(host.closest('.note-main') || host);
      } else this.visible = true;
    });
    if (this.appCodeBlocks === 'editor') {
      host.addEventListener('keydown', this.onKey, true);
      host.addEventListener('paste', this.onPaste, true);
      host.addEventListener('beforeinput', this.onBeforeInput, true);
      host.addEventListener('input', this.onInput, true);
    }
    this.schedule();
  }

  private schedule() {
    if (this.frame || this.destroyed) return;
    this.zone.runOutsideAngular(() => { this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); }); });
  }

  private render() {
    const host = this.element.nativeElement;
    this.observer?.disconnect();
    try {
      if (this.appCodeBlocks === 'editor') this.ensureLeadingTextLine(host);
      for (const [pre, state] of this.blocks) if (!host.contains(pre)) { clearTimeout(state.timer); this.blocks.delete(pre); }
      const previews = this.appCodeBlocks === 'preview' ? codePreview(host, 10, pre => this.blocks.get(pre)?.text ?? codeText(pre.querySelector('code') || pre)) : [];
      host.querySelector('.kept-code-extra-blocks')?.remove();
      let hiddenBlocks = 0;
      let lastVisible: HTMLElement | undefined;
      for (const pre of host.querySelectorAll<HTMLElement>(CODE_SELECTOR)) {
        const preview = previews.find(item => item.pre === pre);
        const hidden = !!preview && !preview.visible && preview.hidden > 0;
        pre.hidden = hidden;
        if (hidden) { hiddenBlocks++; continue; }
        lastVisible = pre;
        let state = this.blocks.get(pre);
        // Angular may replace innerHTML on the same host; old controls never survive it.
        if (state && !pre.contains(state.code)) { this.blocks.delete(pre); state = undefined; }
        if (!state) state = this.build(pre);
        const text = state.focused ? state.input!.value : state.text;
        const language = readCodeLanguage(pre);
        const signature = JSON.stringify([text, language, pre.getAttribute('data-code-source'), preview?.visible, preview?.hidden]);
        const note = host.closest<HTMLElement>('.note-main');
        const surface = codeSurface(note?.style.backgroundColor || '', document.body.classList.contains('light-theme'));
        pre.style.setProperty('--code-surface', surface.background);
        for (const [name, color] of Object.entries(surface.tokens)) pre.style.setProperty(`--code-${name}`, color);
        pre.classList.toggle('code-dark', surface.dark);
        if (state.signature === signature && state.version) continue;
        state.signature = signature;
        state.text = text;
        const version = ++state.version;
        const shown = preview ? preview.visible : text;
        state.code.textContent = shown;
        if (state.focused) state.code.scrollLeft = state.input!.scrollLeft;
        pre.querySelector('.kept-code-more')?.remove();
        if (preview?.hidden) {
          const more = document.createElement('div'); more.className = 'kept-code-more';
          more.textContent = uiPlural('code.more_lines', preview.hidden); pre.append(more);
        }
        state.label.textContent = this.languageLabel(language === 'auto' ? 'plaintext' : language);
        clearTimeout(state.timer);
        if (this.visible && shown) {
          const highlight = () => void this.highlighter.highlight(shown, language, text.slice(0, 500)).then(result => {
            if (this.destroyed || !pre.isConnected || state!.version !== version) return;
            this.observer?.disconnect();
            // This is the display copy only. Never replace the focused plain-text
            // control, its value, selection or IME composition with coloured HTML.
            state!.code.innerHTML = sanitizeNoteHtml(result.html || '');
            if (!result.html) state!.code.textContent = shown;
            if (state!.focused) { state!.code.scrollLeft = state!.input!.scrollLeft; state!.code.scrollTop = state!.input!.scrollTop; }
            state!.label.textContent = language === 'auto' && result.language !== 'plaintext'
              ? `${this.languageLabel(result.language)} · ${uiText('code.detected')}` : this.languageLabel(language === 'auto' && result.isCode ? 'auto' : language === 'auto' ? 'plaintext' : language);
            this.observe();
          });
          if (state.focused) state.timer = setTimeout(highlight, 500);
          else highlight();
        } else if (!this.visible) state.signature = '';
      }
      if (hiddenBlocks && lastVisible) {
        const extra = document.createElement('div'); extra.className = 'kept-code-extra-blocks';
        extra.textContent = uiPlural('code.more_blocks', hiddenBlocks); lastVisible.after(extra);
      }
      if (this.blocks.size && !this.appearanceObserver) {
        this.appearanceObserver = new MutationObserver(() => { for (const state of this.blocks.values()) state.signature = ''; this.schedule(); });
        this.appearanceObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        const note = host.closest('.note-main');
        if (note) this.appearanceObserver.observe(note, { attributes: true, attributeFilter: ['style'] });
      }
    } finally { this.observe(); }
  }

  private ensureLeadingTextLine(host: HTMLElement) {
    const first = Array.from(host.childNodes).find(node => node.nodeType === Node.ELEMENT_NODE || node.textContent?.trim());
    if (!(first instanceof HTMLElement) || !first.matches(CODE_SELECTOR)) return;
    const line = document.createElement('div'); line.className = 'kept-code-leading-line';
    line.append(document.createElement('br'));
    host.insertBefore(line, first);
  }

  private observe() { if (!this.destroyed) this.observer?.observe(this.element.nativeElement, { childList: true, subtree: true, characterData: true }); }
  private languageLabel(language: string) {
    return language === 'auto' ? uiText('code.auto_detect') : language === 'plaintext' ? uiText('code.plain_text') : codeLanguages.find(item => item.id === language)?.name || uiText('code.plain_text');
  }
  private build(pre: HTMLElement): Block {
    const text = codeText(pre.querySelector('code') || pre);
    pre.replaceChildren();
    pre.contentEditable = 'false'; pre.dir = 'ltr';
    const header = document.createElement('div'); header.className = 'kept-code-header'; header.dataset['codeChrome'] = 'true';
    const label = document.createElement(this.appCodeBlocks === 'editor' ? 'button' : 'span');
    label.className = 'kept-code-language';
    if (label instanceof HTMLButtonElement) {
      label.type = 'button'; label.setAttribute('aria-haspopup', 'dialog'); label.setAttribute('aria-expanded', 'false');
      label.setAttribute('aria-label', uiText('code.choose_language'));
      label.addEventListener('click', event => { event.stopPropagation(); this.languageMenu(pre, label); });
    }
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'kept-code-copy';
    copy.setAttribute('aria-label', uiText('code.copy')); copy.title = uiText('code.copy');
    copy.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">content_copy</span>';
    if (this.appCodeBlocks === 'editor') copy.append(document.createTextNode(uiText('common.copy')));
    copy.addEventListener('mousedown', event => event.preventDefault());
    for (const name of ['pointerdown', 'touchstart', 'dblclick']) copy.addEventListener(name, event => event.stopPropagation());
    copy.addEventListener('click', async event => {
      event.stopPropagation();
      const state = this.blocks.get(pre)!;
      try {
        await this.copy(state.focused ? state.input!.value : state.text);
        copy.title = uiText('common.copied'); copy.setAttribute('aria-label', copy.title);
        copy.classList.add('copied'); copy.querySelector('span')!.textContent = 'check';
        setTimeout(() => { copy.classList.remove('copied'); copy.querySelector('span')!.textContent = 'content_copy'; copy.title = uiText('code.copy'); copy.setAttribute('aria-label', copy.title); }, 1500);
      } catch { copy.title = uiText('code.copy_failed'); copy.setAttribute('aria-label', copy.title); }
    });
    header.append(label, copy);
    const code = document.createElement('code'); code.textContent = text;
    if (this.appCodeBlocks === 'preview') {
      code.className = 'kept-code-scroll'; code.tabIndex = 0;
      code.setAttribute('role', 'region'); code.setAttribute('aria-label', uiText('code.block'));
    }
    const state: Block = { code, text, label, version: 0, signature: '', focused: false };
    this.blocks.set(pre, state);
    pre.append(header, code);
    if (this.appCodeBlocks === 'editor') {
      // A native plain-text control avoids contenteditable splitting snippets
      // into rich-text blocks on mobile keyboards, paste or dictation.
      const input = document.createElement('textarea'); input.className = 'kept-code-input';
      input.value = text; input.hidden = true; input.wrap = 'off'; input.spellcheck = false;
      input.setAttribute('autocapitalize', 'off'); input.setAttribute('autocorrect', 'off');
      input.setAttribute('aria-label', uiText('code.block'));
      const stage = document.createElement('div'); stage.className = 'kept-code-editor';
      code.replaceWith(stage); stage.append(code, input);
      state.input = input;
      input.addEventListener('scroll', () => { code.scrollLeft = input.scrollLeft; code.scrollTop = input.scrollTop; });
      const convert = document.createElement('button'); convert.type = 'button'; convert.className = 'kept-code-convert';
      convert.textContent = '×'; convert.title = uiText('code.convert_to_text'); convert.setAttribute('aria-label', convert.title);
      convert.addEventListener('mousedown', event => event.preventDefault());
      convert.addEventListener('click', event => { event.stopPropagation(); this.convertToText(pre); });
      header.append(convert);
      code.tabIndex = 0; code.setAttribute('role', 'textbox'); code.setAttribute('aria-label', uiText('code.block'));
      let clickOffset: number | undefined;
      code.addEventListener('mousedown', event => {
        const doc = document as Document & {
          caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
          caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
        const caret = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
        const node = position?.offsetNode || caret?.startContainer;
        if (node && code.contains(node)) {
          const prefix = document.createRange(); prefix.selectNodeContents(code);
          prefix.setEnd(node, position?.offset ?? caret!.startOffset);
          clickOffset = codeText(prefix.cloneContents()).length;
        }
        event.preventDefault(); code.focus();
      });
      code.addEventListener('focus', () => {
        if (state.focused) { input.focus(); return; }
        state.focused = true; state.version++; state.signature = ''; input.value = state.text; this.schedule();
        pre.classList.add('code-editing'); code.tabIndex = -1; code.setAttribute('aria-hidden', 'true');
        input.hidden = false; this.sizeInput(input); input.focus();
        const offset = Math.min(input.value.length, clickOffset ?? input.value.length); clickOffset = undefined;
        input.setSelectionRange(offset, offset); input.scrollLeft = code.scrollLeft;
      });
      input.addEventListener('blur', () => {
        state.text = input.value; code.textContent = state.text; state.focused = false;
        input.hidden = true; pre.classList.remove('code-editing'); code.tabIndex = 0; code.removeAttribute('aria-hidden');
        code.scrollLeft = input.scrollLeft; state.signature = ''; this.schedule();
      });
      if (pre.hasAttribute('data-code-focus')) {
        pre.removeAttribute('data-code-focus'); if (pre.isConnected) code.focus();
      }
      const exit = document.createElement('button'); exit.type = 'button'; exit.className = 'kept-code-exit'; exit.dataset['codeChrome'] = 'true';
      exit.textContent = uiText('code.continue_writing'); exit.title = uiText('code.exit_hint');
      exit.addEventListener('click', event => { event.stopPropagation(); this.exit(pre); }); pre.append(exit);
    }
    return state;
  }

  private convertToText(pre: HTMLElement) {
    const state = this.blocks.get(pre);
    if (!state) return;
    const text = state.focused ? state.input!.value : state.text;
    this.codeEditStart.emit();
    const fragment = document.createDocumentFragment();
    let last!: HTMLDivElement;
    for (const value of text.split('\n')) {
      last = document.createElement('div');
      if (value) last.textContent = value;
      else last.append(document.createElement('br'));
      fragment.append(last);
    }
    clearTimeout(state.timer); state.version++; this.blocks.delete(pre);
    pre.replaceWith(fragment);
    this.element.nativeElement.focus(); this.focus(last);
    this.codeEdited.emit(); this.schedule();
  }

  private editableCode(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement && target.matches('textarea.kept-code-input') ? target.closest<HTMLElement>(CODE_SELECTOR) : null;
  }
  private key(event: KeyboardEvent) {
    const pre = this.editableCode(event.target);
    if (!pre) return;
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); this.exit(pre); return; }
    if (event.key === 'Escape') { event.preventDefault(); this.exit(pre); return; }
    if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
    const state = this.blocks.get(pre)!;
    if (event.key === 'Backspace' && ['', '\n'].includes(state.input!.value)) {
      event.preventDefault(); this.codeEditStart.emit(); const line = document.createElement('div'); line.append(document.createElement('br'));
      pre.replaceWith(line); this.focus(line); this.codeEdited.emit(); return;
    }
    if (event.key === 'Tab') {
      // Escape/Continue writing exits the block; modifier+Tab remains available for navigation.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.shiftKey) { event.preventDefault(); this.insertText(pre, '', true); }
      else { event.preventDefault(); this.insertText(pre, '  '); }
    }
    if (event.key === 'Enter') { event.preventDefault(); this.insertText(pre, '\n'); }
  }
  private paste(event: ClipboardEvent) {
    const pre = this.editableCode(event.target);
    if (!pre) return;
    event.preventDefault(); event.stopPropagation();
    this.insertText(pre, (event.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n'));
  }
  private insertText(pre: HTMLElement, text: string, outdent = false) {
    const state = this.blocks.get(pre)!;
    const input = state.input!;
    this.codeEditStart.emit();
    const start = input.selectionStart, end = input.selectionEnd;
    if (outdent || text === '  ' && start !== end) {
      const changed = indentCode(input.value, start, end, outdent);
      input.value = changed.text; input.setSelectionRange(changed.start, changed.end);
    } else input.setRangeText(text, start, end, 'end');
    state.text = input.value; state.code.textContent = state.text;
    this.sizeInput(input); state.signature = ''; state.version++;
    this.codeEdited.emit(); this.schedule();
  }
  private sizeInput(input: HTMLTextAreaElement) {
    const line = parseFloat(getComputedStyle(input).lineHeight) || 22;
    input.style.height = `${Math.max(2, input.value.split('\n').length) * line + 20}px`;
  }

  private focus(element: HTMLElement) {
    element.focus(); const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }
  private exit(pre: HTMLElement) {
    let line = pre.nextElementSibling as HTMLElement | null;
    if (!line || line.contentEditable === 'false' || line.matches(CODE_SELECTOR)) {
      this.codeEditStart.emit(); line = document.createElement('div'); line.append(document.createElement('br')); pre.after(line); this.codeEdited.emit();
    }
    this.focus(line);
    this.element.nativeElement.focus(); this.focus(line);
  }
  private languageMenu(pre: HTMLElement, trigger: HTMLButtonElement) {
    const existing = pre.querySelector('.kept-code-menu');
    if (existing) { existing.remove(); trigger.setAttribute('aria-expanded', 'false'); return; }
    const menu = document.createElement('div'); menu.className = 'kept-code-menu'; menu.dataset['codeChrome'] = 'true';
    menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', uiText('code.choose_language'));
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = uiText('code.search_languages'); search.setAttribute('aria-label', search.placeholder);
    const list = document.createElement('div'); list.className = 'kept-code-language-options';
    const draw = () => {
      list.replaceChildren();
      for (const id of ['auto', ...codeLanguages.map(item => item.id)]) {
        const name = this.languageLabel(id); if (!name.toLowerCase().includes(search.value.toLowerCase())) continue;
        const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
        button.setAttribute('aria-pressed', String(readCodeLanguage(pre) === id));
        button.addEventListener('click', () => {
          this.codeEditStart.emit(); pre.setAttribute('data-code-language', id); pre.setAttribute('data-code-source', id === 'auto' ? 'auto' : 'user');
          for (const name of Array.from(pre.classList)) if (name.startsWith('kept-code-lang-') || name === 'kept-code-user') pre.classList.remove(name);
          pre.classList.add(`kept-code-lang-${id}`); if (id !== 'auto') pre.classList.add('kept-code-user');
          menu.remove(); trigger.setAttribute('aria-expanded', 'false'); this.blocks.get(pre)!.signature = ''; this.codeEdited.emit(); trigger.focus(); this.schedule();
        }); list.append(button);
      }
    };
    search.addEventListener('input', event => { event.stopPropagation(); draw(); });
    menu.addEventListener('click', event => event.stopPropagation());
    menu.addEventListener('paste', event => event.stopPropagation());
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); menu.remove(); trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); } });
    menu.addEventListener('focusout', () => setTimeout(() => { if (!menu.contains(document.activeElement) && document.activeElement !== trigger) { menu.remove(); trigger.setAttribute('aria-expanded', 'false'); } }));
    menu.append(search, list); pre.append(menu); trigger.setAttribute('aria-expanded', 'true'); draw(); search.focus();
  }
  private async copy(text: string) {
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch {} }
    const input = document.createElement('textarea'); input.value = text; input.style.cssText = 'position:fixed;opacity:0';
    const active = document.activeElement as HTMLElement | null; document.body.append(input); input.select();
    try { if (!document.execCommand('copy')) throw new Error('Copy failed'); } finally { input.remove(); active?.focus(); }
  }
  ngOnDestroy() {
    this.destroyed = true; cancelAnimationFrame(this.frame); this.observer?.disconnect(); this.appearanceObserver?.disconnect(); this.intersection?.disconnect();
    const host = this.element.nativeElement;
    for (const [name, listener] of [['keydown', this.onKey], ['paste', this.onPaste], ['beforeinput', this.onBeforeInput], ['input', this.onInput]] as const) host.removeEventListener(name, listener, true);
    for (const state of this.blocks.values()) clearTimeout(state.timer);
    this.blocks.clear();
  }
}
