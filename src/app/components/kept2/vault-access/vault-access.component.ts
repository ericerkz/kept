import { Component, OnInit } from '@angular/core';
import { NoteI } from 'src/app/interfaces/notes';
import { LocalFirstVaultService } from 'src/app/kept2/local-first-vault.service';
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
  notes: NoteI[] = [];
  outboxCount = 0;
  draftTitle = '';
  draftBody = '';
  selectedSyncId = '';

  constructor(
    private vaultSession: VaultSessionService,
    private localVault: LocalFirstVaultService
  ) {}

  async ngOnInit() {
    this.hasVault = await this.vaultSession.hasLocalVault();
    this.identity = this.vaultSession.currentSession()?.identity || null;
    this.mode = this.hasVault ? 'unlock' : 'create';
    if (this.identity) await this.refreshLocalState();
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
      await this.refreshLocalState();
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
      await this.refreshLocalState();
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
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not recover vault.';
    } finally {
      this.isBusy = false;
    }
  }

  lockVault() {
    this.vaultSession.lock();
    this.identity = null;
    this.notes = [];
    this.outboxCount = 0;
    this.clearDraft();
    this.success = 'Vault locked.';
  }

  async saveDraft() {
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      if (this.selectedSyncId) {
        await this.localVault.updateNote(this.selectedSyncId, {
          noteTitle: this.draftTitle,
          noteBody: this.draftBody
        });
        this.success = 'Local note updated.';
      } else {
        await this.localVault.createNote({
          noteTitle: this.draftTitle,
          noteBody: this.draftBody
        });
        this.success = 'Local note created.';
      }
      this.clearDraft();
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not save local note.';
    } finally {
      this.isBusy = false;
    }
  }

  editNote(note: NoteI) {
    this.selectedSyncId = note.syncId || '';
    this.draftTitle = note.noteTitle || '';
    this.draftBody = note.noteBody || '';
    this.error = '';
    this.success = '';
  }

  async deleteNote(note: NoteI) {
    if (!note.syncId) return;
    this.error = '';
    this.success = '';
    this.isBusy = true;
    try {
      await this.localVault.deleteNote(note.syncId);
      if (this.selectedSyncId === note.syncId) this.clearDraft();
      this.success = 'Local note deleted.';
      await this.refreshLocalState();
    } catch (error: any) {
      this.error = error instanceof Error ? error.message : 'Could not delete local note.';
    } finally {
      this.isBusy = false;
    }
  }

  clearDraft() {
    this.selectedSyncId = '';
    this.draftTitle = '';
    this.draftBody = '';
  }

  private async refreshLocalState() {
    this.notes = await this.localVault.notes();
    this.outboxCount = (await this.localVault.outbox()).length;
  }
}
