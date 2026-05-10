import { Pipe, PipeTransform } from '@angular/core';
import { CheckboxI } from '../interfaces/notes';

interface CachedSplit {
  active: CheckboxI[]
  done: CheckboxI[]
  length: number
  doneCount: number
  // FNV-1a-ish hash of the (id, done) pairs — cheap to recompute and changes
  // when any checkbox's done flag flips or when items are added/removed/reordered.
  hash: number
}

@Pipe({
    name: 'cboxDone',
    pure: false,
    standalone: false
})
export class CboxDonePipe implements PipeTransform {

  // Impure pipes run every change-detection cycle. Cache results keyed by the
  // input array reference so the same instance can serve many notes without
  // re-filtering on every CD pass.
  private cache = new WeakMap<CheckboxI[], CachedSplit>()

  transform(object: CheckboxI[], isDone: boolean): CheckboxI[] {
    if (!object) return object
    const len = object.length
    let hash = 2166136261 | 0
    let doneCount = 0
    for (let i = 0; i < len; i++) {
      const cb = object[i]
      if (cb.done) doneCount++
      hash ^= (cb.id ?? i) | 0
      if (cb.done) hash ^= 0x9e3779b1
      hash = Math.imul(hash, 16777619)
    }

    let cached = this.cache.get(object)
    if (cached && cached.length === len && cached.doneCount === doneCount && cached.hash === hash) {
      return isDone ? cached.done : cached.active
    }

    const active: CheckboxI[] = []
    const done: CheckboxI[] = []
    for (let i = 0; i < len; i++) {
      if (object[i].done) done.push(object[i])
      else active.push(object[i])
    }
    cached = { active, done, length: len, doneCount, hash }
    this.cache.set(object, cached)
    return isDone ? done : active
  }
}
