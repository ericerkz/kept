import { Pipe, PipeTransform } from '@angular/core';
import { NoteI } from '../interfaces/notes';
import { ReminderService } from '../services/reminder.service';
import { AuthService } from '../services/auth.service';
interface ParsedSearch {
  text: string
  dateRange: { start: Date; end: Date } | null
  operators: { hasImage: boolean; hasCheckbox: boolean; hasDrawing: boolean; hasAnyLabel: boolean; hasUrl: boolean; hasAttachment: boolean; labels: string[] }
  empty: boolean
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
  private noteHaystackCache = new WeakMap<NoteI, { title: string; body: string; cbCount: number; labelKey: string; attachmentKey: string; haystack: string }>()
  private static normalizeEl: HTMLDivElement | null = null

  transform(object: NoteI[], type: string, searchQuery = ''): NoteI[] {
    let notes: NoteI[]
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
      notes = object.filter(x => !!(x.attachments || []).length && !x.trashed && !x.archived)
    }
    else if (type === 'home') {
      notes = object.filter(x => x.trashed === false && x.archived === false)
    }
    else {
      notes = object.filter(note => note.labels.some(label => label.name === type && label.added))
    }

    return this.filterSearch(notes, searchQuery)
  }

  private filterSearch(notes: NoteI[], query: string) {
    const parsed = this.getParsedSearch(query)
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
    if (this.lastQuery === query && this.lastParsed) return this.lastParsed
    const parsed = this.parseSearch(query)
    this.lastQuery = query
    this.lastParsed = parsed
    return parsed
  }

  private parseSearch(query: string): ParsedSearch {
    let text = this.normalize(query)
    const dateRange = this.dateRangeFromQuery(text)
    const operators = this.extractOperators(text)
    if (dateRange) {
      text = this.removeDateLanguage(text)
    }
    text = this.removeOperators(text)
    const finalText = text.trim()
    const empty = !finalText && !dateRange && !this.hasOperators(operators)
    const textTokens = finalText ? finalText.split(/\s+/).filter(Boolean) : []
    return { text: finalText, dateRange, operators, empty, textTokens }
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
    return this.normalize(label).replace(/\s+/g, '-')
  }

  private noteCreatedInRange(note: NoteI, range: { start: Date; end: Date }) {
    const created = note.createdAt ? new Date(note.createdAt) : null
    if (!created || Number.isNaN(created.getTime())) return false
    return created >= range.start && created < range.end
  }

  private getNoteHaystack(note: NoteI): string {
    const title = note.noteTitle || ''
    const body = note.noteBody || ''
    const cbCount = note.checkBoxes?.length || 0
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
    if (cached && cached.title === title && cached.body === body && cached.cbCount === cbCount && cached.labelKey === labelKey && cached.attachmentKey === attachmentKey) {
      return cached.haystack
    }
    let raw = title + ' ' + body
    if (note.checkBoxes) for (const cb of note.checkBoxes) raw += ' ' + (cb.data ?? '')
    if (note.labels) for (const l of note.labels) if (l.added) raw += ' ' + l.name
    if (note.attachments) for (const attachment of note.attachments) raw += ' ' + attachment.originalName
    const haystack = this.normalize(raw)
    this.noteHaystackCache.set(note, { title, body, cbCount, labelKey, attachmentKey, haystack })
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

  private dateRangeFromQuery(query: string) {
    const now = new Date()
    const yearMatch = query.match(/\b(20\d{2}|19\d{2})\b/)
    const monthIndex = this.monthIndex(query)
    const numericDate = query.match(/\b(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?\b/)
    const monthDay = query.match(new RegExp(`\\b(${this.months.join('|')})\\s+(\\d{1,2})(?:\\s+(20\\d{2}|19\\d{2}))?\\b`))

    if (query.includes('today')) return this.dayRange(now)
    if (query.includes('yesterday')) return this.dayRange(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))

    if (query.includes('last year')) {
      return this.yearRange(now.getFullYear() - 1)
    }
    if (query.includes('last month')) {
      return this.monthRange(now.getFullYear(), now.getMonth() - 1)
    }

    const relative = query.match(/\b(?:created\s+)?(?:from\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\s+ago\b/)
    if (relative) {
      return this.relativeRange(this.wordNumber(relative[1]), relative[2] as 'day' | 'week' | 'month' | 'year', now)
    }

    if (numericDate) {
      const year = Number(numericDate[1])
      const month = Number(numericDate[2]) - 1
      if (numericDate[3]) return this.dayRange(new Date(year, month, Number(numericDate[3])))
      return this.monthRange(year, month)
    }

    if (monthDay) {
      return this.dayRange(new Date(Number(monthDay[3] || now.getFullYear()), this.monthMap[monthDay[1]], Number(monthDay[2])))
    }

    if (monthIndex !== -1 && yearMatch) return this.monthRange(Number(yearMatch[1]), monthIndex)
    if (monthIndex !== -1) return this.monthRange(now.getFullYear(), monthIndex)
    if (yearMatch) return this.yearRange(Number(yearMatch[1]))

    return null
  }

  private removeDateLanguage(query: string) {
    return query
      .replace(/\bnotes?\b/g, ' ')
      .replace(/\bcreated\b/g, ' ')
      .replace(/\bfrom\b/g, ' ')
      .replace(/\blast year\b/g, ' ')
      .replace(/\blast month\b/g, ' ')
      .replace(/\btoday\b/g, ' ')
      .replace(/\byesterday\b/g, ' ')
      .replace(/\b(20\d{2}|19\d{2})[-/]\d{1,2}(?:[-/]\d{1,2})?\b/g, ' ')
      .replace(/\b(20\d{2}|19\d{2})\b/g, ' ')
      .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:day|week|month|year)s?\s+ago\b/g, ' ')
      .replace(new RegExp(`\\b(${this.months.join('|')})\\b`, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private relativeRange(amount: number, unit: 'day' | 'week' | 'month' | 'year', now: Date) {
    if (unit === 'day') return this.dayRange(new Date(now.getFullYear(), now.getMonth(), now.getDate() - amount))
    if (unit === 'week') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - amount * 7)
      const end = new Date(start)
      end.setDate(start.getDate() + 7)
      return { start, end }
    }
    if (unit === 'month') return this.monthRange(now.getFullYear(), now.getMonth() - amount)
    return this.yearRange(now.getFullYear() - amount)
  }

  private dayRange(day: Date) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate())
    const end = new Date(start)
    end.setDate(start.getDate() + 1)
    return { start, end }
  }

  private monthRange(year: number, month: number) {
    const start = new Date(year, month, 1)
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
    return { start, end }
  }

  private yearRange(year: number) {
    return { start: new Date(year, 0, 1), end: new Date(year + 1, 0, 1) }
  }

  private monthIndex(query: string) {
    const match = this.months.find(month => new RegExp(`\\b${month}\\b`).test(query))
    return match ? this.monthMap[match] : -1
  }

  private wordNumber(value: string) {
    const words: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
      seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
    }
    return words[value] || Number(value) || 0
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
        div = document.createElement('div')
        NotesToolsPipe.normalizeEl = div
      }
      div.innerHTML = raw
      plain = div.textContent || (div as any).innerText || ''
    }
    return plain
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s/:\-!]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private readonly monthMap: Record<string, number> = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sep: 8, sept: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11
  }

  private readonly months = Object.keys(this.monthMap)
}
