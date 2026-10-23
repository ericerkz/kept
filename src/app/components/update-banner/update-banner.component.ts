import { Component, OnInit } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { AuthService } from 'src/app/services/auth.service';
import { ManagedHostingService } from 'src/app/services/managed-hosting.service';
import { environment } from 'src/environments/environment';

interface UpdateStatus {
  current: string;
  latest: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  isOutdated: boolean;
  suppressed: boolean;
  dismissedForever: boolean;
  dismissedUntil: string | null;
  checkedAt: string | null;
  checkError: string | null;
}

@Component({
  selector: 'app-update-banner',
  templateUrl: './update-banner.component.html',
  styleUrls: ['./update-banner.component.scss'],
  standalone: false
})
export class UpdateBannerComponent implements OnInit {
  status: UpdateStatus | null = null;
  showNotes = false;

  constructor(private http: HttpClient, public auth: AuthService, private managedHosting: ManagedHostingService) {}

  async ngOnInit() {
    if (!this.auth.isAdmin) return;
    // A managed-hosting provider owns the update lifecycle; nagging the
    // customer to update themselves would contradict that.
    const { managed } = await this.managedHosting.info();
    if (managed) return;
    await this.refresh();
  }

  async refresh() {
    try {
      this.status = await firstValueFrom(
        this.http.get<UpdateStatus>(`${environment.apiUrl}/admin/update-status`, { headers: this.auth.authHeaders() })
      );
    } catch {
      this.status = null;
    }
  }

  get visible(): boolean {
    return !!this.status?.isOutdated && !this.status.suppressed;
  }

  toggleNotes(event: Event) {
    event.preventDefault();
    this.showNotes = !this.showNotes;
  }

  async dismiss(forever: boolean) {
    if (!this.status?.latest) return;
    try {
      await firstValueFrom(
        this.http.post(
          `${environment.apiUrl}/admin/update-status/dismiss`,
          { version: this.status.latest, forever },
          { headers: this.auth.authHeaders() }
        )
      );
      await this.refresh();
      this.showNotes = false;
    } catch {
      // best effort; banner stays
    }
  }
}
