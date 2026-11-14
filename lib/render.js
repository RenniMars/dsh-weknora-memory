/**
 * Vendored from @wxg-prc-cpg/dsh-weknora 0.1.0 (dist/render.js), MIT, source repo
 * https://github.com/Tencent/WeKnora (packages/dsh-weknora). Kept byte-for-byte apart from
 * this banner so upstream fixes can be diffed back in; integration lives in lib/tool-config.js
 * and lib/index.js, never here.
 */
/** Pure projections from a tool's canonical value to model-facing text. */
/** Clip text to a character budget, reporting whether anything was dropped. */
export function clip(text, maxChars) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    if (normalized.length <= maxChars)
        return { text: normalized, truncated: false };
    return { text: `${normalized.slice(0, maxChars).trimEnd()}…`, truncated: true };
}
/** Human-readable score, tolerant of a backend that omits it. */
export function formatScore(score) {
    return Number.isFinite(score) ? score.toFixed(3) : 'n/a';
}
/**
 * Name a retrieval scope without spending the model's context on it. A
 * deployment can hold dozens of knowledge bases, and spelling out every id on
 * every search costs far more than the count is worth; the ids stay in the
 * tool's canonical value for anything that needs them.
 */
export function describeScope(ids) {
    if (ids.length === 0)
        return '(deployment default)';
    if (ids.length <= 3)
        return ids.join(', ');
    return `${ids.length} knowledge bases`;
}
//# sourceMappingURL=render.js.map