import { Component, ElementRef, HostBinding, HostListener, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from 'src/app/services/auth.service';
import { SharedService } from 'src/app/services/shared.service';
import { bgColors, bgImages } from 'src/app/interfaces/tooltip';
import { LabelI } from 'src/app/interfaces/labels';
import { NoteI } from 'src/app/interfaces/notes';


@Component({
    selector: 'app-navbar',
    templateUrl: './navbar.component.html',
    styleUrls: ['./navbar.component.scss'],
    standalone: false
})
export class NavbarComponent implements OnInit {
  logoClickCount = 0;
  logoClickTimer?: any;
  eggDismissTimer?: any;
  showEasterEgg = false;
  eggIndex = 0;
  easterEggMessages = [
    "Kept: because, unlike your last relationship, these notes are actually worth holding onto 💅",
    "I added checkboxes so you can mark off all the tasks you won't do.",
    "Kept: Because why use the trillion-dollar company's version when you can run this on your own bare metal, bay-bee!",
    "Kept: Why use the original when you can use the version that was built entirely on caffeine and spite? 🔥",
    "I know, I know. I look familiar. I get that a lot."
  ];

  konamiCode = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a', 'Enter'];
  wasdCode = ['w', 'w', 's', 's', 'a', 'd', 'a', 'd', 'b', 'a', 'Enter'];
  konamiIndex = 0;
  wasdIndex = 0;

  constructor(public Shared: SharedService, public auth: AuthService, private router: Router, private cdr: ChangeDetectorRef) { }

  @ViewChild("form23zSaZ") form23zSaZ?: ElementRef<HTMLDivElement>
  @ViewChild("searchInput") searchInput?: ElementRef<HTMLInputElement>
  @HostBinding('class.scrolled') isScrolled = false
  isProfileOpen = false
  profileError = ''
  labelMenuError = ''
  avatarPreview = ''
  avatarPresetPreview = 'cat'
  newPassword = ''
  confirmNewPassword = ''
  currentPassword = ''
  passwordResetError = ''
  passwordResetSuccess = ''
  isResettingPassword = false
  showPasswordReset = false
  isFiltersOpen = false
  bgColors = bgColors
  bgImages = bgImages
  bgImageLabels: Record<string, string> = {
    groceries: 'Groceries',
    tasks: 'Errands',
    movies: 'Movies',
    cafes: 'Cafes',
    romantic: 'Love',
    gym: 'Gym',
    recipes: 'Recipes',
    travel: 'Travel',
    study: 'Study',
    ideas: 'Ideas',
    meetings: 'Meetings',
    budget: 'Budget',
    zNone: 'None'
  }
  private selectionMoreButton?: HTMLElement

  get selectedCount() {
    return this.Shared.selectedNoteIds.value.length
  }

  get canSetSelectedReminder() {
    return this.selectedCount === 1
  }

  closeSideBar() { this.Shared.closeSideBar.next(true) }

  view() {
    this.Shared.noteViewType.value === 'grid' ? this.Shared.noteViewType.next('list') : this.Shared.noteViewType.next('grid')
  }

  searchExpanded = false

  updateSearch(event: Event) {
    this.Shared.setSearchQuery((event.target as HTMLInputElement).value)
  }

  clearSearch() {
    this.Shared.setSearchQuery('')
  }

  onSearchFocus() {
    // Mobile-only expansion. The CSS gates this on a media query so
    // adding the class on desktop is a no-op.
    this.searchExpanded = true
  }

  onSearchBlur() {
    this.searchExpanded = false
  }

  onSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      this.searchInput?.nativeElement.blur()
    }
  }

  applyFilter(filter: string) {
    const current = this.Shared.searchQuery.trim()
    if (current.includes(filter)) return
    const next = current ? `${current} ${filter}` : filter
    this.Shared.setSearchQuery(next)
    if (this.searchInput) {
      this.searchInput.nativeElement.value = next
      this.searchInput.nativeElement.blur()
    }
  }

  get activeFilters() {
    const query = this.Shared.searchQuery
    const tokens = query.trim().split(/\s+/).filter(Boolean)
    const filters: { label: string, code: string }[] = []
    for (const t of tokens) {
      if (/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/.test(t)) filters.push({ label: 'Images', code: t })
      else if (/^!t(?:o(?:d(?:o)?)?)?$/.test(t)) filters.push({ label: 'Checkboxes', code: t })
      else if (/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/.test(t)) filters.push({ label: 'Drawings', code: t })
      else if (/^!url?$/.test(t)) filters.push({ label: 'Links', code: t })
      else if (/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/.test(t)) filters.push({ label: 'Attachments', code: t })
      else if (/^!label:[a-z0-9_-]+$/.test(t)) filters.push({ label: `Label: ${t.replace(/^!label:/, '')}`, code: t })
      else if (/^!l(?:a(?:b(?:e(?:l(?::[a-z0-9_-]+)?)?)?)?)?$/.test(t)) filters.push({ label: 'Any Label', code: t })
    }
    return filters
  }

  toggleFilters(event?: Event) {
    if (event) event.stopPropagation()
    this.searchExpanded = false
    this.searchInput?.nativeElement.blur()
    this.isFiltersOpen = !this.isFiltersOpen
  }

  removeFilter(code: string) {
    const escaped = this.escapeRegExp(code)
    const regex = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'g')
    const next = this.Shared.searchQuery.replace(regex, ' ').replace(/\s+/g, ' ').trim()
    this.Shared.setSearchQuery(next)
  }

  clearAllFilters() {
    const current = this.Shared.searchQuery
    const next = current.split(/\s+/).filter(t => !t.startsWith('!')).join(' ').trim()
    this.Shared.setSearchQuery(next)
    this.isFiltersOpen = false
  }

  toggleFilter(code: string) {
    if (this.isFilterActive(code)) {
      this.removeFilter(code)
    } else {
      this.applyFilter(code)
    }
  }

  isFilterActive(code: string) {
    const tokens = this.Shared.searchQuery.trim().split(/\s+/).filter(Boolean)
    // For labels, we need to handle the slug part specifically or just exact match
    if (code.startsWith('!label:')) {
      return tokens.some(t => t === code)
    }
    // For simple operators, we check if the token starts with it (to handle partials like !i for !image)
    // but better to match exactly the operator logic from the pipe.
    // For simplicity here, let's match exact tokens or the common forms.
    return tokens.includes(code)
  }

  private escapeRegExp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  openTooltip(button: HTMLElement, tooltipEl: HTMLDivElement) {
    this.Shared.createTooltip(button, tooltipEl)
  }

  openSelectionMore(button: HTMLElement, tooltipEl: HTMLDivElement) {
    this.selectionMoreButton = button
    if (tooltipEl.dataset['isTooltipOpen'] === 'true') {
      this.Shared.closeTooltip(tooltipEl)
      return
    }
    this.Shared.createTooltip(button, tooltipEl, 'bottom-end')
  }

  selectionColorMenu = {
    bgColor: (data: bgColors) => this.Shared.bulkUpdateSelected({ bgColor: data, bgImage: '' }),
    bgImage: (data: bgImages) => this.Shared.bulkUpdateSelected({ bgImage: data ? `url(${data})` : '' })
  }

  openSelectedReminder() {
    if (!this.canSetSelectedReminder) return
    this.Shared.openSelectedReminder.next()
  }

  selectionMoreMenu(tooltipEl: HTMLDivElement) {
    const actions = {
      trash: () => this.Shared.bulkTrashSelected(),
      clone: () => this.Shared.bulkCloneSelected(),
      openLabelMenu: (labelTooltipEl: HTMLDivElement) => {
        this.Shared.closeTooltip(tooltipEl)
        this.labelMenuError = ''
        this.Shared.createTooltip(this.selectionMoreButton!, labelTooltipEl)
      },
      openMerge: () => {
        this.Shared.closeTooltip(tooltipEl)
        this.openMergeDialog()
      }
    }
    return actions
  }

  // Merge dialog state. Snapshots the visible-grid order of currently
  // selected notes so the user can drag to reorder before confirming.
  isMergeDialogOpen = false
  mergeDialogNotes: NoteI[] = []
  mergeError = ''

  openMergeDialog() {
    const ids = this.Shared.selectedNoteIds.value
    if (ids.length < 2) return
    // Use the visible-grid order: pinned first (in `pinned`), then `unpinned`.
    const indexFor = (id: number) => {
      const pinIdx = this.Shared.note.pinned.findIndex(n => n.id === id)
      if (pinIdx >= 0) return pinIdx
      const unIdx = this.Shared.note.unpinned.findIndex(n => n.id === id)
      return unIdx >= 0 ? this.Shared.note.pinned.length + unIdx : Number.MAX_SAFE_INTEGER
    }
    const ordered = ids
      .map(id => this.Shared.note.all.find(n => n.id === id))
      .filter((n): n is NoteI => !!n)
      .sort((a, b) => indexFor(a.id!) - indexFor(b.id!))
    this.mergeDialogNotes = ordered
    this.mergeError = ''
    this.isMergeDialogOpen = true
  }

  closeMergeDialog() {
    this.isMergeDialogOpen = false
    this.mergeDialogNotes = []
    this.mergeError = ''
  }

  async confirmMerge(orderedIds: number[]) {
    try {
      await this.Shared.bulkMergeSelected(orderedIds)
      this.closeMergeDialog()
    } catch (e: any) {
      this.mergeError = e?.error?.error || 'Could not merge notes.'
      this.isMergeDialogOpen = false
    }
  }

  labelMenu(label: LabelI) {
    this.Shared.bulkApplyLabel(label)
  }

  async addLabelFromMenu(input: HTMLInputElement) {
    const name = input.value.trim()
    if (!name) return

    const existing = this.Shared.label.list.find(label => label.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      await this.Shared.bulkApplyLabel(existing)
      input.value = ''
      this.labelMenuError = ''
      return
    }

    try {
      const id = await this.Shared.label.db.add({ name })
      await this.Shared.bulkApplyLabel({ id, name, added: true })
      input.value = ''
      this.labelMenuError = ''
    } catch (error: any) {
      const matchingLabel = this.Shared.label.list.find(label => label.name.toLowerCase() === name.toLowerCase())
      if (matchingLabel) {
        await this.Shared.bulkApplyLabel(matchingLabel)
        input.value = ''
        this.labelMenuError = ''
        return
      }
      this.labelMenuError = error?.status === 409 ? 'Label already exists' : 'Could not create label'
    }
  }

  isSelectedLabel(label: LabelI) {
    const selected = this.Shared.note.all.filter(note => note.id && this.Shared.selectedNoteIds.value.includes(note.id))
    return !!selected.length && selected.every(note => note.labels.some(noteLabel => noteLabel.id === label.id && noteLabel.added))
  }

  labelSlug(label: string) {
    return label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s/:\-!]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+/g, '-')
  }

  toggleTheme() {
    const nextTheme = this.auth.currentUser?.theme === 'light' ? 'dark' : 'light'
    this.auth.updateTheme(nextTheme)
  }

  async logout() {
    await this.auth.logout()
    this.router.navigateByUrl('/login')
  }

  openProfile() {
    this.profileError = ''
    this.avatarPreview = this.auth.currentUser?.avatarDataUrl || ''
    this.avatarPresetPreview = this.auth.currentUser?.avatarPreset || 'cat'
    this.isProfileOpen = true
  }

  toggleProfile(event: Event) {
    event.stopPropagation()
    if (this.isProfileOpen) {
      this.closeProfile()
    } else {
      this.openProfile()
    }
  }

  @HostListener('document:click')
  onDocumentClick() {
    if (this.isProfileOpen) {
      this.closeProfile()
    }
    if (this.isFiltersOpen) {
      this.isFiltersOpen = false
    }
  }

  closeProfile() {
    this.isProfileOpen = false
  }

  uploadAvatar(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    this.profileError = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      this.profileError = 'Please choose an image file.'
      return
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 512;
        const MAX_HEIGHT = 512;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          const quality = mimeType === 'image/jpeg' ? 0.85 : undefined;
          this.avatarPreview = canvas.toDataURL(mimeType, quality);
        } else {
          this.avatarPreview = String(reader.result || '');
        }
        this.cdr.detectChanges();
      };
      img.src = String(e.target?.result || '');
    };
    reader.readAsDataURL(file);
  }

  clearAvatar() {
    this.avatarPreview = ''
    const presets = ['cat', 'fox', 'bunny', 'bear', 'panda', 'guinea-pig', 'capybara'];
    const otherPresets = presets.filter(p => p !== this.avatarPresetPreview);
    this.avatarPresetPreview = otherPresets[Math.floor(Math.random() * otherPresets.length)];
  }

  openAdvancedSettings() {
    this.closeProfile()
    this.router.navigateByUrl('/settings')
  }

  async saveProfile(displayName: string) {
    try {
      await this.auth.updateProfile(displayName, this.avatarPreview, this.avatarPresetPreview)
      this.closeProfile()
    } catch (error: any) {
      this.profileError = error?.error?.error || 'Could not save profile.'
    }
  }

  togglePasswordReset() {
    this.showPasswordReset = !this.showPasswordReset
    this.currentPassword = ''
    this.newPassword = ''
    this.confirmNewPassword = ''
    this.passwordResetError = ''
    this.passwordResetSuccess = ''
  }

  async resetMyPassword() {
    this.passwordResetError = ''
    this.passwordResetSuccess = ''
    if (this.newPassword.length < 8) {
      this.passwordResetError = 'New password must be at least 8 characters.'
      return
    }
    if (this.newPassword !== this.confirmNewPassword) {
      this.passwordResetError = 'Passwords do not match.'
      return
    }
    this.isResettingPassword = true
    try {
      await this.auth.resetOwnPassword(this.currentPassword, this.newPassword)
      this.passwordResetSuccess = 'Password updated successfully.'
      this.currentPassword = ''
      this.newPassword = ''
      this.confirmNewPassword = ''
    } catch (error: any) {
      this.passwordResetError = error?.error?.error || 'Could not reset password.'
    } finally {
      this.isResettingPassword = false
    }
  }

  onLogoClick(event: Event) {
    // Only on desktop
    if (window.innerWidth < 600) return;

    this.logoClickCount++;
    if (this.logoClickTimer) clearTimeout(this.logoClickTimer);

    if (this.logoClickCount >= 5) {
      this.logoClickCount = 0;
      this.triggerEasterEgg();
    } else {
      this.logoClickTimer = setTimeout(() => {
        this.logoClickCount = 0;
      }, 1000);
    }
  }

  triggerEasterEgg() {
    if (this.showEasterEgg) {
      // If already showing, skip to next and reset timer
      if (this.eggDismissTimer) clearTimeout(this.eggDismissTimer);
      this.eggIndex = (this.eggIndex + 1) % this.easterEggMessages.length;
    } else {
      this.showEasterEgg = true;
    }

    this.eggDismissTimer = setTimeout(() => {
      this.showEasterEgg = false;
      this.eggIndex = (this.eggIndex + 1) % this.easterEggMessages.length;
      this.cdr.detectChanges();
    }, 10000);
    this.cdr.detectChanges();
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent) {
    if (window.innerWidth < 600) return;

    // Check Konami Code
    if (event.key === this.konamiCode[this.konamiIndex]) {
      this.konamiIndex++;
      if (this.konamiIndex === this.konamiCode.length) {
        this.triggerEasterEgg();
        this.konamiIndex = 0;
      }
    } else {
      this.konamiIndex = 0;
      // Re-check first key in case they started the sequence again
      if (event.key === this.konamiCode[0]) this.konamiIndex = 1;
    }

    // Check WASD variant
    if (event.key === this.wasdCode[this.wasdIndex]) {
      this.wasdIndex++;
      if (this.wasdIndex === this.wasdCode.length) {
        this.triggerEasterEgg();
        this.wasdIndex = 0;
      }
    } else {
      this.wasdIndex = 0;
      if (event.key === this.wasdCode[0]) this.wasdIndex = 1;
    }
  }

  ngOnInit(): void {
  }

  @HostListener('window:scroll')
  onWindowScroll() {
    this.isScrolled = window.scrollY > 0
    if (this.isFiltersOpen) this.isFiltersOpen = false
  }

}
