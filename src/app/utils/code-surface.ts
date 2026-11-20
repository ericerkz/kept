import { noteColourHex } from './note-appearance';

const channels = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const hex = (rgb: number[]) => '#' + rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
const luminance = (color: string) => channels(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
export const codeContrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const lightTokens = { keyword: '#8f3a62', string: '#2e6b30', number: '#8f4a00', comment: '#5f6368', title: '#1a5fb4', type: '#00695c', plain: '#202124' };
const darkTokens = { keyword: '#f49ac2', string: '#a5d6a7', number: '#ffb870', comment: '#a8adb3', title: '#8ab4f8', type: '#80cbc4', plain: '#e8eaed' };

export function codeSurface(color: string, lightTheme: boolean) {
  const note = noteColourHex(color) || (lightTheme ? '#ffffff' : '#202124');
  const [r, g, b] = channels(note);
  const dark = .299 * r + .587 * g + .114 * b < 128;
  const background = hex(channels(note).map(value => dark ? value * .55 : value + (255 - value) * .35));
  const tokens = Object.fromEntries(Object.entries(dark ? darkTokens : lightTokens).map(([name, value]) => {
    // Custom/legacy colours get the same guarantee as the bundled palette.
    for (let step = 0; step < 20 && codeContrast(value, background) < 4.5; step++) value = hex(channels(value).map(channel => channel + ((dark ? 255 : 0) - channel) * .12));
    return [name, value];
  }));
  return { background, dark, tokens };
}
