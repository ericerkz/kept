import { Injectable, OnDestroy } from '@angular/core';
import { MAX_HIGHLIGHT_CHARS } from '../utils/code-blocks';

export type CodeHighlight = { language: string; html: string | null; isCode?: boolean };
type Job = { text: string; language: string; sample: string; resolve: (value: CodeHighlight) => void };
const plain = (): CodeHighlight => ({ language: 'plaintext', html: null });

/** One bounded worker for all visible snippets. Never run a grammar on the UI thread. */
@Injectable({ providedIn: 'root' })
export class CodeHighlightService implements OnDestroy {
  private worker?: Worker;
  private queue: Job[] = [];
  private active?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private unavailable = false;
  private cache = new Map<string, CodeHighlight>();
  private cacheChars = 0;
  private key(job: Pick<Job, 'text' | 'language' | 'sample'>) { return JSON.stringify([job.text, job.language, job.sample]); }

  highlight(text: string, language: string, sample = text): Promise<CodeHighlight> {
    sample = sample.slice(0, 500);
    if (this.unavailable || language === 'plaintext' || !text || text.length > MAX_HIGHLIGHT_CHARS || this.queue.length >= 32) return Promise.resolve(plain());
    const cached = this.cache.get(this.key({ text, language, sample }));
    if (cached) return Promise.resolve(cached);
    return new Promise(resolve => { this.queue.push({ text, language, sample, resolve }); this.next(); });
  }

  private next() {
    if (this.active || !this.queue.length) return;
    try {
      this.worker ??= new Worker(new URL('../utils/code-highlight.worker', import.meta.url));
      this.worker.onmessage = ({ data }: MessageEvent<CodeHighlight>) => this.finish(data);
      this.worker.onerror = event => { event.preventDefault(); this.disable(); };
      this.active = this.queue.shift()!;
      this.timer = setTimeout(() => this.disable(), 1500);
      this.worker.postMessage({ text: this.active.text, language: this.active.language, sample: this.active.sample });
    } catch { this.disable(); }
  }

  private finish(result: CodeHighlight) {
    clearTimeout(this.timer);
    const job = this.active;
    this.active = undefined;
    if (job) {
      const key = this.key(job);
      const size = key.length + (result.html?.length || 0);
      while (this.cache.size && (this.cache.size >= 64 || this.cacheChars + size > 500000)) {
        const first = this.cache.keys().next().value!;
        this.cacheChars -= first.length + (this.cache.get(first)!.html?.length || 0);
        this.cache.delete(first);
      }
      if (size <= 500000) { this.cache.set(key, result); this.cacheChars += size; }
      job.resolve(result);
    }
    this.next();
  }

  private disable() {
    this.unavailable = true;
    clearTimeout(this.timer);
    this.worker?.terminate(); this.worker = undefined;
    this.active?.resolve(plain()); this.active = undefined;
    for (const job of this.queue.splice(0)) job.resolve(plain());
  }
  ngOnDestroy() { this.disable(); this.cache.clear(); }
}
