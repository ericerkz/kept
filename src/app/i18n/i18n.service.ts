import { Injectable, NgZone } from '@angular/core';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { TranslateLoader, TranslateService, TranslationObject } from '@ngx-translate/core';
import { Observable, of, firstValueFrom, combineLatest, distinctUntilChanged, map, timeout } from 'rxjs';
import { environment } from 'src/environments/environment';
import english from '../../assets/i18n/en.json';
import manifest from '../../assets/i18n/languages.json';
import { AuthService } from '../services/auth.service';
import { WorkspaceService } from '../services/workspace.service';
import { installMessageRenderer, setUiLocale, MessageParams } from './messages';

export interface UiLanguage {
  code: string;
  name: string;
  nativeName: string;
  direction: 'ltr' | 'rtl';
}
export const UI_LANGUAGES = manifest.languages as UiLanguage[];

export function resolveUiLanguage(preference: string, deviceLanguages: readonly string[]): UiLanguage {
  const requested = preference === 'system' ? deviceLanguages : [preference];
  for (const candidate of requested) {
    // Preserve script variants (for example zh-Hant) before falling back to
    // the base language when the device reports a more specific region.
    const parts = candidate.toLowerCase().split('-');
    while (parts.length) {
      const language = UI_LANGUAGES.find(item => item.code.toLowerCase() === parts.join('-'));
      if (language) return language;
      parts.pop();
    }
  }
  return UI_LANGUAGES.find(language => language.code === 'en')!;
}

@Injectable()
export class BundledTranslationLoader extends TranslateLoader {
  private http: HttpClient;
  constructor(backend: HttpBackend) { super(); this.http = new HttpClient(backend); }
  getTranslation(language: string): Observable<TranslationObject> {
    if (language === 'en' || !UI_LANGUAGES.some(item => item.code === language)) return of(english);
    // HttpBackend bypasses API authentication/header interceptors. Assets stay
    // on the bundled app origin, including in server-connected native apps.
    const url = new URL(`assets/i18n/${language}.json`, document.baseURI).href;
    // A stalled language download must not hold up app startup indefinitely.
    return this.http.get<TranslationObject>(url).pipe(timeout(5000), map(values => Object.fromEntries(
      Object.entries(values).filter(([, value]) => typeof value === 'string' && value.trim())
    )));
  }
}

@Injectable({ providedIn: 'root' })
export class I18nService {
  readonly languages = UI_LANGUAGES;
  preference = 'system';
  currentLanguage: UiLanguage = resolveUiLanguage('system', navigator.languages || [navigator.language]);
  saving = false;
  private request = 0;
  private readonly systemChanged = () => { if (this.preference === 'system') void this.applyLanguage(); };

  constructor(public translate: TranslateService, private auth: AuthService,
      private workspace: WorkspaceService, private zone: NgZone) {
    translate.setTranslation('en', english);
    installMessageRenderer((key, params) => this.text(key, params));
    combineLatest([auth.currentUser$, workspace.local$]).pipe(
      map(([user, local]) => {
        if (local) return local.preferences.language || 'system';
        if (!user) return 'system';
        if (!user.languagePreferencesSupported) {
          try { return localStorage.getItem(this.devicePreferenceKey()) || user.language || 'system'; } catch {}
        }
        return user.language || 'system';
      }),
      distinctUntilChanged()
    ).subscribe(preference => { this.preference = preference; void this.applyLanguage(); });
    window.addEventListener('languagechange', this.systemChanged);
    window.addEventListener('focus', this.systemChanged);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.systemChanged(); });
  }

  async initialize() {
    // AppComponent already displays storage failures. Localization must not
    // abort Angular startup and prevent that recovery message from appearing.
    await this.workspace.ready.catch(() => {});
    await this.applyLanguage();
  }

  async selectLanguage(preference: string) {
    if (this.saving || (preference !== 'system' && !this.languages.some(item => item.code === preference))) return;
    this.saving = true;
    const previous = this.preference;
    this.preference = preference;
    try {
      await this.applyLanguage();
      if (!this.auth.isLocal && !this.auth.currentUser?.languagePreferencesSupported) {
        // Older servers do not know this preference. Do not enqueue a mutation
        // they cannot retain or turn a language choice into a sync failure.
        localStorage.setItem(this.devicePreferenceKey(), preference);
      } else {
        await this.auth.updateAccountPreferences({ language: preference });
        try { localStorage.removeItem(this.devicePreferenceKey()); } catch {}
      }
    }
    catch (error) { this.preference = previous; await this.applyLanguage(); throw error; }
    finally { this.saving = false; }
  }

  text(key: string, params?: MessageParams): string {
    const result = this.translate.instant(key, params);
    return typeof result === 'string' ? result : key;
  }

  plural(key: string, count: number, params: MessageParams = {}): string {
    const category = new Intl.PluralRules(this.currentLanguage.code).select(count);
    const variant = `${key}.${category}`;
    const selected = this.translate.instant(variant) === variant ? `${key}.other` : variant;
    return this.text(selected, { ...params, count });
  }

  private devicePreferenceKey() {
    return `kept_interface_language:${encodeURIComponent(environment.apiUrl)}:${this.auth.currentUser?.id || 'anonymous'}`;
  }

  private async applyLanguage() {
    const request = ++this.request;
    const language = resolveUiLanguage(this.preference, navigator.languages || [navigator.language]);
    try { await firstValueFrom(this.translate.use(language.code)); }
    catch { if (request === this.request) await firstValueFrom(this.translate.use('en')); }
    if (request !== this.request) return;
    this.zone.run(() => {
      this.currentLanguage = UI_LANGUAGES.find(item => item.code === this.translate.getCurrentLang()) || UI_LANGUAGES[0];
      setUiLocale(this.preference === 'system' ? navigator.language : this.currentLanguage.code);
      document.documentElement.lang = this.currentLanguage.code;
      document.documentElement.dir = this.currentLanguage.direction;
      window.dispatchEvent(new CustomEvent('kept-language-changed', { detail: {
        preference: this.preference, language: this.currentLanguage.code, direction: this.currentLanguage.direction
      } }));
    });
  }
}
