import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { OverviewImage } from '../../utils/overview-images';
import { uiPlural } from '../../i18n/messages';

// An encrypted note's image whose decrypted copy isn't ready: its address is
// still the kept://file/ reference, which no image element can load.
const isPendingEncrypted = (src: string) => String(src || '').trim().startsWith('kept://');

@Component({
  selector: 'app-note-preview-images', standalone: false,
  template: `
    <div class="preview-images" [class.preview-cover]="cover" [class.preview-grid]="images.length > 1" [class.preview-trio]="images.length === 3">
      @for (image of images.slice(0, 4); track image.index; let i = $index) {
        <button type="button" class="preview-image-tile" [class.preview-image-wide]="images.length === 3 && i === 0"
          [style.aspect-ratio]="images.length === 1 ? aspect : null"
          [attr.data-preview-indices]="representedIndices(i)"
          [attr.aria-label]="i === 3 && images.length > 4 ? moreLabel(images.length - 3) : (image.alt || ('notes.open_image' | translate))"
          (mousedown)="$event.stopPropagation()" (click)="openImage(i, $event)">
          @if (sources[image.index]; as source) {
            <img [src]="source" [alt]="image.alt" draggable="false" decoding="async" (load)="loaded($event)" (error)="failed(image)">
          }
          @if (i === 3 && images.length > 4) {
            <span class="preview-image-more" aria-hidden="true">+{{ images.length - 3 }}</span>
          }
        </button>
      }
    </div>`,
  styleUrls: ['./note-preview-images.component.scss']
})
export class NotePreviewImagesComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() images: OverviewImage[] = [];
  @Input() cover = false;
  @Output() imageRequested = new EventEmitter<number>();
  sources: Record<number, string> = {};
  aspect = 1;
  readonly moreLabel = (count: number) => uiPlural('counts.more_images', count);
  private observer?: IntersectionObserver;
  private resize?: ResizeObserver;
  private generation = 0;
  private destroyed = false;
  private viewReady = false;
  private visible = new Set<Element>();
  private requested = new Map<number, number>();
  private failures = new Set<number>();
  private localPreviews = new Map<string, Map<number, Promise<string | undefined>>>();
  private objectUrls = new Set<string>();
  private renderedImages: { index: number; src: string; pending: boolean }[] = [];

  constructor(private host: ElementRef<HTMLElement>, private auth: AuthService, private zone: NgZone, private cd: ChangeDetectorRef) {}
  ngAfterViewInit() { this.viewReady = true; this.observe(); }
  ngOnChanges() {
    // Sync refreshes note/segment objects even when their photos are unchanged.
    // Compare the displayed image identities rather than the input array: keep
    // decoded images, local preview URLs and pending loads through those updates.
    // An encrypted note's image counts as changed once its decrypted copy
    // arrives (same canonical kept://file/ address, now displayable).
    const nextImages = this.images.slice(0, 4).map(image => ({ index: image.index, src: this.auth.canonicalImageUrl(image.src), pending: isPendingEncrypted(image.src) }));
    if (nextImages.length === this.renderedImages.length && nextImages.every((image, i) =>
      image.index === this.renderedImages[i].index && image.src === this.renderedImages[i].src && image.pending === this.renderedImages[i].pending)) return;
    this.renderedImages = nextImages;
    this.generation++;
    this.clearLocalPreviews();
    this.sources = {};
    this.aspect = 1;
    this.requested.clear();
    this.failures.clear();
    if (this.viewReady) requestAnimationFrame(() => { if (!this.destroyed) this.observe(); });
  }
  representedIndices(index: number) { return (index === 3 && this.images.length > 4 ? this.images.slice(3) : [this.images[index]]).map(image => image.index).join(','); }
  openImage(index: number, event: MouseEvent) {
    event.stopPropagation();
    this.imageRequested.emit(this.images[index].index);
  }
  loaded(event: Event) {
    if (this.images.length !== 1) return;
    const image = event.target as HTMLImageElement;
    this.aspect = Math.max(1, image.naturalWidth / Math.max(1, image.naturalHeight));
  }
  failed(image: OverviewImage) {
    if (this.destroyed || isPendingEncrypted(image.src)) return;
    if (this.failures.has(image.index)) return;
    this.failures.add(image.index);
    const generation = this.generation;
    void this.auth.prepareImageUrl(image.src).then(source => this.localPreview(source, this.requested.get(image.index) || 320)).then(source => {
      if (source && !this.destroyed && generation === this.generation) this.zone.run(() => { this.sources[image.index] = source; this.cd.markForCheck(); });
    }).catch(() => {});
  }
  private observe() {
    this.observer?.disconnect();
    this.resize?.disconnect();
    this.visible.clear();
    const tiles = [...this.host.nativeElement.querySelectorAll<HTMLElement>('.preview-image-tile')];
    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) { this.visible.add(entry.target); this.load(entry.target as HTMLElement); }
          else this.visible.delete(entry.target);
        }
      }, { rootMargin: '160px' });
      this.resize = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (this.visible.has(entry.target)) this.load(entry.target as HTMLElement);
        }
      });
      tiles.forEach(tile => { this.observer!.observe(tile); this.resize!.observe(tile); });
    });
  }
  private load(tile: HTMLElement) {
    const index = Number(tile.dataset['previewIndices']!.split(',')[0]);
    const image = this.images.find(image => image.index === index);
    // Not decrypted yet: the tile stays empty until its card redraws.
    if (!image || !tile.clientWidth || isPendingEncrypted(image.src)) return;
    const width = tile.clientWidth * Math.min(devicePixelRatio || 1, 2);
    const size = [160, 320, 480, 640, 960].find(size => size >= width) || 960;
    if ((this.requested.get(index) || 0) >= size) return;
    this.requested.set(index, size);
    const generation = this.generation;
    void this.auth.prepareImageUrl(image.src, size).then(source => this.localPreview(source, size)).then(source => {
      if (source && !this.destroyed && this.generation === generation && this.requested.get(index) === size) {
        this.zone.run(() => { this.sources[index] = source; this.cd.markForCheck(); });
      }
    }).catch(() => this.failed(image));
  }
  private localPreview(source: string, size: number): Promise<string | undefined> {
    if (!/^(blob:|data:)/.test(source)) return Promise.resolve(source);
    let sizes = this.localPreviews.get(source);
    if (!sizes) { sizes = new Map(); this.localPreviews.set(source, sizes); }
    const cached = sizes.get(size);
    if (cached) return cached;
    const generation = this.generation;
    const promise = (async () => {
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        if (this.destroyed || generation !== this.generation) return undefined;
        const scale = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
        if (scale === 1) return source;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.8));
        if (!blob || this.destroyed || generation !== this.generation) return undefined;
        const url = URL.createObjectURL(blob);
        this.objectUrls.add(url);
        return url;
      } catch { return source; }
    })();
    sizes.set(size, promise);
    return promise;
  }
  private clearLocalPreviews() {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.localPreviews.clear();
  }
  ngOnDestroy() { this.destroyed = true; this.clearLocalPreviews(); this.observer?.disconnect(); this.resize?.disconnect(); }
}
