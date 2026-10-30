import type { PatientSummary } from "@track1/shared";
import { ArrowRight, ChevronDown, UserRound } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cx, Spinner } from "./components/ui";
import { highlight } from "./DocumentPanel";
import { PatientHeader, ROLES } from "./ScreenView";
import { roleIcon } from "./Timeline";

const EXAMPLES = [
  "Pre-operative anaesthesia check. You are the anaesthetist. She is scheduled for a hip replacement next week.",
  "Surgery planning after the case conference. You are the surgeon planning her operation.",
  "Diabetes review at the GP. You are her general practitioner (GP), reviewing her diabetes.",
  "Emergency department at night. You are the emergency physician on night duty. She arrives with shortness of breath.",
  "Open follow-ups from the last hospital stay. You are her GP. You check which follow-ups from her last hospital stay are still open.",
];

const TASKS: Record<string, string[]> = {
  Anaesthetist: ["Pre-op check", "Medication before surgery", "Post-op pain plan"],
  Surgeon: ["Pre-op planning", "Post-op review"],
  "General practitioner": ["Diabetes review", "Open follow-ups", "Medication review"],
  "Emergency physician": ["Acute presentation", "Before contrast CT"],
  Oncologist: ["Tumour board", "Treatment planning"],
  "Ward nurse": ["Pre-op admission", "Medication round", "Discharge planning"],
};

const ALIASES: Record<string, string> = {
  Anaesthetist: "anesthetist",
  "General practitioner": "GP",
};

type Suggestion = { role: string; task: string };

const SUGGESTIONS: Suggestion[] = Object.entries(TASKS).flatMap(([role, tasks]) =>
  tasks.map((task) => ({ role, task })),
);
const MAX_SUGGESTIONS = 6;

const ROLE_PREFIX = /^Role: ([^.]+)\.\s*/;

/** The same occasion seen by another role; the screen rules read the prefix as the role. */
export function asRole(situation: string, role: string): string {
  return `Role: ${role}. ${situation.replace(ROLE_PREFIX, "")}`;
}

function parse(situation: string): { role?: string; text: string } {
  const match = situation.match(ROLE_PREFIX);
  const role = ROLES.find((r) => r.toLowerCase() === match?.[1]?.toLowerCase());
  return match && role ? { role, text: situation.slice(match[0].length) } : { text: situation };
}

function suggest(text: string, role: string | undefined): Suggestion[] {
  const typed = text.trim();
  const words = typed
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => new RegExp(`(^|[\\s-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  return SUGGESTIONS.filter(
    (s) =>
      (!role || s.role === role) &&
      !(s.role === role && s.task.toLowerCase() === typed.toLowerCase()) &&
      words.every((word) => word.test(`${s.task} ${s.role} ${ALIASES[s.role] ?? ""}`)),
  ).slice(0, MAX_SUGGESTIONS);
}

export function ScenarioForm({
  patient,
  situation,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  patient?: PatientSummary;
  situation: string;
  busy: boolean;
  onChange: (situation: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { role, text } = parse(situation);
  const suggestions = open && !busy && (role || text.trim()) ? suggest(text, role) : [];
  const RoleIcon = role ? roleIcon(role) : UserRound;

  useEffect(() => {
    // A phone keyboard would cover the page, so only a pointer device gets the cursor right away.
    if (window.matchMedia("(pointer: fine)").matches) field.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    if (text) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  function update(nextRole: string | undefined, nextText: string) {
    onChange(nextRole ? asRole(nextText, nextRole) : nextText);
    setActive(-1);
  }

  function pick(suggestion: Suggestion) {
    update(suggestion.role, suggestion.task);
    setOpen(false);
    field.current?.focus();
  }

  function build() {
    if (!text.trim() || busy) return;
    setOpen(false);
    onSubmit();
  }

  return (
    <div className="flex flex-col lg:pt-[16vh]">
      <div className="flex justify-center">
        {patient ? (
          <PatientHeader patient={patient} />
        ) : (
          <p className="text-2xl font-semibold tracking-tight text-shimmer">Loading patient…</p>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          build();
        }}
        className="relative mt-7"
      >
        <div className="flex items-end gap-3 rounded-[18px] bg-surface-2 p-2.5 transition-colors duration-150 focus-within:bg-hover/60">
          <label
            className={cx(
              "relative inline-flex h-10 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-full pr-2.5 pl-3 text-[13px] font-medium transition-colors duration-150 has-focus-visible:shadow-[0_0_0_2px_var(--accent-text)]",
              role ? "bg-accent-wash text-accent-text" : "bg-surface text-muted-foreground",
            )}
          >
            <RoleIcon className="size-3.5 shrink-0" aria-hidden />
            <span className={cx(role && "hidden sm:inline")}>{role ?? "Role"}</span>
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            <select
              aria-label="Your role"
              value={role ?? ""}
              onChange={(e) => {
                update(e.target.value || undefined, text);
                field.current?.focus();
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value="">Other role: say it in the text</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <textarea
            ref={field}
            id="scenario"
            value={text}
            rows={1}
            aria-label="Scenario"
            aria-autocomplete="list"
            aria-controls={suggestions.length > 0 ? listId : undefined}
            aria-activedescendant={suggestions[active] ? `${listId}-${active}` : undefined}
            placeholder="What's happening? Or paste the whole situation"
            onChange={(e) => {
              update(role, e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length > 0) {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : -1;
                const count = suggestions.length;
                setActive((i) => (i < 0 ? (step > 0 ? 0 : count - 1) : (i + step + count) % count));
              } else if (e.key === "Escape" && suggestions.length > 0) {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const chosen = suggestions[active];
                if (chosen) pick(chosen);
                else build();
              }
            }}
            className="max-h-[40vh] min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
          />
          {/* Keys keep React from turning the clicked Cancel into a submit button mid-click. */}
          {busy ? (
            <button
              key="cancel"
              type="button"
              onClick={() => {
                onCancel();
                field.current?.focus();
              }}
              className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-surface px-4 text-sm font-medium transition-colors duration-150 hover:bg-hover"
            >
              <Spinner /> Cancel
            </button>
          ) : (
            <button
              key="build"
              type="submit"
              disabled={!text.trim()}
              aria-label="Build screen"
              title="Build screen"
              className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full bg-accent text-accent-foreground transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              <ArrowRight className="size-4" aria-hidden />
            </button>
          )}
        </div>
        {suggestions.length > 0 && (
          <div
            id={listId}
            role="listbox"
            aria-label="Suggested tasks"
            className="ui-enter-up absolute inset-x-0 top-full z-30 mt-2 rounded-[14px] bg-surface p-1.5 shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border"
          >
            {suggestions.map((suggestion, index) => {
              const Icon = roleIcon(suggestion.role);
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the field moves through the suggestions and Enter picks one
                <div
                  key={`${suggestion.role}:${suggestion.task}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => index !== active && setActive(index)}
                  onClick={() => pick(suggestion)}
                  className={cx(
                    "grid cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] py-2 pr-3 pl-2.5 text-sm",
                    index === active && "bg-surface-2",
                  )}
                >
                  <span
                    className={cx(
                      "grid size-[22px] place-items-center rounded-full text-muted-foreground",
                      index === active ? "bg-hover" : "bg-surface-2",
                    )}
                  >
                    <Icon className="size-3" aria-hidden />
                  </span>
                  <span className="truncate">{highlight(suggestion.task, text.trim())}</span>
                  <span className="text-xs text-muted-foreground">{suggestion.role}</span>
                </div>
              );
            })}
          </div>
        )}
      </form>
      {!role && !text.trim() && (
        <>
          <p className="mt-6 mb-2 text-center text-xs text-muted-foreground">Examples</p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  onChange(example);
                  field.current?.focus();
                }}
                title={example}
                className="cursor-pointer rounded-full bg-surface-2 px-[11px] py-[5px] text-xs text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground"
              >
                {example.split(".")[0]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
