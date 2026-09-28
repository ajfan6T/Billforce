/**
 * App-wide UI guards that several components need to agree on:
 *  - the lock screen (while locked, nothing underneath may react to keys or clicks)
 *  - the "unsaved changes" registry (forms register while dirty; leaving the page asks first)
 *  - what closing the window should say (a form that loses its changes, or a page that keeps a draft)
 * Plain module state, so non-React code (hotkey handlers, link clicks) can check it synchronously.
 */
import { useCallback, useEffect, type MouseEvent } from 'react';
import { useNavigate, type NavigateOptions } from 'react-router';

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

/** Where to go: a path ("/sales/bills") or a step in the history (-1 = back). */
export type GuardedTarget = string | number;

/**
 * Navigation that asks first when a form has unsaved changes. Use `go(to)` for buttons / hotkeys
 * (`go(-1)` for a Cancel that goes back) and `onLinkClick(to)` as the onClick of a <Link>/<NavLink>
 * (normal clicks only; Ctrl/Shift clicks are left alone). Plain in-app links are also covered by
 * useLinkGuard(). After a successful save, navigate with the plain navigate(): the form is still
 * registered as dirty until it unmounts.
 */
export function useGuardedNavigate() {
  const navigate = useNavigate();
  const go = useCallback(
    async (to: GuardedTarget, opts?: NavigateOptions): Promise<boolean> => {
      if (!(await confirmLeave())) return false;
      if (typeof to === 'number') navigate(to);
      else navigate(to, opts);
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

/** Minimal shape of a DOM click, so the decision below can be tested without a browser. */
export interface LinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Minimal shape of the clicked <a>. */
export interface LinkLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/**
 * The in-app path a click on this link would open, when that click must first ask "Leave without saving?";
 * null when the click can go ahead as usual (nothing unsaved, not an in-app link, a new-tab click, a link
 * that opts out with data-leave-guard="off", or a link to the page that is already open).
 */
export function guardedLinkTarget(e: LinkClick, link: LinkLike | null, currentHash: string): string | null {
  if (!link || !hasUnsavedChanges()) return null;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const href = link.getAttribute('href') ?? '';
  if (!href.startsWith('#/')) return null;
  if (link.hasAttribute('download') || (link.getAttribute('target') ?? '_self') !== '_self') return null;
  if (link.getAttribute('data-leave-guard') === 'off') return null;
  if (href === currentHash) return null;
  return href.slice(1);
}

/**
 * Every in-app link (href="#/…": <Link>, <NavLink> or a plain <a>) asks before leaving a form with unsaved
 * changes, even when the component that renders it did not add onLinkClick. Runs in the capture phase, so the
 * link's own click handlers (and React Router's navigation) only run when nothing is unsaved.
 * Mount once inside the router.
 */
export function useLinkGuard(): void {
  const navigate = useNavigate();
  useEffect(() => {
    // Typed loosely: this module is also compiled for (DOM-less) core tests.
    const doc = (globalThis as { document?: ClickTargetDocument }).document;
    if (!doc) return;
    const onClick = (e: DomClick) => {
      const link = typeof e.target?.closest === 'function' ? e.target.closest('a[href]') : null;
      const to = guardedLinkTarget(e, link, (globalThis as { location?: { hash: string } }).location?.hash ?? '');
      if (to === null) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((ok) => ok && navigate(to));
    };
    doc.addEventListener('click', onClick, true);
    return () => doc.removeEventListener('click', onClick, true);
  }, [navigate]);
}

interface DomClick extends LinkClick {
  target: { closest?: (selector: string) => LinkLike | null } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

interface ClickTargetDocument {
  addEventListener(type: 'click', fn: (e: DomClick) => void, capture: boolean): void;
  removeEventListener(type: 'click', fn: (e: DomClick) => void, capture: boolean): void;
}

/* ------------------------------ Closing the window ------------------------------ */

/**
 * What closing the window would do to what is on screen:
 *  - 'unsaved': changes are lost -> ask "Leave without saving?" (Leave / Stay)
 *  - 'draft':   the page keeps its own draft (the billing screen) -> say it will be kept (Close / Stay)
 */
export type CloseWarningKind = 'unsaved' | 'draft';

export interface CloseWarning {
  kind: CloseWarningKind;
  /** For 'draft': what will happen to it, e.g. "The bill in progress will be kept and shown again next time." */
  note?: string;
}

export const DRAFT_KEPT_NOTE = 'The bill in progress will be kept and shown again next time.';

const closeWarnings = new Map<number, CloseWarning>();
let nextCloseId = 1;

/** The warning closing the window should give right now (unsaved changes win over a kept draft). */
export function currentCloseWarning(): CloseWarning | null {
  let draft: CloseWarning | null = null;
  for (const w of closeWarnings.values()) {
    if (w.kind === 'unsaved') return w;
    draft ??= w;
  }
  return draft;
}

interface CloseBridge {
  setCloseWarning?: (w: CloseWarning | null) => void;
}

interface UnloadEvent {
  preventDefault(): void;
  returnValue: unknown;
}

type WindowLike = {
  addEventListener(type: 'beforeunload', fn: (e: UnloadEvent) => void): void;
  removeEventListener(type: 'beforeunload', fn: (e: UnloadEvent) => void): void;
  billforce?: CloseBridge;
};

const blockUnload = (e: UnloadEvent) => {
  e.preventDefault();
  // Older Chromium needs returnValue set to show the leave prompt.
  e.returnValue = '';
};
let unloadBlocked = false;

/**
 * Keep the window's close behaviour in line with the registry. The desktop app is told which warning to give
 * (its main process shows the question when the page blocks the close); a browser only has its own generic
 * "changes may not be saved" box, so there only real unsaved changes block the close.
 */
function syncCloseWarning(): void {
  const win = (globalThis as { window?: WindowLike }).window;
  if (!win) return;
  const warning = currentCloseWarning();
  const desktop = !!win.billforce;
  const block = !!warning && (desktop || warning.kind === 'unsaved');
  if (block !== unloadBlocked) {
    if (block) win.addEventListener('beforeunload', blockUnload);
    else win.removeEventListener('beforeunload', blockUnload);
    unloadBlocked = block;
  }
  try {
    win.billforce?.setCloseWarning?.(warning);
  } catch {
    /* an older preload without it: the main process falls back to "Leave without saving?" */
  }
}

/** Something closing the window would lose (or, for 'draft', keep); returns the function that removes it again. */
export function registerCloseWarning(warning: CloseWarning): () => void {
  const id = nextCloseId++;
  closeWarnings.set(id, warning);
  syncCloseWarning();
  return () => {
    closeWarnings.delete(id);
    syncCloseWarning();
  };
}
