import type { PatientSummary } from "@track1/shared";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Avatar, cx, formatDate, Sex } from "./components/ui";
import { highlight } from "./DocumentPanel";
import { staysOf } from "./stays";

/** Every word must match the name, the ID or the date of birth as 01.02.1960, 1960-02-01 or 1 Feb 1960. */
function matches(patient: PatientSummary, query: string): boolean {
  const born = new Date(`${patient.dateOfBirth}T00:00:00`);
  const fields = [
    patient.name,
    patient.id,
    patient.dateOfBirth,
    formatDate(patient.dateOfBirth),
    born.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
  ].map((field) => field.toLowerCase());
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => fields.some((field) => field.includes(word)));
}

function lastStay(patient: PatientSummary): string | undefined {
  const stay = staysOf(patient.documents)[0];
  if (!stay) return undefined;
  const kind =
    stay.type === "outpatient" ? "Outpatient visit" : stay.type ? "Last stay" : "Latest document";
  return `${kind} ${stay.months} · ${stay.department}`;
}

/**
 * The current patient; a click opens a search by name, date of birth or ID. Picking a patient
 * starts a new screen for them.
 */
export function PatientSwitcher({
  patients,
  current,
  below,
  onPick,
}: {
  patients: PatientSummary[];
  current?: PatientSummary;
  /** The results open under the button, as in the narrow drawer, instead of beside the sidebar. */
  below: boolean;
  onPick: (patient: PatientSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hits = patients.filter((p) => matches(p, query));

  const close = (refocus = false) => {
    setOpen(false);
    setQuery("");
    setActive(0);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      setOpen(false);
      setQuery("");
      setActive(0);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (patient: PatientSummary) => {
    close();
    onPick(patient);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Find a patient by name, date of birth or ID"
        className={cx(
          "grid w-full cursor-pointer grid-cols-[34px_minmax(0,1fr)_14px] items-center gap-2.5 rounded-xl bg-surface px-2.5 py-2 text-left ring-inset transition-shadow duration-150",
          open && "ring-[1.5px] ring-accent",
        )}
      >
        {current ? (
          <Avatar name={current.name} />
        ) : (
          <span className="size-[34px] rounded-full bg-surface-2" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {current?.name ?? "Loading patient…"}
          </span>
          {current && (
            <span className="block truncate text-xs text-muted-foreground tabular-nums">
              {formatDate(current.dateOfBirth)} · {current.id}
            </span>
          )}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Find patient"
          className={cx(
            "ui-enter-up absolute z-50 rounded-[14px] bg-surface p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border",
            below ? "inset-x-0 top-full mt-2" : "top-0 left-full ml-4 w-[22rem]",
          )}
        >
          <label className="flex items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-sm">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close(true);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (hits.length ? (i + step + hits.length) % hits.length : 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const hit = hits[active];
                  if (hit) pick(hit);
                }
              }}
              placeholder="Name, date of birth or ID"
              aria-label="Find patient by name, date of birth or ID"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
            />
          </label>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {hits.map((p, i) => {
              const stay = lastStay(p);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pick(p)}
                  onMouseEnter={() => setActive(i)}
                  className={cx(
                    "grid w-full cursor-pointer grid-cols-[34px_minmax(0,1fr)_16px] items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left",
                    i === active && "bg-surface-2",
                  )}
                >
                  <Avatar name={p.name} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {highlight(p.name, query)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground tabular-nums">
                      <Sex sex={p.sex} /> · born {formatDate(p.dateOfBirth)} · {p.ageAsOf} y ·{" "}
                      {highlight(p.id, query)}
                    </span>
                    {stay && (
                      <span className="block truncate text-xs text-muted-foreground">{stay}</span>
                    )}
                  </span>
                  {p.id === current?.id && (
                    <Check className="size-4 text-accent-text" aria-hidden />
                  )}
                </button>
              );
            })}
            {hits.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">
                No patient matches “{query.trim()}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
