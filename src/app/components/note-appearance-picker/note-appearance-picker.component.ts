import { Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { bgColors, bgImages, noteBackgroundChoices, noteColorFamilies } from '../../interfaces/tooltip';

import { noteAppearance, noteColourHex, notePatternImage, notePatterns } from '../../utils/note-appearance';

type AppearanceTab = 'colour' | 'background';

@Component({
  selector: 'app-note-appearance-picker',
  templateUrl: './note-appearance-picker.component.html',
  standalone: false
})
export class NoteAppearancePickerComponent implements OnDestroy {
  private static nextId = 0;
  readonly pickerId = `note-appearance-${++NoteAppearancePickerComponent.nextId}`;
  readonly colors = bgColors;
  readonly families = noteColorFamilies;
  readonly backgrounds = noteBackgroundChoices;
  activeTab: AppearanceTab = 'colour';
  @Input() colorOnly = false;
  @Input() noteColor = '';
  @Input() noteBackground = '';
  @Input() pattern: string | null | undefined = null;
  readonly patterns = notePatterns;
  get currentColor() { return noteAppearance(this.noteColor, document.body.classList.contains('light-theme')).background; }
  patternPreview(id: string) { return notePatternImage(id, this.noteColor, document.body.classList.contains('light-theme'), true); }
  isBackgroundSelected(value: string) {
    if (!value && this.pattern) return false;
    return value ? this.noteBackground.includes(value) : !this.noteBackground || ['none', 'url()', 'url("")'].includes(this.noteBackground);
  }
  isColorSelected(value: string) { return noteColourHex(value) === noteColourHex(this.noteColor); }
  @Output() patternSelected = new EventEmitter<string | null>();
  selectPattern(id: string) { this.patternSelected.emit(this.pattern === id ? null : id); }

  private layoutFrame?: number;

  @Output() colorSelected = new EventEmitter<bgColors>();
  @Output() backgroundSelected = new EventEmitter<bgImages>();
  @Output() layoutChanged = new EventEmitter<void>();

  selectTab(tab: AppearanceTab) {
    if (tab === this.activeTab) return;
    this.activeTab = tab;
    if (this.layoutFrame !== undefined) cancelAnimationFrame(this.layoutFrame);
    // The background panel is shorter. Reposition after Angular updates its height.
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      this.layoutChanged.emit();
    });
  }

  onTabKeydown(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const tab: AppearanceTab = event.key === 'Home' ? 'colour' : event.key === 'End' ? 'background'
      : this.activeTab === 'colour' ? 'background' : 'colour';
    this.selectTab(tab);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-appearance-tab="${tab}"]`)?.focus();
  }

  ngOnDestroy() {
    if (this.layoutFrame !== undefined) cancelAnimationFrame(this.layoutFrame);
  }
}
