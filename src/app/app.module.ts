import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { AppComponent } from './app.component';
import { MainComponent } from './components/main/main.component';
import { NavComponent } from './components/sidenav/sidenav.component';
import { NavbarComponent } from './components/navbar/navbar.component';
import { NotesComponent } from './components/notes/notes.component';
import { InputComponent } from './components/input/input.component';
import { ph } from './pipes/ph.pipe';
import { AppRoutingModule } from './app-routing.module';
import { CboxSortPipe } from './pipes/cbox-sort.pipe';
import { CboxDonePipe } from './pipes/cbox-done.pipe';
import { NotesToolsPipe } from './pipes/notes-tools.pipe';
import { SetupComponent } from './components/auth/setup/setup.component';
import { LoginComponent } from './components/auth/login/login.component';
import { UserManagementComponent } from './components/auth/user-management/user-management.component';
import { RegisterComponent } from './components/auth/register/register.component';
import { SettingsComponent } from './components/settings/settings.component';
import { ReminderNotificationComponent } from './components/reminder/reminder-notification.component';
import { LinkPreviewComponent } from './components/link-preview/link-preview.component';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { MergeDialogComponent } from './components/merge-dialog/merge-dialog.component';

@NgModule({ declarations: [
        AppComponent,
        MainComponent,
        NavComponent,
        NavbarComponent,
        NotesComponent,
        InputComponent,
        ph,
        CboxSortPipe,
        CboxDonePipe,
        NotesToolsPipe,
        SetupComponent,
        LoginComponent,
        UserManagementComponent,
        RegisterComponent,
        SettingsComponent,
        ReminderNotificationComponent,
        LinkPreviewComponent,
        UpdateBannerComponent,
        MergeDialogComponent,
    ],
    bootstrap: [AppComponent], imports: [BrowserModule,
        FormsModule,
        AppRoutingModule], providers: [provideHttpClient(withInterceptorsFromDi())] })
export class AppModule { }
