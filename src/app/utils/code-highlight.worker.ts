import hljs from 'highlight.js/lib/core';
import { obviousCodeSyntax } from './code-detection';
import { MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES } from './code-limits';
import python from 'highlight.js/lib/languages/python';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import go from 'highlight.js/lib/languages/go';
import powershell from 'highlight.js/lib/languages/powershell';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import php from 'highlight.js/lib/languages/php';
import rust from 'highlight.js/lib/languages/rust';
import swift from 'highlight.js/lib/languages/swift';
import kotlin from 'highlight.js/lib/languages/kotlin';
import ruby from 'highlight.js/lib/languages/ruby';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';

for (const [id, grammar] of Object.entries({ python, javascript, typescript, java, csharp, cpp, go, powershell, bash, sql, json, xml, css, php, rust, swift, kotlin, ruby, yaml, markdown })) hljs.registerLanguage(id, grammar);
hljs.safeMode();

export function highlightCode(text: string, language: string, sample: string) {
  if (text.length > MAX_HIGHLIGHT_CHARS || text.split('\n').length > MAX_HIGHLIGHT_LINES) return { language: 'plaintext', html: null };
  let detected = language;
  let isCode = language !== 'auto' && language !== 'plaintext';
  if (language === 'auto') {
    const input = sample.slice(0, 500);
    const guess = hljs.highlightAuto(input, hljs.listLanguages());
    // Similar languages often tie on valid code. The confidence that this is
    // code is separate from confidence in a particular language label.
    const structuredLoop = obviousCodeSyntax(input);
    isCode = structuredLoop || !!guess.language && guess.relevance >= 5 && !['markdown', 'yaml'].includes(guess.language);
    detected = isCode && (!guess.secondBest || guess.relevance >= guess.secondBest.relevance * 1.25) ? guess.language! : 'plaintext';
    if (isCode && /\bConsole\.(?:Write(?:Line)?|Read(?:Line|Key)?)\s*\(/.test(input)) detected = 'csharp';
  }
  if (!hljs.getLanguage(detected)) return { language: 'plaintext', html: null, isCode };
  return { language: detected, html: hljs.highlight(text, { language: detected, ignoreIllegals: true }).value, isCode };

}

addEventListener('message', ({ data }) => {
  try { postMessage(highlightCode(data.text, data.language, data.sample)); }
  catch { postMessage({ language: 'plaintext', html: null }); }
});
