import { Component, OnInit } from '@angular/core';
import { VaultSessionService } from 'src/app/kept2/vault-session.service';
import { VaultIdentity } from 'src/app/kept2/vault-types';

type VaultMode = 'create' | 'unlock' | 'recover';

@Component({
  selector: 'app-kept2-vault-access',
  templateUrl: './vault-access.component.html',
  styleUrls: ['../../auth/auth-shared.scss', './vault-access.component.scss'],
  standalone: false
})
export class VaultAccessComponent implements OnInit {
  mode: VaultMode = 'unlock';
  password = '';
  confirmPassword = '';
  recoveryCode = '';
  recoveryPassword = '';
  error = '';
  success = '';
  generatedRecoveryCode = '';
  isBusy = false;
  hasVault = false;
  identity: VaultIdentity | null = null;

  constructor(private vaultSession: VaultSessionService) {}

  async ngOnInit() {
    this.hasVault = await this.vaultSession.hasLocalVault();
    this.identity = this.vaultSession.currentSession()?.identity || null;
    this.mode = this.hasVault ? 'unlock' : 'create';
  }

  setMode(mode: VaultMode) {
    this.mode = mode;
    this.error = '';
    this.success = '';
  }

  async createVault() {
    this.error = '';
    this.success = '';
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match.';
      return;
    }
    this.isBusy = true;
    try {
      const result = await this.vaultSession.createLocalVault(this.password);
      this.identity = result.identity;
      this.generatedRecoveryCode = result.recoveryCode;
      this.hasVault = true;
      this.password = '';
      this.confirmPassword = '';
      this.success = 'Vault created and unlocked.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not create vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async unlockVault() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      const session = await this.vaultSession.unlockWithPassword(this.password);
      this.identity = session.identity;
      this.password = '';
      this.success = 'Vault unlocked.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not unlock vault.';
    } finally {
      this.isBusy = false;
    }
  }

  async recoverVault() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      const session = await this.vaultSession.recoverWithCode(this.recoveryCode, this.recoveryPassword || undefined);
      this.identity = session?.identity || null;
      this.recoveryCode = '';
      this.recoveryPassword = '';
      this.success = 'Vault recovered and unlocked.';
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not recover vault.';
    } finally {
      this.isBusy = false;
    }
  }

  lockVault() {
    this.vaultSession.lock();
    this.identity = null;
    this.success = 'Vault locked.';
  }
}
