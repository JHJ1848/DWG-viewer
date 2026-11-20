import { useLanguage } from '../utils/language';
import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowUpRight, File } from 'lucide-react';

export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" {...props} className="icon-action" title={label} aria-label={label}>{children}</button>;
}

export function ValueTag({ children, label, tone = 'neutral' }: {
  children: ReactNode;
  label?: string;
  tone?: 'neutral' | 'info' | 'ready' | 'warning';
}) {
  return <span className={`value-tag tone-${tone}`}>{label && <span className="tag-label">{label}</span>}<span>{children}</span></span>;
}

export function DrawingRow({ name, size, path, cached, onOpen }: {
  name: string; size: string; path?: string; cached?: boolean; onOpen: () => void;
}) {
  const { t } = useLanguage();
  return <div className="drawing-row">
    <File size={17} aria-hidden="true" />
    <div className="drawing-info">
      <div className="drawing-name"><ValueTag>{name}</ValueTag></div>
      <div className="drawing-meta"><ValueTag>{size}</ValueTag>{cached && <ValueTag tone="ready">{t("已缓存")}</ValueTag>}</div>
      {path && <div className="object-path"><ValueTag>{path}</ValueTag></div>}
    </div>
    <IconButton label={`${t("打开")} ${name}`} onClick={onOpen}><ArrowUpRight /></IconButton>
  </div>;
}

export function AboutDialog({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);
  return <dialog ref={dialogRef} className="about-dialog" aria-labelledby="about-dialog-title"
    data-testid="about-modal-dialog" onCancel={e => { e.preventDefault(); onDismiss(); }}
    onClick={e => {
      if (e.target !== e.currentTarget) return;
      const bounds = e.currentTarget.getBoundingClientRect();
      if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onDismiss();
    }}>
    {children}
  </dialog>;
}
