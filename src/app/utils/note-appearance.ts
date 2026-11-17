import tokens from '../../../shared/note-appearance.json';
import { bgColors, noteColorFamilies } from '../interfaces/tooltip';

const patternLabels: Record<string, string> = {
  todos: 'patterns.todos',
  travel: 'patterns.travel',
  cafes: 'patterns.cafes',
  restaurants: 'patterns.restaurants',
  groceries: 'patterns.groceries',
  recipes: 'patterns.recipes',
  gym: 'patterns.gym',
  ideas: 'patterns.ideas',
  study: 'patterns.study',
  music: 'patterns.music',
  movies: 'patterns.movies',
  garden: 'patterns.garden',
  pets: 'patterns.pets',
  reading: 'patterns.reading',
  party: 'patterns.party',
  budget: 'patterns.budget',
  night: 'patterns.night',
  home: 'patterns.home',
  lemons: 'patterns.lemons',
  oranges: 'patterns.oranges',
  cherries: 'patterns.cherries',
  hearts: 'patterns.hearts',
  candy: 'patterns.candy',
  pizza: 'patterns.pizza',
  flowers: 'patterns.flowers',
  leaves: 'patterns.leaves',
  roses: 'patterns.roses',
};
export const notePatterns = tokens.patterns.map(pattern => ({ id: pattern.id, label: patternLabels[pattern.id] }));
const patternById = new Map(tokens.patterns.map(pattern => [pattern.id, pattern]));
const colourByHex = new Map(tokens.noteColours.map(colour => [colour.hex, colour]));
const legacyFamily = new Map(noteColorFamilies.flatMap(family => family.colors.filter(key => bgColors[key])
  .map(key => [bgColors[key].toLowerCase(), family.key] as const)));
const svgCache = new Map<string, string>();
const appearanceCache = new Map<string, ReturnType<typeof calculateAppearance>>();

export function validNotePattern(value: unknown): string | null {
  return typeof value === 'string' && patternById.has(value) ? value : null;
}

export function noteColourHex(value: string | undefined | null): string | null {
  const raw = String(value || '').trim().toLowerCase();
  if (/^#[a-f0-9]{6}$/.test(raw)) return raw;
  if (/^#[a-f0-9]{3}$/.test(raw)) return '#' + [...raw.slice(1)].map(x => x + x).join('');
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return null;
  return '#' + rgb.slice(1, 4).map(x => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('');
}
const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const dark = (hex: string) => { const [r, g, b] = rgb(hex); return .299 * r + .587 * g + .114 * b < 128; };
const mix = (hex: string, white: boolean, amount: number) => '#' + rgb(hex)
  .map(channel => Math.round(channel + ((white ? 255 : 0) - channel) * amount).toString(16).padStart(2, '0')).join('');

export function noteAppearance(colour?: string | null, lightTheme = true, illustration = false) {
  const key = `${colour || ''}:${lightTheme}:${illustration}`;
  let appearance = appearanceCache.get(key);
  if (!appearance) {
    appearance = calculateAppearance(colour, lightTheme, illustration);
    if (appearanceCache.size > 256) appearanceCache.clear();
    appearanceCache.set(key, appearance);
  }
  return appearance;
}

function calculateAppearance(colour?: string | null, lightTheme = true, illustration = false) {
  const hex = noteColourHex(colour);
  const background = hex || (lightTheme ? tokens.noColour.lightTheme.background : tokens.noColour.darkTheme.background);
  const exact = hex ? colourByHex.get(hex) : undefined;
  const nearest = exact || (hex ? tokens.noteColours.reduce((best, next) => {
    const distance = (value: string) => rgb(value).reduce((sum, channel, index) => sum + (channel - rgb(hex)[index]) ** 2, 0);
    return distance(next.hex) < distance(best.hex) ? next : best;
  }) : undefined);
  const family = (legacyFamily.get(hex || '') || nearest?.family.toLowerCase() || 'neutral') as Lowercase<keyof typeof tokens.highlightByFamily>;
  const familyName = (family[0].toUpperCase() + family.slice(1)) as keyof typeof tokens.highlightByFamily;
  const isDark = illustration ? false : dark(background);
  return {
    background,
    text: isDark ? '#e8eaed' : '#202124',
    highlight: tokens.highlightByFamily[familyName][isDark ? 'dark' : 'light'],
    patternInk: exact?.patternInk || mix(background, dark(background), dark(background) ? .16 : .11),
    pickerInk: exact?.pickerInk || mix(background, dark(background), dark(background) ? .4 : .3)
  };
}

export function notePatternImage(pattern: unknown, colour?: string | null, lightTheme = true, motif = false): string {
  const id = validNotePattern(pattern);
  if (!id) return '';
  const appearance = noteAppearance(colour, lightTheme);
  const ink = motif ? appearance.pickerInk : appearance.patternInk;
  const key = `${id}:${ink}:${motif}`;
  let image = svgCache.get(key);
  if (!image) {
    const source = patternById.get(id)![motif ? 'motif' : 'tile'].replaceAll('currentColor', ink);
    // Only bundled, reviewed SVGs are rendered. Never interpolate uploaded SVGs.
    image = `url('data:image/svg+xml,${encodeURIComponent(source).replaceAll("'", '%27')}')`;
    if (svgCache.size > 2048) svgCache.clear();
    svgCache.set(key, image);
  }
  return image;
}
