import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { errorMessage } from './api';
import { Button } from './components/ui';
import { Modal } from './components/modal';
import { registerDirtyForm, setLeaveConfirmer } from './guards';

/* ------------------------------ Toasts ------------------------------ */

type ToastKind = 'success' | 'error' | 'info' | 'warning';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  success(message: string, action?: ToastItem['action']): void;
  error(messageOrError: unknown): void;
  info(message: string, action?: ToastItem['action']): void;
  warning(message: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };

/* ------------------------------ Dialogs ----------------------------- */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  confirmText?: string;
  danger?: boolean;
  multiline?: boolean;
}

interface DialogApi {
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Ask for text (e.g. a reason for cancelling). Resolves null if cancelled. */
  prompt(opts: PromptOptions): Promise<string | null>;
}

const DialogContext = createContext<DialogApi | null>(null);

type DialogState =
  | { type: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void };

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((kind: ToastKind, message: string, action?: ToastItem['action']) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-4), { id, kind, message, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 8000 : 3500);
  }, []);
  const toastApi = useRef<ToastApi>({
    success: (m, a) => push('success', m, a),
    error: (e) => push('error', errorMessage(e)),
    info: (m, a) => push('info', m, a),
    warning: (m) => push('warning', m),
  }).current;

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const dialogApi = useRef<DialogApi>({
    confirm: (opts) => new Promise<boolean>((resolve) => setDialog({ type: 'confirm', opts, resolve })),
    prompt: (opts) =>
      new Promise<string | null>((resolve) => {
        setPromptValue(opts.defaultValue ?? '');
        setDialog({ type: 'prompt', opts, resolve });
      }),
  }).current;

  // In-app navigation away from a form with unsaved changes asks with this dialog (see guards.ts).
  useEffect(() => {
    setLeaveConfirmer(() =>
      dialogApi.confirm({
        title: 'Leave without saving?',
        message: 'You have unsaved changes on this page. If you leave now, they will be lost.',
        confirmText: 'Leave',
        cancelText: 'Stay',
        danger: true,
      }),
    );
    return () => setLeaveConfirmer(null);
  }, [dialogApi]);

  const close = (value: boolean | string | null) => {
    if (!dialog) return;
    if (dialog.type === 'confirm') dialog.resolve(value === true);
    else dialog.resolve(typeof value === 'string' ? value : null);
    setDialog(null);
  };

  return (
    <ToastContext.Provider value={toastApi}>
      <DialogContext.Provider value={dialogApi}>
        {children}
        {dialog?.type === 'confirm' && (
          <Modal
            open
            title={dialog.opts.title}
            onClose={() => close(false)}
            width={440}
            footer={
              <>
                {/* A destructive confirm starts on Cancel, so a stray Enter never deletes anything. */}
                <Button variant="ghost" autoFocus={!!dialog.opts.danger} onClick={() => close(false)}>
                  {dialog.opts.cancelText ?? 'Cancel'}
                </Button>
                <Button variant={dialog.opts.danger ? 'danger' : 'primary'} autoFocus={!dialog.opts.danger} onClick={() => close(true)}>
                  {dialog.opts.confirmText ?? 'OK'}
                </Button>
              </>
            }
          >
            {dialog.opts.message && <div className="dialog-message">{dialog.opts.message}</div>}
          </Modal>
        )}
        {dialog?.type === 'prompt' && (
          <Modal
            open
            title={dialog.opts.title}
            onClose={() => close(null)}
            width={460}
            footer={
              <>
                <Button variant="ghost" onClick={() => close(null)}>
                  Cancel
                </Button>
                <Button
                  variant={dialog.opts.danger ? 'danger' : 'primary'}
                  disabled={dialog.opts.required && !promptValue.trim()}
                  onClick={() => close(promptValue.trim())}
                >
                  {dialog.opts.confirmText ?? 'OK'}
                </Button>
              </>
            }
          >
            {dialog.opts.message && <div className="dialog-message">{dialog.opts.message}</div>}
            <label className="field">
              <span className="field-label">{dialog.opts.label}</span>
              {dialog.opts.multiline ? (
                <textarea
                  className="input"
                  rows={3}
                  autoFocus
                  value={promptValue}
                  placeholder={dialog.opts.placeholder}
                  onChange={(e) => setPromptValue(e.target.value)}
                />
              ) : (
                <input
                  className="input"
                  autoFocus
                  value={promptValue}
                  placeholder={dialog.opts.placeholder}
                  onChange={(e) => setPromptValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (!dialog.opts.required || promptValue.trim())) close(promptValue.trim());
                  }}
                />
              )}
            </label>
          </Modal>
        )}
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((t) => {
            const Icon = ICONS[t.kind];
            return (
              <div key={t.id} className={`toast toast-${t.kind}`}>
                <Icon size={18} />
                <span className="toast-msg">{t.message}</span>
                {t.action && (
                  <button
                    className="toast-action"
                    onClick={() => {
                      t.action!.onClick();
                      setToasts((x) => x.filter((y) => y.id !== t.id));
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
                <button className="toast-close" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </DialogContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error('useToast outside FeedbackProvider');
  return t;
}

export function useDialogs(): DialogApi {
  const d = useContext(DialogContext);
  if (!d) throw new Error('useDialogs outside FeedbackProvider');
  return d;
}

/**
 * Warn before leaving a page with unsaved changes: closing the window (the desktop app asks
 * "Leave without saving?") and, unless `navigation: false`, moving to another page from the
 * sidebar, "Back" links, link buttons and F2 (they ask with the same question first).
 * Pass `navigation: false` when the page keeps its own draft (the billing screen).
 */
export function useUnsavedWarning(dirty: boolean, opts: { navigation?: boolean } = {}): void {
  const guardNavigation = opts.navigation !== false;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older Chromium needs returnValue set to show the leave prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    const unregister = guardNavigation ? registerDirtyForm() : null;
    return () => {
      window.removeEventListener('beforeunload', h);
      unregister?.();
    };
  }, [dirty, guardNavigation]);
}
