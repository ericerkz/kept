/** Small, bounded syntax check; no grammars or parsing on the UI thread. */
export function obviousCodeSyntax(value: string): boolean {
  const sample = value.slice(0, 500);
  return /\b(?:for|while|if)\s*\([^)]*(?:[=<>]|;)[^)]*\)/.test(sample)
    && sample.includes('{') && sample.includes('}') && /(?:;|\+\+|--)/.test(sample);
}
