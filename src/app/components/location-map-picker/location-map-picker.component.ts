import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import type * as Leaflet from 'leaflet';

export interface LocationPin { latitude: number; longitude: number; radiusMeters: number; }

@Component({
  selector: 'app-location-map-picker',
  templateUrl: './location-map-picker.component.html',
  styleUrls: ['./location-map-picker.component.scss'],
  standalone: false
})
export class LocationMapPickerComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() center: { latitude: number; longitude: number } | null = null;
  @Input() initialRadius = 120;
  @Input() locating = false;
  @Input() locationError = '';
  @Output() locationPicked = new EventEmitter<LocationPin>();
  @Output() cancelled = new EventEmitter<void>();
  @Output() locate = new EventEmitter<void>();
  @ViewChild('mapHost') private mapHost!: ElementRef<HTMLDivElement>;

  loading = true;
  error = '';
  tileError = false;
  selected: LocationPin | null = null;
  radius = 120;
  readonly radii = [100, 120, 250, 500, 1000];
  private map?: Leaflet.Map;
  private circle?: Leaflet.Circle;
  private tiles?: Leaflet.TileLayer;
  private resizeObserver?: ResizeObserver;
  private destroyed = false;

  constructor(private zone: NgZone, private cd: ChangeDetectorRef) {}

  async ngAfterViewInit() {
    try {
      const L = await import('leaflet');
      if (this.destroyed) return;
      this.zone.runOutsideAngular(() => {
        const start = this.center;
        this.map = L.map(this.mapHost.nativeElement, { preferCanvas: true, scrollWheelZoom: false, tapHold: false })
          .setView(start ? [start.latitude, start.longitude] : [20, 0], start ? 16 : 2);
        this.map.attributionControl.setPrefix(false);
        this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, keepBuffer: 0, updateWhenIdle: true,
          referrerPolicy: 'strict-origin-when-cross-origin',
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
        });
        this.tiles.on('tileerror', () => this.zone.run(() => { this.tileError = true; this.cd.markForCheck(); }));
        this.tiles.on('tileload', () => this.zone.run(() => { this.tileError = false; this.cd.markForCheck(); }));
        this.tiles.addTo(this.map);
        this.circle = L.circle(this.map.getCenter(), { radius: this.radius, color: '#1a73e8', fillOpacity: .12, weight: 2, interactive: false }).addTo(this.map);
        this.map.on('move', () => this.circle?.setLatLng(this.map!.getCenter()));
        this.map.on('moveend', () => this.zone.run(() => this.updateSelection()));
        this.map.on('click', (event: Leaflet.LeafletMouseEvent) => this.map?.panTo(event.latlng));
        if (start) this.updateSelection();
        this.resizeObserver = new ResizeObserver(() => this.map?.invalidateSize({ pan: false }));
        this.resizeObserver.observe(this.mapHost.nativeElement);
      });
    } catch {
      this.error = 'The map could not open. Close it and try again.';
    } finally {
      if (!this.destroyed) { this.loading = false; this.cd.detectChanges(); }
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['initialRadius']) this.setRadius(this.initialRadius);
    if (changes['center'] && this.center && this.map) {
      this.map.setView([this.center.latitude, this.center.longitude], 16);
      this.updateSelection();
    }
  }

  setRadius(radius: number) {
    this.radius = Math.max(100, Math.min(10000, radius || 120));
    this.circle?.setRadius(this.radius);
    if (this.selected) this.selected = { ...this.selected, radiusMeters: this.radius };
  }

  private updateSelection() {
    if (!this.map) return;
    const point = this.map.getCenter().wrap();
    this.selected = { latitude: point.lat, longitude: point.lng, radiusMeters: this.radius };
    this.cd.markForCheck();
  }

  reloadTiles() { this.tileError = false; this.tiles?.redraw(); }

  confirm() { if (this.selected && !this.loading && !this.error) this.locationPicked.emit({ ...this.selected }); }

  ngOnDestroy() {
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.map?.remove();
  }
}
