import type { NoteImageI } from '../interfaces/notes';

export type DrawingBackground = 'square' | 'dots' | 'rules' | 'none';

// The PNG contains only the ink. Its saved name carries the paper choice;
// merged drawings retain that choice after the editor marker is flattened.
export function drawingPreviewBackground(image: Pick<NoteImageI, 'id' | 'name'>): DrawingBackground | null {
  if (image.id !== 'drawing' && !image.id?.startsWith('drawing-flat-')) return null;
  const match = image.name?.match(/(?:^|\|)bg:(square|dots|rules|none)$/);
  return (match?.[1] as DrawingBackground | undefined) || 'none';
}

// Drawings are saved transparent (ink only). Older exports were flattened onto
// a white page; only those have no transparent pixel at all.
export function drawingHasTransparency(data: ArrayLike<number>): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
