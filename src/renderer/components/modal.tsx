import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { isScreenLocked } from '../guards';

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Prevent closing with Escape / backdrop click (e.g. while saving). */
  locked?: boolean;
}

// Only the top-most open modal reacts to Escape.
const stack: number[] = [];
let nextModalId = 1;

/** How many modal dialogs are open right now (0 = none). useHotkeys uses it to keep page shortcuts away from dialogs. */
export function modalDepth(): number {
  return stack.length;
}

/** Accessible modal dialog. Escape and backdrop click close it; focus moves inside on open. */
export function Modal({ open, title, onClose, children, footer, width = 560, locked }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = nextModalId++;
    stack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    const h = (e: KeyboardEvent) => {
      // While the lock screen is up, dialogs underneath must not react to the keyboard.
      if (isScreenLocked()) return;
      if (e.key === 'Escape' && stack[stack.length - 1] === id) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (!locked) closeRef.current();
      }
    };
    window.addEventListener('keydown', h, true);
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), select, textarea, button.btn-primary');
      el?.focus();
    }, 20);
    return () => {
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      window.removeEventListener('keydown', h, true);
      clearTimeout(t);
      prev?.focus?.();
    };
  }, [open, locked]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={{ width }} ref={ref}>
        <header className="modal-header">
          <h2>{title}</h2>
          {!locked && (
            <button className="icon-btn" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
