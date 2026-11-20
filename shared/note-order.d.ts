export interface OrderedNotePosition { id: number; syncId: string; sortOrder?: number; pinned?: boolean | number }
export function notePositionsForOrder(rows: OrderedNotePosition[], base?: number, movedSyncId?: string): Array<{id:number;syncId:string;sortOrder:number}>;
export function positionBetweenNotes(note: OrderedNotePosition, previous?: OrderedNotePosition, next?: OrderedNotePosition, base?: number): {id:number;syncId:string;sortOrder:number} | null;
