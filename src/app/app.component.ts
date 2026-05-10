import { Component, OnInit } from '@angular/core';
import { PushNotificationService } from './services/push-notification.service';
import { SharedService } from './services/shared.service';

@Component({
    selector: 'app-root',
    template: '<router-outlet></router-outlet><app-reminder-notification></app-reminder-notification>',
    standalone: false
})
export class AppComponent implements OnInit {
  constructor(private push: PushNotificationService, private shared: SharedService) {}

  ngOnInit() {
    this.shared.initPwa();

    // Check for notification permissions each time the app opens if not already granted
    if (Notification.permission !== 'granted') {
      // On iOS, never ask for notifications outside the installed PWA — the
      // permission registers against the Safari tab origin (not the PWA),
      // which prevents iOS from listing the install in Settings → Notifications.
      if (this.push.isIos() && !this.push.isStandalone()) return;

      // Delay slightly to ensure Snackbar and other services are fully initialized
      setTimeout(() => {
        this.push.requestPermissionWithReason(
          "Kept needs your permission to send you important reminders and notifications. Would you like to enable them now?"
        ).catch(console.error);
      }, 2000);
    }
  }
}
