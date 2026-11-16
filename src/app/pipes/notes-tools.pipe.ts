import { parseDateSearch } from '../../../shared/note-search-date';
import { createNoteHtmlContainer, sanitizeNoteHtml } from '../utils/note-html';
import { Pipe, PipeTransform } from '@angular/core';
import { NoteI } from '../interfaces/notes';
import { ReminderService } from '../services/reminder.service';
import { AuthService } from '../services/auth.service';
interface ParsedSearch {
  text: string
  dateRange: { start: Date; end: Date } | null
  operators: { hasImage: boolean; hasCheckbox: boolean; hasDrawing: boolean; hasAnyLabel: boolean; hasUrl: boolean; hasAttachment: boolean; labels: string[] }
  empty: boolean
  invalidDate: boolean
  textTokens: string[]
}

@Pipe({
    name: 'notesTools',
    standalone: false
})
export class NotesToolsPipe implements PipeTransform {

  constructor(private reminderService: ReminderService, private auth: AuthService) {}

  // Per-pipe-instance caches. Pipes are pure, so identical inputs return cached output.
  private lastQuery?: string
  private lastParsed?: ParsedSearch
  private lastParsedDay = ''
  private noteHaystackCache = new WeakMap<NoteI, { title: string; body: string; searchText: string; cbCount: number; labelKey: string; binder: string; attachmentKey: string; haystack: string }>()
  private static normalizeEl: HTMLDivElement | null = null

  transform(object: NoteI[], type: string, searchQuery = '', searchScope: 'all' | 'current' = 'all', hiddenSyncId?: string): NoteI[] {
    if (hiddenSyncId) object = object.filter(note => note.syncId !== hiddenSyncId)
    let notes: NoteI[]
    const isSearching = !!searchQuery.trim()
    const activeNotes = object.filter(x => x.trashed === false && x.archived === false)
    if (type === 'archived') {
      notes = object.filter(x => x.archived === true && x.trashed === false)
    }
    else if (type === 'trashed') {
      notes = object.filter(x => x.trashed === true)
    }
    else if (type === 'shared') {
      const myId = this.auth.currentUser?.id;
      notes = object.filter(x => 
        x.trashed === false && 
        x.archived === false &&
        ((x.ownerUserId && x.ownerUserId !== myId) || (x.collaborators && x.collaborators.length > 0))
      )
    }
    else if (type === 'reminders') {
      const reminders = this.reminderService.reminders$.value
      const reminderByNoteId = new Map<number, any>()
      for (const r of reminders) {
        if (r.status === 'pending' && r.noteId) reminderByNoteId.set(r.noteId, r)
      }
      notes = []
      for (const x of object) {
        if (x.id != null && reminderByNoteId.has(x.id) && !x.trashed && !x.archived) notes.push(x)
      }
      notes.sort((a, b) => {
        const ra = reminderByNoteId.get(a.id!)
        const rb = reminderByNoteId.get(b.id!)
        const da = ra ? new Date(ra.dueAtUtc).getTime() : Infinity
        const db = rb ? new Date(rb.dueAtUtc).getTime() : Infinity
        return da - db
      })
    }
    else if (type === 'attachments') {
      notes = object.filter(x => this.noteHasAttachment(x) && !x.trashed && !x.archived)
    }
    else if (type === 'home') {
      notes = isSearching && searchScope === 'all'
        ? activeNotes
        : activeNotes.filter(x => !(x.binder || '').trim())
    }
    else if (type.startsWith('shared-binder:')) {
      const id = Number(type.slice('shared-binder:'.length))
      notes = isSearching && searchScope === 'all' ? activeNotes : activeNotes.filter(note => note.sharedBinder?.id === id)
    }
    else if (type.startsWith('binder:')) {
      const binder = type.slice('binder:'.length)
      notes = isSearching && searchScope === 'all'
        ? activeNotes
        : activeNotes.filter(note => ((note.sharedBinder && note.sharedBinder.ownerUserId === this.auth.currentUser?.id && note.sharedBinder.name === binder) || ((note.binder || '') === binder && (!note.sharedBinder || this.auth.currentUser?.inheritSharedBinders === false))))
    }
    else {
      const labelName = type.slice('label:'.length)
      notes = object.filter(note => !note.trashed && note.labels.some(label => label.name === labelName && label.added))
    }

    return this.filterSearch(notes, searchQuery)
  }

  private filterSearch(notes: NoteI[], query: string) {
    const parsed = this.getParsedSearch(query)
    if (parsed.invalidDate) return []
    if (parsed.empty) return notes

    const result: NoteI[] = []
    for (const note of notes) {
      if (parsed.dateRange && !this.noteCreatedInRange(note, parsed.dateRange)) continue
      if (!this.matchesOperators(note, parsed.operators)) continue
      if (parsed.textTokens.length && !this.matchesText(note, parsed.textTokens)) continue
      result.push(note)
    }
    return result
  }

  private getParsedSearch(query: string): ParsedSearch {
    const day = new Date().toDateString()
    if (this.lastQuery === query && this.lastParsed && this.lastParsedDay === day) return this.lastParsed
    const parsed = this.parseSearch(query)
    this.lastQuery = query
    this.lastParsedDay = day
    this.lastParsed = parsed
    return parsed
  }

  private parseSearch(query: string): ParsedSearch {
    const dateSearch = parseDateSearch(query)
    let text = this.normalize(dateSearch.text)
    const dateRange = dateSearch.range
    const operators = this.extractOperators(text)
    text = this.removeOperators(text)
    const finalText = text.trim()
    const empty = !finalText && !dateRange && !this.hasOperators(operators)
    const textTokens = finalText ? finalText.split(/\s+/).filter(Boolean) : []
    return { text: finalText, dateRange, operators, empty, textTokens, invalidDate: dateSearch.invalid }
  }

  private extractOperators(query: string) {
    const tokens = query.trim().split(/\s+/).filter(Boolean)
    const labels: string[] = []
    let hasImage = false
    let hasCheckbox = false
    let hasDrawing = false
    let hasAnyLabel = false
    let hasUrl = false
    let hasAttachment = false
    for (const t of tokens) {
      if (/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/.test(t)) hasImage = true
      else if (/^!t(?:o(?:d(?:o)?)?)?$/.test(t)) hasCheckbox = true
      else if (/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/.test(t)) hasDrawing = true
      else if (/^!url?$/.test(t)) hasUrl = true
      else if (/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/.test(t)) hasAttachment = true
      else if (/^!label:[a-z0-9_-]+$/.test(t)) labels.push(t.replace(/^!label:/, ''))
      else if (/^!l(?:a(?:b(?:e(?:l(?::[a-z0-9_-]+)?)?)?)?)?$/.test(t)) hasAnyLabel = true
    }
    return { hasImage, hasCheckbox, hasDrawing, hasAnyLabel, hasUrl, hasAttachment, labels }
  }

  private removeOperators(query: string) {
    return query
      .split(/\s+/)
      .filter(t => t &&
        !/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/.test(t) &&
        !/^!l(?:a(?:b(?:e(?:l(?::[a-z0-9_-]+)?)?)?)?)?$/.test(t) &&
        !/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/.test(t) &&
        !/^!t(?:o(?:d(?:o)?)?)?$/.test(t) &&
        !/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/.test(t) &&
        !/^!url?$/.test(t)
      )
      .join(' ')
      .trim()
  }

  private hasOperators(operators: { hasImage: boolean; hasCheckbox: boolean; hasDrawing: boolean; hasAnyLabel: boolean; hasUrl: boolean; hasAttachment: boolean; labels: string[] }) {
    return operators.hasImage || operators.hasCheckbox || operators.hasDrawing || operators.hasAnyLabel || operators.hasUrl || operators.hasAttachment || !!operators.labels.length
  }

  private matchesOperators(note: NoteI, operators: { hasImage: boolean; hasCheckbox: boolean; hasDrawing: boolean; hasAnyLabel: boolean; hasUrl: boolean; hasAttachment: boolean; labels: string[] }) {
    if (operators.hasImage && !this.noteHasImage(note)) return false
    if (operators.hasCheckbox && !this.noteHasTodos(note)) return false
    if (operators.hasDrawing && !this.noteHasDrawing(note)) return false
    if (operators.hasAnyLabel && !this.noteHasAnyLabel(note)) return false
    if (operators.hasUrl && !this.noteHasUrl(note)) return false
    if (operators.hasAttachment && !this.noteHasAttachment(note)) return false
    if (operators.labels.length) {
      const noteLabels = (note.labels || [])
        .filter(label => label.added)
        .map(label => this.labelSlug(label.name))
      if (!operators.labels.every(label => noteLabels.includes(label))) return false
    }
    return true
  }

  private noteHasImage(note: NoteI) {
    const hasStandardImage = !!(note.images || []).some(image => image.id !== 'drawing');
    return !!(hasStandardImage || /<img\b/i.test(note.noteBody || '') || note.bgImage)
  }

  private noteHasTodos(note: NoteI) {
    return !!(note.isCbox || note.checkBoxes?.length)
  }

  private noteHasDrawing(note: NoteI) {
    return !!(note.images || []).some(image => image.id === 'drawing')
  }

  private noteHasAnyLabel(note: NoteI) {
    return !!(note.labels || []).some(label => label.added)
  }
  
  private noteHasUrl(note: NoteI) {
    const urlRegex = /https?:\/\/[^\s<]+/gi;
    return urlRegex.test(note.noteBody || '') || urlRegex.test(note.noteTitle || '');
  }

  private noteHasAttachment(note: NoteI) {
    return !!(note.hasAttachments || note.attachmentCount || (note.attachments || []).length)
  }

  private labelSlug(label: string) {
    // Keep the existing ASCII operator slugs generated by the navbar.
    return this.normalize(label).replace(/[^a-z0-9\s/:\-!]/g, ' ').trim().replace(/\s+/g, '-')
  }

  private noteCreatedInRange(note: NoteI, range: { start: Date; end: Date }) {
    const created = note.createdAt ? new Date(note.createdAt) : null
    if (!created || Number.isNaN(created.getTime())) return false
    return created >= range.start && created < range.end
  }

  private getNoteHaystack(note: NoteI): string {
    const title = note.noteTitle || ''
    const body = note.noteBody || ''
    const searchText = note.searchText || ''
    const cbCount = note.checkBoxes?.length || 0
    const binder = note.binder || ''
    // Build a cheap key for change-detection of the haystack-relevant fields.
    let labelKey = ''
    if (note.labels) {
      for (const l of note.labels) if (l.added) labelKey += l.name + '|'
    }
    let attachmentKey = ''
    if (note.attachments) {
      for (const attachment of note.attachments) attachmentKey += attachment.originalName + '|'
    }
    const cached = this.noteHaystackCache.get(note)
    if (cached && cached.title === title && cached.body === body && cached.searchText === searchText && cached.cbCount === cbCount && cached.labelKey === labelKey && cached.binder === binder && cached.attachmentKey === attachmentKey) {
      return cached.haystack
    }
    let raw = title + ' ' + body + ' ' + searchText
    if (note.checkBoxes) for (const cb of note.checkBoxes) raw += ' ' + (cb.data ?? '')
    if (note.labels) for (const l of note.labels) if (l.added) raw += ' ' + l.name
    if (binder) raw += ' ' + binder
    if (note.attachments) for (const attachment of note.attachments) raw += ' ' + attachment.originalName
    const haystack = this.normalize(raw)
    this.noteHaystackCache.set(note, { title, body, searchText, cbCount, labelKey, binder, attachmentKey, haystack })
    return haystack
  }

  private matchesText(note: NoteI, tokens: string[]) {
    const haystack = this.getNoteHaystack(note)
    for (const token of tokens) {
      if (!this.fuzzyIncludes(haystack, token)) return false
    }
    return true
  }

  private fuzzyIncludes(haystack: string, token: string) {
    if (!token) return true
    if (haystack.includes(token)) return true
    if (token.length < 3) return false

    const words = haystack.split(/\s+/).filter(Boolean)
    return words.some(word => this.closeEnough(word, token))
  }

  private closeEnough(word: string, token: string) {
    if (Math.abs(word.length - token.length) > 2) return false
    const limit = token.length > 7 ? 2 : (token.length > 4 ? 1 : 0)
    return this.levenshtein(word, token) <= limit
  }

  private isSubsequence(needle: string, word: string) {
    let index = 0
    for (const char of word) {
      if (char === needle[index]) index++
      if (index === needle.length) return true
    }
    return false
  }

  private levenshtein(a: string, b: string) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]
      row[0] = i
      for (let j = 1; j <= b.length; j++) {
        const temp = row[j]
        row[j] = a[i - 1] === b[j - 1]
          ? previous
          : Math.min(previous + 1, row[j] + 1, row[j - 1] + 1)
        previous = temp
      }
    }
    return row[b.length]
  }

  private normalize(value: any) {
    const raw = String(value ?? '')
    if (!raw) return ''
    let plain: string
    if (raw.indexOf('<') === -1 && raw.indexOf('&') === -1) {
      plain = raw
    } else {
      let div = NotesToolsPipe.normalizeEl
      if (!div) {
        div = createNoteHtmlContainer()
        NotesToolsPipe.normalizeEl = div
      }
      div.innerHTML = sanitizeNoteHtml(raw)
      plain = div.textContent || (div as any).innerText || ''
    }
    return plain
      .toLowerCase()
      .normalize('NFD')
      .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, '$1')
      .replace(/[^\p{L}\p{N}\p{M}\s/:\-!]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

}
