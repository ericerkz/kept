import { Injectable, NgZone } from '@angular/core';

// Owns only the current in-app drag. External files/text never start a session.
@Injectable({ providedIn: 'root' })
export class BinderDropService {
  constructor(private zone: NgZone) {}
  private sidebar?: HTMLElement;
  private target?: HTMLElement;
  private frame = 0;
  private x = -1;
  private y = -1;
  private width = 0;
  private height = 0;
  private sidebarWidth = 0;
  private lastFrame = 0;
  private onDrop?: (name: string) => void;
  private onCancel?: () => void;

  begin(onDrop: (name: string) => void, onCancel: () => void) {
    this.end();
    const sidebar = document.querySelector<HTMLElement>('[sideBar]:not(.close)');
    if (!sidebar || !this.isVisible(sidebar)) return;
    this.sidebar = sidebar;
    this.sidebarWidth = sidebar.getBoundingClientRect().width;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.onDrop = onDrop;
    this.onCancel = onCancel;
    sidebar.classList.add('binder-drop-active');
    // Hover/edge scrolling only change DOM styles, not the notes model.
    this.zone.runOutsideAngular(() => {
      document.addEventListener('dragover', this.dragOver, true);
      document.addEventListener('drop', this.drop, true);
      document.addEventListener('keydown', this.keyDown, true);
      document.addEventListener('visibilitychange', this.visibilityChanged);
      window.addEventListener('resize', this.cancel);
      window.addEventListener('blur', this.cancel);
      this.frame = requestAnimationFrame(this.tick);
    });
  }

  // Returning true prevents the note-grid reorder path from handling this area.
  update(x: number, y: number) {
    this.x = x;
    this.y = y;
    if (!this.sidebar) return false;
    if (!this.layoutUnchanged()) { this.cancel(); return false; }
    const rect = this.sidebar.getBoundingClientRect();
    const inside = x >= rect.left && x < rect.right && y >= Math.max(0, rect.top) && y < Math.min(window.innerHeight, rect.bottom);
    const hit = inside ? document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-binder-drop]') : null;
    const next = hit && this.sidebar.contains(hit) ? hit : undefined;
    if (this.target !== next) {
      this.target?.classList.remove('binder-drop-target');
      this.target = next;
      this.target?.classList.add('binder-drop-target');
    }
    return inside;
  }

  dropAt(x: number, y: number) {
    const inside = this.update(x, y);
    const name = this.target?.getAttribute('data-binder-drop');
    const commit = this.onDrop;
    if (inside && name == null) { this.cancel(); return false; }
    this.end();
    if (name == null || !commit) return false;
    this.zone.run(() => commit(name));
    return true;
  }

  end() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lastFrame = 0;
    this.x = this.y = -1;
    this.target?.classList.remove('binder-drop-target');
    this.sidebar?.classList.remove('binder-drop-active');
    this.target = this.sidebar = undefined;
    this.onDrop = this.onCancel = undefined;
    document.removeEventListener('dragover', this.dragOver, true);
    document.removeEventListener('drop', this.drop, true);
    document.removeEventListener('keydown', this.keyDown, true);
    document.removeEventListener('visibilitychange', this.visibilityChanged);
    window.removeEventListener('resize', this.cancel);
    window.removeEventListener('blur', this.cancel);
  }

  private isVisible(sidebar: HTMLElement) {
    const rect = sidebar.getBoundingClientRect();
    return sidebar.isConnected && !sidebar.classList.contains('close') && rect.width > 160 && rect.height > 0 &&
      rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight &&
      getComputedStyle(sidebar).visibility !== 'hidden';
  }

  private layoutUnchanged() {
    return !!this.sidebar && this.isVisible(this.sidebar) && window.innerWidth === this.width &&
      window.innerHeight === this.height && Math.abs(this.sidebar.getBoundingClientRect().width - this.sidebarWidth) < 1;
  }

  private cancel = () => {
    const notify = this.onCancel;
    this.end();
    if (notify) this.zone.run(notify);
  };
  private keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); this.cancel(); } };
  private visibilityChanged = () => { if (document.hidden) this.cancel(); };
  private dragOver = (event: DragEvent) => {
    if (this.update(event.clientX, event.clientY)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = this.target ? 'move' : 'none';
    }
  };
  private drop = (event: DragEvent) => {
    if (!this.update(event.clientX, event.clientY)) return;
    event.preventDefault();
    event.stopPropagation();
    this.dropAt(event.clientX, event.clientY);
  };
  private tick = (time: number) => {
    if (!this.layoutUnchanged()) { this.cancel(); return; }
    const sidebar = this.sidebar!;
    const rect = sidebar.getBoundingClientRect();
    const elapsed = this.lastFrame ? Math.min(32, time - this.lastFrame) : 16;
    this.lastFrame = time;
    if (this.x >= rect.left && this.x < rect.right) {
      const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
      const edge = Math.min(56, (bottom - top) / 4);
      const speed = this.y >= top && this.y < top + edge ? -(1 - (this.y - top) / edge)
        : this.y <= bottom && this.y > bottom - edge ? 1 - (bottom - this.y) / edge : 0;
      sidebar.scrollTop += speed * elapsed * 0.6;
    }
    this.update(this.x, this.y);
    if (this.sidebar) this.frame = requestAnimationFrame(this.tick);
  };
}
