import { Loader } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function Spinner({ className }: { className?: string }) {
  return <Loader aria-hidden className={cx("size-4 animate-spin", className)} />;
}

const VARIANTS = {
  default: "bg-accent text-accent-foreground hover:opacity-90",
  secondary: "bg-surface-2 text-foreground hover:bg-hover",
  ghost: "text-foreground hover:bg-surface-2",
} as const;

const SIZES = {
  default: "h-9 px-4 text-sm gap-2",
  sm: "h-8 px-3 text-xs gap-1.5",
  icon: "size-8 justify-center",
} as const;

export function Button({
  variant = "default",
  size = "default",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      title={rest.title ?? (size === "icon" ? rest["aria-label"] : undefined)}
      className={cx(
        "inline-flex shrink-0 cursor-pointer items-center rounded-lg font-medium transition-colors duration-150 disabled:cursor-default disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

const TONES = {
  neutral: "bg-surface-2 text-muted-foreground",
  accent: "bg-accent-wash text-accent-text",
  warning: "bg-warning-wash text-warning",
  danger: "bg-destructive-wash text-destructive",
} as const;

/** Borderless pill with a pastel tonal fill. */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A section's title: small, semibold and tight, with an optional count. */
export function GroupLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="text-sm font-semibold tracking-tight">{children}</h3>
      {aside}
    </div>
  );
}

/** The app's sentence first, then the failing party's words, then the way out. */
export function ErrorText({
  title,
  reason,
  action,
}: {
  title: string;
  reason?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-enter-up flex flex-col items-start gap-1 rounded-lg bg-destructive-wash px-3 py-2.5">
      <p className="text-sm font-medium text-destructive">{title}</p>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      {action}
    </div>
  );
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
