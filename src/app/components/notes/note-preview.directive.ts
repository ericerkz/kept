import { AfterViewInit, ChangeDetectorRef, Directive, ElementRef, Input, NgZone, OnChanges, OnDestroy } from '@angular/core';

/** Bounds overview content only. Footers and the editor never enter this frame. */
@Directive({ selector: '[appNotePreview]', exportAs: 'notePreview', standalone: false })
export class NotePreviewDirective implements AfterViewInit, OnChanges, OnDestroy {
  @Input() appNotePreview = false;
  hiddenCount = 0;
  firstHiddenIndex = 0;
  private resize?: ResizeObserver;
  private mutations?: MutationObserver;
  private frame = 0;
  private destroyed = false;

  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone, private cd: ChangeDetectorRef) {}

  ngAfterViewInit() {
    const element = this.host.nativeElement;
    this.zone.runOutsideAngular(() => {
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(element);
      if (element.firstElementChild) this.resize.observe(element.firstElementChild);
      this.mutations = new MutationObserver(() => this.schedule());
      this.mutations.observe(element, { childList: true, subtree: true, characterData: true });
    });
    this.schedule();
  }

  ngOnChanges() { this.schedule(); }

  private schedule() {
    if (this.frame || this.destroyed) return;
    this.zone.runOutsideAngular(() => {
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
    });
  }

  private measure() {
    const host = this.host.nativeElement;
    const content = host.firstElementChild as HTMLElement | null;
    if (!content) return;
    host.classList.toggle('preview-has-images', this.appNotePreview);
    if (this.appNotePreview && !host.clientWidth) return;
    // A usable minimum on narrow cards, a proportional middle and a ceiling
    // for wide list view. Labels, reminders and attachments remain outside.
    const limit = Math.round(Math.min(520, Math.max(300, host.clientWidth * 1.6)));
    const clipped = this.appNotePreview && content.scrollHeight > limit + 1;
    host.style.maxHeight = this.appNotePreview ? `${limit}px` : '';
    host.classList.toggle('preview-clipped', clipped);
    const cutoff = host.getBoundingClientRect().top + limit;
    const hidden = new Set<number>();
    if (clipped) {
      for (const image of content.querySelectorAll<HTMLElement>('[data-preview-indices]')) {
        const rect = image.getBoundingClientRect();
        if (Math.max(0, Math.min(rect.bottom, cutoff) - rect.top) < rect.height / 2) {
          image.dataset['previewIndices']!.split(',').forEach(index => hidden.add(Number(index)));
        }
      }
    }
    // Content below the fade must not remain an invisible keyboard target.
    for (const target of content.querySelectorAll<HTMLElement>('button, a, input, [tabindex]')) {
      target.inert = clipped && target.getBoundingClientRect().top >= cutoff - 24;
    }
    const first = hidden.size ? Math.min(...hidden) : 0;
    if (this.hiddenCount !== hidden.size || this.firstHiddenIndex !== first) {
      this.zone.run(() => {
        this.hiddenCount = hidden.size;
        this.firstHiddenIndex = first;
        this.cd.markForCheck();
      });
    }
  }

  ngOnDestroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    this.mutations?.disconnect();
  }
}
