import { Component, EventEmitter, Input, Output } from '@angular/core';
import { NoteI } from 'src/app/interfaces/notes';

@Component({
  selector: 'app-merge-dialog',
  templateUrl: './merge-dialog.component.html',
  styleUrls: ['./merge-dialog.component.scss'],
  standalone: false
})
export class MergeDialogComponent {
  @Input() set notes(value: NoteI[]) {
    // Snapshot the order so the user's drag-reorder doesn't mutate the parent.
    this._ordered = Array.isArray(value) ? [...value] : [];
  }
  get notes() { return this._ordered; }

  @Output() confirm = new EventEmitter<number[]>();
  @Output() cancel = new EventEmitter<void>();

  private _ordered: NoteI[] = [];
  isMerging = false;

  noteIsDrawing(note: NoteI): boolean {
    return !!note.images?.some(img => img.id === 'drawing');
  }

  noteSummary(note: NoteI): string {
    const t = (note.noteTitle || '').replace(/<[^>]+>/g, '').trim();
    if (t) return t;
    const b = (note.noteBody || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (b) return b.slice(0, 80);
    if (note.checkBoxes?.length) return `${note.checkBoxes.length} checklist item${note.checkBoxes.length === 1 ? '' : 's'}`;
    if (this.noteIsDrawing(note)) return 'Drawing';
    if (note.images?.length) return `${note.images.length} image${note.images.length === 1 ? '' : 's'}`;
    return '(empty note)';
  }

  noteTypeLabel(note: NoteI): string {
    const parts: string[] = [];
    if (this.noteIsDrawing(note)) parts.push('Drawing');
    if (note.isCbox) parts.push('Checklist');
    if ((note.noteBody || '').replace(/<[^>]+>/g, '').trim()) parts.push('Text');
    if (note.images?.some(i => i.id !== 'drawing')) parts.push('Images');
    if (note.attachments?.length) parts.push('Files');
    if (!parts.length) parts.push('Note');
    return parts.join(' · ');
  }

  hasDrawings(): boolean {
    return this._ordered.some(n => this.noteIsDrawing(n));
  }

  drawingCount(): number {
    return this._ordered.filter(n => this.noteIsDrawing(n)).length;
  }

  moveUp(index: number) {
    if (index <= 0) return;
    const next = [...this._ordered];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    this._ordered = next;
  }

  moveDown(index: number) {
    if (index >= this._ordered.length - 1) return;
    const next = [...this._ordered];
    [next[index + 1], next[index]] = [next[index], next[index + 1]];
    this._ordered = next;
  }

  // Drag-to-reorder handlers
  private dragSrc: number | null = null;
  onDragStart(event: DragEvent, index: number) {
    this.dragSrc = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Required for Firefox to actually start the drag.
      event.dataTransfer.setData('text/plain', String(index));
    }
  }
  onDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }
  onDrop(event: DragEvent, dropIndex: number) {
    event.preventDefault();
    if (this.dragSrc === null || this.dragSrc === dropIndex) return;
    const next = [...this._ordered];
    const [moved] = next.splice(this.dragSrc, 1);
    next.splice(dropIndex, 0, moved);
    this._ordered = next;
    this.dragSrc = null;
  }
  onDragEnd() { this.dragSrc = null; }

  doConfirm() {
    if (this.isMerging) return;
    this.isMerging = true;
    this.confirm.emit(this._ordered.map(n => n.id!).filter(id => !!id));
  }

  doCancel() {
    this.cancel.emit();
  }
}
