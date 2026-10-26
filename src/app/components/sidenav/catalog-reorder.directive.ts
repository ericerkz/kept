import { Directive, ElementRef, EventEmitter, HostListener, Input, NgZone, OnDestroy, Output } from '@angular/core';

@Directive({ selector: '[appCatalogReorder]', standalone: false })
export class CatalogReorderDirective implements OnDestroy {
  @Input() appCatalogReorderDisabled = false;
  @Output() catalogOrderChange = new EventEmitter<string[]>();
  private drag?: {
    pointerId: number; handle: HTMLElement; row: HTMLElement; names: string[];
    startX: number; startY: number; x: number; y: number; offsetY: number;
    active: boolean; index: number; preview?: HTMLElement; lastFrame: number;
    layout?: Array<{ row: HTMLElement; top: number; height: number; transform: string }>;
    visualIndex?: number;
  };
  private frame?: number;

  constructor(private element: ElementRef<HTMLElement>, private zone: NgZone) {}

  private rows() {
    return Array.from(this.element.nativeElement.querySelectorAll<HTMLElement>(':scope > [data-catalog-name]'));
  }

  @HostListener('pointerdown', ['$event'])
  start(event: PointerEvent) {
    if (this.appCatalogReorderDisabled || this.drag || !event.isPrimary || event.button !== 0) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('.catalog-drag-handle');
    const row = handle?.closest<HTMLElement>('[data-catalog-name]');
    if (!handle || !row || row.parentElement !== this.element.nativeElement) return;
    // Let an edited name save before accepting a reorder.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    event.preventDefault();
    event.stopPropagation();
    this.drag = { pointerId: event.pointerId, handle, row, names: this.rows().map(item => item.dataset['catalogName']!),
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      offsetY: event.clientY - row.getBoundingClientRect().top, active: false, index: -1, lastFrame: 0 };
    handle.setPointerCapture(event.pointerId);
    this.zone.runOutsideAngular(() => {
      document.addEventListener('pointermove', this.move, { capture: true, passive: false });
      document.addEventListener('pointerup', this.finish, true);
      document.addEventListener('pointercancel', this.cancel, true);
      document.addEventListener('keydown', this.keydown, true);
      document.addEventListener('visibilitychange', this.cancel);
      handle.addEventListener('lostpointercapture', this.cancel);
      window.addEventListener('blur', this.cancel);
      window.addEventListener('resize', this.cancel);
    });
  }

  private move = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (this.appCatalogReorderDisabled) { this.cancel(); return; }
    event.preventDefault();
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    if (!drag.active) {
      drag.active = true;
      const list = this.element.nativeElement, listTop = list.getBoundingClientRect().top;
      drag.layout = this.rows().map(row => {
        const rect = row.getBoundingClientRect();
        return { row, top: rect.top - listTop + list.scrollTop, height: rect.height, transform: row.style.transform };
      });
      list.classList.add('catalog-reordering');
      drag.row.classList.add('catalog-drag-source');
      const rect = drag.row.getBoundingClientRect();
      const style = getComputedStyle(drag.row.querySelector('input')!);
      const preview = document.createElement('div');
      preview.className = 'catalog-drag-preview';
      preview.textContent = drag.row.dataset['catalogName']!;
      preview.setAttribute('aria-hidden', 'true');
      Object.assign(preview.style, { position: 'fixed', left: `${rect.left}px`, top: '0', width: `${rect.width}px`,
        height: `${rect.height}px`, boxSizing: 'border-box', padding: '12px', borderRadius: '6px',
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', font: style.font, color: style.color,
        background: getComputedStyle(this.element.nativeElement.closest('.label-modal-main')!).backgroundColor,
        boxShadow: '0 3px 12px #0004', zIndex: '10050', pointerEvents: 'none' });
      document.body.append(preview); drag.preview = preview;
      this.frame = requestAnimationFrame(this.tick);
    }
    this.position();
  };

  private position() {
    const drag = this.drag;
    if (!drag?.active) return;
    drag.preview!.style.transform = `translateY(${drag.y - drag.offsetY}px)`;
    const rect = this.element.nativeElement.getBoundingClientRect();
    drag.index = -1;
    if (drag.x < rect.left || drag.x > rect.right || drag.y < rect.top || drag.y > rect.bottom) {
      this.layoutAt(drag.names.indexOf(drag.row.dataset['catalogName']!));
      return;
    }
    const others = drag.layout!.filter(item => item.row !== drag.row);
    // Hit-test against the original layout, so animated rows cannot move their
    // own thresholds and make the insertion point oscillate under the pointer.
    const contentY = drag.y - rect.top + this.element.nativeElement.scrollTop;
    drag.index = others.findIndex(item => contentY < item.top + item.height / 2);
    if (drag.index < 0) drag.index = others.length;
    this.layoutAt(drag.index);
  }

  private layoutAt(index: number) {
    const drag = this.drag;
    if (!drag?.layout || drag.visualIndex === index) return;
    drag.visualIndex = index;
    const source = drag.layout.find(item => item.row === drag.row)!;
    const ordered = drag.layout.filter(item => item !== source);
    ordered.splice(index, 0, source);
    let top = drag.layout[0].top;
    for (const item of ordered) {
      item.row.style.transform = `${item.transform} translateY(${top - item.top}px)`;
      top += item.height;
    }
  }

  private tick = (time: number) => {
    const drag = this.drag;
    if (!drag?.active) return;
    if (this.appCatalogReorderDisabled || !drag.row.isConnected || !this.element.nativeElement.getClientRects().length) { this.cancel(); return; }
    const list = this.element.nativeElement, rect = list.getBoundingClientRect();
    const elapsed = Math.min(32, drag.lastFrame ? time - drag.lastFrame : 16);
    drag.lastFrame = time;
    if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom) {
      const speed = drag.y < rect.top + 36 ? -1 : drag.y > rect.bottom - 36 ? 1 : 0;
      list.scrollTop += speed * elapsed * 0.5;
      this.position();
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private finish = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY; this.position();
    const current = this.rows().map(row => row.dataset['catalogName']!);
    let names: string[] | undefined;
    if (drag.active && drag.index >= 0 && !this.appCatalogReorderDisabled && JSON.stringify(current) === JSON.stringify(drag.names)) {
      names = drag.names.filter(name => name !== drag.row.dataset['catalogName']);
      names.splice(drag.index, 0, drag.row.dataset['catalogName']!);
      if (JSON.stringify(names) === JSON.stringify(drag.names)) names = undefined;
    }
    this.cancel();
    if (names) this.zone.run(() => this.catalogOrderChange.emit(names));
  };

  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); }
  };

  private cancel = () => {
    const drag = this.drag;
    this.drag = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    drag?.preview?.remove();
    drag?.row.classList.remove('catalog-drag-source');
    drag?.handle.removeEventListener('lostpointercapture', this.cancel);
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    this.element.nativeElement.classList.remove('catalog-reordering');
    drag?.layout?.forEach(item => { item.row.style.transform = item.transform; });
    document.removeEventListener('pointermove', this.move, true);
    document.removeEventListener('pointerup', this.finish, true);
    document.removeEventListener('pointercancel', this.cancel, true);
    document.removeEventListener('keydown', this.keydown, true);
    document.removeEventListener('visibilitychange', this.cancel);
    window.removeEventListener('blur', this.cancel);
    window.removeEventListener('resize', this.cancel);
  };

  ngOnDestroy() { this.cancel(); }
}
