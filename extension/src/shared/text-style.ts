// Wraps (or unwraps, toggling) the current selection of a textarea in a
// markdown-style emphasis marker (*italic*, **bold**) — the same markers
// the LLM is told to use for a translation (see backend/core/text/
// text_processing.py:parse_styled_segments) and that render_text_skia
// resolves regardless of whether they came from the model or were typed by
// hand. So a manually-typed translation (the manual region tool's
// Translation field) can get the same bold/italic control an AI-drafted
// one implicitly has, without any backend change.
export function toggleStyleMarker(textarea: HTMLTextAreaElement, marker: string): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);

  const alreadyWrapped = selected.length >= marker.length * 2
    && selected.startsWith(marker)
    && selected.endsWith(marker);

  if (alreadyWrapped) {
    const inner = selected.slice(marker.length, selected.length - marker.length);
    textarea.value = before + inner + after;
    textarea.setSelectionRange(before.length, before.length + inner.length);
  } else {
    const wrapped = `${marker}${selected}${marker}`;
    textarea.value = before + wrapped + after;
    const cursor = selected ? before.length + wrapped.length : before.length + marker.length;
    textarea.setSelectionRange(cursor, cursor);
  }
  textarea.focus();
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
