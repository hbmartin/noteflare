/** Mirroring another composer must not move the user's active editor or caret. */
export function preserveCommentDraftFocus(target: HTMLElement | undefined, apply: () => void) {
  const active = document.activeElement;
  const selection = document.getSelection();
  const other = active instanceof HTMLElement && active !== document.body && active !== target;
  const anchor = other && selection?.anchorNode && active.contains(selection.anchorNode) ? selection.anchorNode : null;
  const focus = anchor && selection?.focusNode && active.contains(selection.focusNode) ? selection.focusNode : null;
  const anchorOffset = selection?.anchorOffset ?? 0,
    focusOffset = selection?.focusOffset ?? 0;
  try {
    apply();
  } finally {
    if (other && active.isConnected) {
      if (document.activeElement !== active) active.focus({ preventScroll: true });
      if (
        anchor?.isConnected &&
        focus?.isConnected &&
        selection &&
        (selection.anchorNode !== anchor ||
          selection.anchorOffset !== anchorOffset ||
          selection.focusNode !== focus ||
          selection.focusOffset !== focusOffset)
      ) {
        selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
      }
    }
  }
}
