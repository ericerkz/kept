import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { AuthService } from './auth.service';

export interface UserPreferences {
  useTwentyFourHourTime: boolean;
  moveCompletedChecklistItemsToBottom: boolean;
  richLinkPreviews: boolean;
  notePreviewTextSize: 'compact' | 'default' | 'large';
  showPastReminders: boolean;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  useTwentyFourHourTime: false,
  moveCompletedChecklistItemsToBottom: true,
  richLinkPreviews: true,
  notePreviewTextSize: 'default',
  showPastReminders: false,
};

@Injectable({ providedIn: 'root' })
export class UserPreferencesService {
  private readonly storageKey = 'kept_user_preferences';
  readonly preferences$ = new BehaviorSubject<UserPreferences>(this.load());
  private loadedServerPreferenceToken = '';

  constructor(private auth: AuthService) {
    this.auth.currentUser$.subscribe(user => {
      if (!user) {
        this.loadedServerPreferenceToken = '';
        this.apply({ showPastReminders: false });
        return;
      }
      this.apply({ showPastReminders: user.showPastReminders === true });
      if (user.token === this.loadedServerPreferenceToken) return;
      this.loadedServerPreferenceToken = user.token;
      this.auth.loadAccountPreferences().catch(() => {});
    });
  }

  get value() {
    return this.preferences$.value;
  }

  update(patch: Partial<UserPreferences>) {
    this.apply(patch);
  }

  async updateShowPastReminders(enabled: boolean) {
    const previous = this.value.showPastReminders;
    this.apply({ showPastReminders: enabled });
    try {
      await this.auth.updateAccountPreferences({ showPastReminders: enabled });
    } catch (error) {
      this.apply({ showPastReminders: previous });
      throw error;
    }
  }

  private load(): UserPreferences {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return { ...DEFAULT_PREFERENCES };
      const parsed = JSON.parse(raw) as Partial<UserPreferences>;
      return {
        useTwentyFourHourTime: parsed.useTwentyFourHourTime === true,
        moveCompletedChecklistItemsToBottom: parsed.moveCompletedChecklistItemsToBottom !== false,
        richLinkPreviews: parsed.richLinkPreviews !== false,
        notePreviewTextSize: this.normalizeNotePreviewTextSize(parsed.notePreviewTextSize),
        showPastReminders: parsed.showPastReminders === true,
      };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  private normalizeNotePreviewTextSize(value: unknown): UserPreferences['notePreviewTextSize'] {
    return value === 'compact' || value === 'large' ? value : 'default';
  }

  private apply(patch: Partial<UserPreferences>) {
    const next = { ...this.value, ...patch };
    this.preferences$.next(next);
    this.save(next);
  }

  private save(value: UserPreferences) {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(value));
    } catch {}
  }
}
