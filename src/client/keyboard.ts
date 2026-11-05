/** Native composition indicators shared by input submission and global shortcuts. */
export function isComposingKey(event: { isComposing?: boolean; key: string; keyCode: number }) {
  return event.isComposing === true || event.key === "Process" || event.keyCode === 229;
}
