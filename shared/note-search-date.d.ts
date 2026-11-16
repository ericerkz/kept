export interface DateSearchRange { start: Date; end: Date }
export interface DateSearchFilter { code: string; value: string; valid: boolean }
export interface DateSearch {
  text: string;
  filters: DateSearchFilter[];
  range: DateSearchRange | null;
  invalid: boolean;
}
export function parseDateSearch(query: string, now?: Date): DateSearch;
