/**
 * App-wide UI guards that several components need to agree on:
 *  - the lock screen (while locked, nothing underneath may react to keys or clicks)
 *  - the "unsaved changes" registry (forms register while dirty; leaving the page asks first)
 * Plain module state, so non-React code (hotkey handlers, link clicks) can check it synchronously.
 */
import { useCallback, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';

/* ------------------------------ Lock screen ------------------------------ */

let screenLocked = false;

export function isScreenLocked(): boolean {
  return screenLocked;
}

export function setScreenLocked(v: boolean): void {
  screenLocked = v;
}

/* ------------------------------ Unsaved changes ------------------------------ */

const dirtyForms = new Set<number>();
let nextDirtyId = 1;
let confirmer: (() => Promise<boolean>) | null = null;

/** A form with unsaved changes; returns the function that removes it again. */
export function registerDirtyForm(): () => void {
  const id = nextDirtyId++;
  dirtyForms.add(id);
  return () => {
    dirtyForms.delete(id);
  };
}

export function hasUnsavedChanges(): boolean {
  return dirtyForms.size > 0;
}

/** The dialog used to ask "Leave without saving?" (installed by FeedbackProvider). */
export function setLeaveConfirmer(fn: (() => Promise<boolean>) | null): void {
  confirmer = fn;
}

export const LEAVE_MESSAGE = 'You have unsaved changes. Leave without saving?';

/** Resolves true when it is fine to leave the current page (nothing unsaved, or the user chose Leave). */
export async function confirmLeave(): Promise<boolean> {
  if (!dirtyForms.size) return true;
  if (confirmer) return confirmer();
  // Before FeedbackProvider is mounted: the browser's own confirm box (this module is also loaded by core tests).
  const ask = (globalThis as { confirm?: (message: string) => boolean }).confirm;
  return ask ? ask(LEAVE_MESSAGE) : true;
}

/**
 * Navigation that asks first when a form has unsaved changes. Use `go(to)` for buttons / hotkeys and
 * `onLinkClick(to)` as the onClick of a <Link>/<NavLink> (normal clicks only; Ctrl/Shift clicks are left alone).
 */
export function useGuardedNavigate() {
  const navigate = useNavigate();
  const go = useCallback(
    async (to: string): Promise<boolean> => {
      if (!(await confirmLeave())) return false;
      navigate(to);
      return true;
    },
    [navigate],
  );
  const onLinkClick = useCallback(
    (to: string) => (e: MouseEvent) => {
      if (!hasUnsavedChanges() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      void go(to);
    },
    [go],
  );
  return { go, onLinkClick };
}
