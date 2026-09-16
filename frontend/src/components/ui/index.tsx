import { cn } from '../../lib/utils';
import { forwardRef, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react';
import Icon, { IconName } from './Icon';

export { default as Icon } from './Icon';
export type { IconName } from './Icon';

// ── BUTTON ──────────────────────────────────────────────────
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: IconName;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
  variant = 'primary', size = 'md', loading, fullWidth, icon, className, children, disabled, ...props
}, ref) => {
  /*
   * Raised buttons.
   *
   * The depth is a hard bottom edge — a solid shadow with no blur, the colour of the
   * button darkened — plus a highlight along the top. On hover the button lifts a pixel
   * and the edge grows; on press it drops onto the edge and the edge disappears, which
   * is what makes it feel like something physically travelling down. Blur-based shadows
   * read as haze on a phone in daylight; a hard edge stays legible.
   */
  const base = 'btn3d inline-flex items-center justify-center gap-2 font-semibold rounded-xl '
    + 'select-none disabled:opacity-50 disabled:pointer-events-none disabled:translate-y-0';
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-accent text-accent-ink btn3d-accent',
    secondary: 'bg-primary text-white btn3d-primary',
    danger: 'bg-danger text-white btn3d-danger',
    // Ghost used to be deliberately flat. Every button is raised now, so it gets a
    // surface face of its own rather than sitting as bare text.
    ghost: 'bg-surface2 text-ink border border-border btn3d-surface',
    outline: 'bg-surface2 text-ink border border-border btn3d-surface',
  };
  const sizes: Record<ButtonSize, string> = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-4 py-2.5 text-sm',
    lg: 'px-5 py-3 text-base',
  };
  return (
    <button ref={ref} disabled={disabled || loading} className={cn(base, variants[variant], sizes[size], fullWidth && 'w-full', className)} {...props}>
      {loading
        ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        : icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  );
});
Button.displayName = 'Button';

// ── ICON BUTTON ─────────────────────────────────────────────
/** A square tap target for a single icon, with a real label for screen readers. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  size?: number;
  tone?: 'default' | 'danger' | 'accent';
  variant?: 'plain' | 'solid';
}>(({ icon, label, size = 18, tone = 'default', variant = 'plain', className, ...props }, ref) => {
  const tones = {
    default: 'text-muted hover:text-ink',
    danger: 'text-muted hover:text-danger',
    accent: 'text-accent hover:text-accent-hover',
  };
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'w-9 h-9 flex-shrink-0 rounded-lg inline-flex items-center justify-center transition-colors active:scale-90',
        variant === 'solid'? 'bg-surface2 text-ink hover:bg-border': cn(tones[tone], 'hover:bg-surface2'),
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});
IconButton.displayName = 'IconButton';

// ── CHIP ────────────────────────────────────────────────────
/**
 * A single choice in a row of them.
 *
 * The selected state is carried by a tick as well as the fill, because on a phone in
 * sunlight a colour change alone is easy to miss — and it says nothing at all to a
 * colourblind rider. The tick is the part you can always see.
 */
export function Chip({
  selected, onClick, children, icon, disabled, title, className, showCheck = true,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** A leading glyph. Omitted or empty renders nothing at all. */
  icon?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  showCheck?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold',
        'whitespace-nowrap flex-shrink-0 border transition-colors active:scale-95',
        'disabled:opacity-40 disabled:pointer-events-none',
        selected
          ? 'bg-accent border-accent text-accent-ink': 'bg-surface2 border-border text-muted hover:text-ink',
        className,
      )}
    >
      {selected && showCheck && <Icon name="check" size={13} strokeWidth={3} />}
      {icon ? <span className="leading-none">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

/**
 * A chip laid out vertically — icon above label — for grids where the label is too long
 * to sit beside it. The tick moves to a corner badge so it never squeezes the text.
 */
export function ChipTile({
  selected, onClick, label, icon, disabled, className,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  /** Optional — most tiles are now label-only. */
  icon?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        'relative flex flex-col items-center justify-center gap-0.5 py-2 px-1 rounded-xl',
        'border text-[11px] font-semibold transition-colors active:scale-95',
        'disabled:opacity-40 disabled:pointer-events-none',
        selected
          ? 'bg-accent border-accent text-accent-ink': 'bg-surface2 border-border text-muted',
        className,
      )}
    >
      {selected && (
        <span className="absolute -top-1.5 -right-1.5 w-[18px] h-[18px] rounded-full bg-white text-accent
                         flex items-center justify-center shadow-lg">
          <Icon name="check" size={11} strokeWidth={3.5} />
        </span>
      )}
      {icon ? <span className="text-base leading-none">{icon}</span> : null}
      <span className="leading-tight text-center">{label}</span>
    </button>
  );
}

/** A horizontally scrolling row of chips that does not show a scrollbar. */
export function ChipRow({ children, label, className }: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-muted text-[10px] uppercase tracking-wider">{label}</span>}
      <div className="chip-row">{children}</div>
    </div>
  );
}

// ── CARD ────────────────────────────────────────────────────
interface CardProps { children: React.ReactNode; className?: string; onClick?: () => void; }
export function Card({ children, className, onClick }: CardProps) {
  return (
    <div onClick={onClick} className={cn('bg-surface border border-border rounded-2xl p-4', onClick && 'cursor-pointer hover:bg-surface2 transition-colors', className)}>
      {children}
    </div>
  );
}

// ── INPUT ───────────────────────────────────────────────────
interface InputProps extends InputHTMLAttributes<HTMLInputElement> { label?: string; error?: string; }
export const Input = forwardRef<HTMLInputElement, InputProps>(({ label, error, className, ...props }, ref) => (
  <div className="flex flex-col gap-1.5">
    {label && <label className="text-sm font-medium text-muted">{label}</label>}
    <input ref={ref} className={cn('bg-surface2 border border-border rounded-xl px-4 py-3 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent transition-colors', error && 'border-danger', className)} {...props} />
    {error && <p className="text-xs text-danger">{error}</p>}
  </div>
));
Input.displayName = 'Input';

// ── TEXTAREA ────────────────────────────────────────────────
interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> { label?: string; error?: string; }
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ label, error, className, ...props }, ref) => (
  <div className="flex flex-col gap-1.5">
    {label && <label className="text-sm font-medium text-muted">{label}</label>}
    <textarea ref={ref} className={cn('bg-surface2 border border-border rounded-xl px-4 py-3 text-sm text-ink placeholder:text-muted focus:outline-none focus:border-accent transition-colors resize-none', error && 'border-danger', className)} {...props} />
    {error && <p className="text-xs text-danger">{error}</p>}
  </div>
));
Textarea.displayName = 'Textarea';

// ── SELECT ──────────────────────────────────────────────────
interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { label?: string; error?: string; }
export const Select = forwardRef<HTMLSelectElement, SelectProps>(({ label, error, className, children, ...props }, ref) => (
  <div className="flex flex-col gap-1.5">
    {label && <label className="text-sm font-medium text-muted">{label}</label>}
    {/* appearance-none strips the native arrow, so one is drawn back in — without it the
        field reads as a plain text box and nobody knows it opens. */}
    <div className="relative">
      <select ref={ref} className={cn('bg-surface2 border border-border rounded-xl px-4 py-3 pr-10 w-full text-sm text-ink focus:outline-none focus:border-accent transition-colors appearance-none cursor-pointer', error && 'border-danger', className)} {...props}>
        {children}
      </select>
      <Icon name="chevronDown" size={16}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
    </div>
    {error && <p className="text-xs text-danger">{error}</p>}
  </div>
));
Select.displayName = 'Select';

// ── BADGE ───────────────────────────────────────────────────
type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';
interface BadgeProps { children: React.ReactNode; variant?: BadgeVariant; className?: string; }
export function Badge({ children, variant = 'default', className }: BadgeProps) {
  const variants: Record<BadgeVariant, string> = {
    default: 'bg-surface2 text-muted',
    success: 'bg-green-500/20 text-green-400',
    warning: 'bg-yellow-500/20 text-yellow-400',
    danger: 'bg-red-500/20 text-red-400',
    info: 'bg-blue-500/20 text-blue-400',
  }; return <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold', variants[variant], className)}>{children}</span>;
}

// ── SPINNER ─────────────────────────────────────────────────
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-8 h-8' };
  return <div className={cn('border-2 border-border border-t-accent rounded-full animate-spin', sizes[size])} />;
}

// ── EMPTY STATE ─────────────────────────────────────────────
export function Empty({ icon, title, desc, action }: { icon?: string; title: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      {icon ? <span className="text-5xl">{icon}</span> : null}
      <p className="text-ink font-semibold">{title}</p>
      {desc && <p className="text-muted text-sm max-w-xs">{desc}</p>}
      {action}
    </div>
  );
}

// ── STAT CARD ───────────────────────────────────────────────
export function StatCard({ label, value, sub, icon, color }: { label: string; value: string; sub?: string; icon?: string; color?: string }) {
  return (
    <div className="bg-surface border border-border rounded-2xl p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-muted text-xs">{label}</span>
        {icon ? <span className="text-lg">{icon}</span> : null}
      </div>
      <p className={cn('text-xl font-bold', color)}>{value}</p>
      {sub && <p className="text-muted text-xs">{sub}</p>}
    </div>
  );
}

// ── MODAL ───────────────────────────────────────────────────
interface ModalProps { open: boolean; onClose: () => void; title: string; children: React.ReactNode; }
export function Modal({ open, onClose, title, children }: ModalProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-ink">{title}</h3>
          <IconButton icon="close" label="Close" onClick={onClose} size={17} className="-mr-1" />
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
