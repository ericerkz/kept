import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';

@Component({
  selector: 'app-invite-accept',
  templateUrl: './invite-accept.component.html',
  styleUrls: ['../auth-shared.scss'],
  standalone: false
})
export class InviteAcceptComponent implements OnInit {
  token = '';
  isLoading = true;
  invalidInvite = false;
  invitedEmail = '';

  username = '';
  displayName = '';
  displayNameTouched = false;
  password = '';
  confirmPassword = '';
  error = '';
  isSubmitting = false;

  constructor(private route: ActivatedRoute, private router: Router, private auth: AuthService) {}

  onUsernameChange(value: string) {
    this.username = value;
    if (!this.displayNameTouched) this.displayName = value;
  }

  onDisplayNameInput() {
    this.displayNameTouched = true;
  }

  async ngOnInit() {
    this.token = this.route.snapshot.paramMap.get('token') || '';
    try {
      const invite = await this.auth.getInvite(this.token);
      this.invitedEmail = invite.email;
    } catch {
      this.invalidInvite = true;
    } finally {
      this.isLoading = false;
    }
  }

  async submit() {
    this.error = '';
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }
    this.isSubmitting = true;
    try {
      await this.auth.acceptInvite(this.token, {
        username: this.username,
        displayName: this.displayName,
        password: this.password
      });
      await this.router.navigateByUrl('/');
    } catch (e: any) {
      this.error = e?.error?.error || 'Could not accept this invitation.';
    } finally {
      this.isSubmitting = false;
    }
  }
}
