/**
 * What the page says closing the window would do (sent by the renderer's guards.ts whenever it changes),
 * and the question the main process asks when the page blocks the close. No Electron imports: tested in vitest.
 *  - 'unsaved': changes would be lost -> "Leave without saving?" (Leave / Stay)
 *  - 'draft':   the page keeps a draft that is shown again (the billing screen) -> "Close Billforce?" (Close / Stay)
 */
export interface CloseWarning {
  kind: 'unsaved' | 'draft';
  note?: string;
}

/** The message box options (the shape of Electron's MessageBoxSyncOptions). */
export interface CloseQuestion {
  type: 'question';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

/** Only trust what the page sent after checking it. */
export function readCloseWarning(v: unknown): CloseWarning | null {
  if (!v || typeof v !== 'object') return null;
  const { kind, note } = v as { kind?: unknown; note?: unknown };
  if (kind !== 'unsaved' && kind !== 'draft') return null;
  return { kind, note: typeof note === 'string' && note.trim() ? note.slice(0, 300) : undefined };
}

/** The first button (index 0) always means "go ahead and close". */
export function closeQuestion(w: CloseWarning | null): CloseQuestion {
  if (w?.kind === 'draft') {
    return {
      type: 'question',
      title: 'Close Billforce',
      message: 'Close Billforce?',
      detail: w.note ?? 'What you entered will be kept and shown again next time.',
      buttons: ['Close', 'Stay'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
  }
  return {
    type: 'question',
    title: 'Unsaved changes',
    message: 'You have unsaved changes. Leave without saving?',
    detail: 'If you leave now, the changes you have not saved will be lost.',
    buttons: ['Leave', 'Stay'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
