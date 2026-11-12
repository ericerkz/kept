import { Pipe, PipeTransform } from '@angular/core';
import { uiLocale, uiText } from './messages';
import { I18nService } from './i18n.service';

// Only attach to application-authored labels/errors, never note/user content.
@Pipe({ name: 'uiText', standalone: false, pure: false })
export class UiTextPipe implements PipeTransform {
  transform(value: unknown): unknown { return typeof value === 'string' ? uiText(value) : value; }
}

@Pipe({ name: 'uiPlural', standalone: false, pure: false })
export class UiPluralPipe implements PipeTransform {
  constructor(private i18n: I18nService) {}
  transform(key: string, count: number, params: Record<string, string | number> = {}): string {
    return this.i18n.plural(key, count, params);
  }
}

@Pipe({ name: 'uiDate', standalone: false, pure: false })
export class UiDatePipe implements PipeTransform {
  transform(value: string | number | Date | null | undefined, style: 'short' | 'medium' | 'long' = 'medium'): string {
    if (value == null || value === '') return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(uiLocale(), { dateStyle: style, timeStyle: style }).format(date) : '';
  }
}
