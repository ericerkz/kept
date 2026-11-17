import palette from '../../../shared/note-palette.json';

// The UI and MCP catalogue use the same choices. Keep saved colour values and
// background paths stable when adding entries.
export const bgColors = palette.colors;
export type bgColors = typeof bgColors[keyof typeof bgColors];
export const bgImages = palette.backgrounds;
export type bgImages = typeof bgImages[keyof typeof bgImages];

export const noteColorFamilies = palette.families as ReadonlyArray<{
    key: string; label: string; colors: ReadonlyArray<keyof typeof bgColors>;
}>;
export const noteBackgroundChoices = palette.backgroundChoices.map(choice => ({
    ...choice,
    key: choice.key as keyof typeof bgImages,
    value: bgImages[choice.key as keyof typeof bgImages]
}));
