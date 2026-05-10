import { Component, Input, OnInit } from '@angular/core';
import { NotesService, LinkPreviewData } from 'src/app/services/notes.service';
import { AuthService } from 'src/app/services/auth.service';
import { environment } from 'src/environments/environment';

@Component({
  selector: 'app-link-preview',
  templateUrl: './link-preview.component.html',
  styleUrls: ['./link-preview.component.scss'],
  standalone: false
})
export class LinkPreviewComponent implements OnInit {
  private _url!: string;
  @Input() set url(value: string) {
    if (this._url !== value) {
      this._url = value;
      this.fetchPreview();
    }
  }
  get url() { return this._url; }

  @Input() full = false;
  @Input() cardMode = false;
  @Input() clickToOpen = false;

  preview: LinkPreviewData | null = null;
  loading = true;
  failed = false;
  imageError = false;
  copied = false;

  constructor(private notesService: NotesService, private auth: AuthService) {}

  ngOnInit() {}

  linkDomain(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  proxyUrl(url: string | null | undefined) {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    const token = this.auth.token;
    const tokenPart = token ? `&token=${encodeURIComponent(token)}` : '';
    return `${environment.apiUrl}/proxy-image?url=${encodeURIComponent(url)}${tokenPart}`;
  }

  async fetchPreview() {
    const url = this._url;
    if (!url) return;

    this.loading = true;
    this.failed = false;
    this.imageError = false;
    try {
      this.preview = await this.notesService.getLinkPreview(url);
      if (this._url !== url) return; // Stale request
    } catch (err) {
      if (this._url !== url) return;
      this.failed = true;
    } finally {
      if (this._url === url) {
        this.loading = false;
      }
    }
  }

  open(event: MouseEvent) {
    event.stopPropagation();
    window.open(this.preview?.url || this.url, '_blank', 'noopener,noreferrer');
  }

  openCard(event: MouseEvent) {
    if (!this.clickToOpen) return;
    this.open(event);
  }

  async copy(event: MouseEvent) {
    event.stopPropagation();
    const value = this.preview?.url || this.url;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    this.copied = true;
    setTimeout(() => this.copied = false, 1200);
  }
}
