import english from '../../assets/i18n/en.json';

export type MessageParams = Record<string, string | number | boolean | null | undefined>;
const source = english as Record<string, string>;
const keysByEnglish = new Map(Object.entries(source).map(([key, value]) => [value, key]));
let render: ((key: string, params?: MessageParams) => string) | undefined;
let locale: string | undefined;

export function installMessageRenderer(renderer: typeof render) { render = renderer; }
export function setUiLocale(value: string) { locale = value; }
export function uiLocale(): string | undefined { return locale; }
export function uiWeekdays(): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2024, 0, 7 + index, 12)));
}

// Explicit UI boundaries only: never run note content, filenames, or user names
// through this function. The English lookup also covers legacy server messages.
export function uiText(value: string, params?: MessageParams): string {
  const key = Object.hasOwn(source, value) ? value : keysByEnglish.get(value);
  if (!key) return value;
  if (render) return render(key, params);
  return source[key].replace(/{{\s*(\w+)\s*}}/g, (match, name) =>
    params?.[name] == null ? match : String(params[name]));
}

export function uiPlural(key: string, count: number, params: MessageParams = {}): string {
  const values = { ...params, count };
  const category = new Intl.PluralRules(locale).select(count);
  const variant = `${key}.${category}`;
  const text = render?.(variant, values);
  if (text && text !== variant) return text;
  return uiText(Object.hasOwn(source, variant) ? variant : `${key}.other`, values);
}

// Display labels only; AM/PM tokens keep the time picker's scheduling contract.
export function uiTimepickerLabels() {
  return { ok: uiText('timepicker.ok'), cancel: uiText('timepicker.cancel'),
    time: uiText('timepicker.time'), mobileTime: uiText('timepicker.mobile_time'),
    mobileHour: uiText('timepicker.hour'), mobileMinute: uiText('timepicker.minute'),
    clear: uiText('timepicker.clear') };
}
