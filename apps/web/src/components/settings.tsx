import { ChevronDown } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cx } from "./ui";

/*
 * Marlene's and Oktoplan's settings layout, after Oktami UI's `settings.tsx`, drawn with this
 * app's tokens: a list of categories beside one category's sections, a select on a phone.
 */

export type SettingsItem<T extends string> = { value: T; label: string; icon: ReactNode };

export function SettingsLayout<T extends string>({
  items,
  value,
  onValueChange,
  navigationLabel,
  children,
}: {
  items: readonly SettingsItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  navigationLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 md:flex-row md:gap-10">
      <nav aria-label={navigationLabel} className="hidden w-44 shrink-0 flex-col gap-0.5 md:flex">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-current={item.value === value ? "page" : undefined}
            onClick={() => onValueChange(item.value)}
            className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground aria-[current=page]:bg-surface-2 aria-[current=page]:font-medium aria-[current=page]:text-foreground [&_svg]:size-4"
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="relative md:hidden">
        <select
          aria-label={navigationLabel}
          value={value}
          onChange={(event) => {
            const item = items.find((candidate) => candidate.value === event.target.value);
            if (item) onValueChange(item.value);
          }}
          className="h-10 w-full cursor-pointer appearance-none rounded-xl bg-surface-2 px-3.5 text-sm font-medium outline-none"
        >
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      <div className="ui-enter-up flex min-w-0 flex-1 flex-col gap-10" key={value}>
        {children}
      </div>
    </div>
  );
}

/** A category's title, with what belongs beside it such as a sign-out button. */
export function SettingsHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="-mb-4 flex min-h-8 items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col">
      <h2 id={titleId} className="text-sm font-semibold tracking-tight">
        {title}
      </h2>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      <div className="mt-2 flex flex-col">{children}</div>
    </section>
  );
}

/** One setting: what it is on the left, its control on the right, a hairline between rows. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className="flex flex-col gap-x-6 gap-y-3 py-3.5 sm:flex-row sm:items-center [&+&]:shadow-[inset_0_1px_0_var(--border)]">
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label id={labelId} htmlFor={htmlFor} className="text-sm">
            {label}
          </label>
        ) : (
          <div id={labelId} className="text-sm">
            {label}
          </div>
        )}
        {description && (
          <div id={descriptionId} className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children && (
        <fieldset
          aria-labelledby={labelId}
          aria-describedby={description ? descriptionId : undefined}
          className="flex shrink-0 items-center gap-2"
        >
          {children}
        </fieldset>
      )}
    </div>
  );
}

/** A few mutually exclusive choices side by side, as radio buttons. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onValueChange,
}: {
  label: string;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onValueChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="inline-flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground has-checked:bg-surface has-checked:text-foreground has-focus-visible:shadow-[0_0_0_2px_var(--accent-text)] [&_svg]:size-3.5"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onValueChange(option.value)}
            className="sr-only"
          />
          {option.icon}
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

export function Switch({
  id,
  checked,
  onCheckedChange,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full bg-hover transition-colors duration-150 aria-checked:bg-accent"
    >
      <span
        aria-hidden
        className={cx(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-surface transition-transform duration-150",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
