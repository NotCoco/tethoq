/**
 * Copying, and whether it happened.
 *
 * The window runs from `file://` under a permission policy that grants nothing
 * but audio, so `navigator.clipboard.writeText` is refused outright — every copy
 * control in the app was failing. Worse, the refusal arrived as an unhandled
 * rejection, so pressing copy replaced the whole app with the fault card. The
 * desktop's own clipboard needs no permission, and a copy that cannot happen
 * answers false rather than throwing.
 *
 * Nothing here touches `window` at module scope: these controls are bundled into
 * headless tests, and a module that reads the DOM on import cannot be.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text.trim() === "") return false;
  const desktop = globalThis.window?.tethoqDesktop;
  if (desktop !== undefined) {
    try {
      return await desktop.copyText(text);
    } catch {
      return false;
    }
  }
  // Browser preview has no desktop bridge; there the web clipboard is all there is.
  try {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
