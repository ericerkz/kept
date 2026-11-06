import type { NoteImageI } from '../interfaces/notes';

export type DrawingBackground = 'square' | 'dots' | 'rules' | 'none';

// The PNG contains only the ink. Its saved name carries the paper choice;
// merged drawings retain that choice after the editor marker is flattened.
export function drawingPreviewBackground(image: Pick<NoteImageI, 'id' | 'name'>): DrawingBackground | null {
  if (image.id !== 'drawing' && !image.id?.startsWith('drawing-flat-')) return null;
  const match = image.name?.match(/(?:^|\|)bg:(square|dots|rules|none)$/);
  return (match?.[1] as DrawingBackground | undefined) || 'none';
}
