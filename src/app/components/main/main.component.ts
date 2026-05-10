import { Component, OnInit } from '@angular/core';
import { SharedService } from 'src/app/services/shared.service';
@Component({
    selector: 'app-main',
    templateUrl: './main.component.html',
    styleUrls: ['./main.component.scss'],
    standalone: false
})

export class MainComponent implements OnInit {

  installHelpOpen = false;

  constructor(public Shared: SharedService) { }

  openMobileComposer() {
    this.Shared.openMobileComposer.next(true)
  }

  installPwa() {
    // If the browser fired beforeinstallprompt (Android Chrome / desktop
    // PWA-capable), invoke it directly; otherwise show iOS-style "Add to
    // Home Screen" walkthrough.
    if (this.Shared.deferredInstallPrompt) {
      const promptEvent = this.Shared.deferredInstallPrompt
      this.Shared.deferredInstallPrompt = undefined
      promptEvent.prompt()
      promptEvent.userChoice.finally(() => this.Shared.updateInstallVisibility())
      return
    }
    this.installHelpOpen = true
  }

  dismissInstallFab(event: Event) {
    event.stopPropagation()
    this.Shared.dismissInstallFab()
  }

  ngOnInit(): void { }

}
