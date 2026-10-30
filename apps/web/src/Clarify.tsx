import type {
  Clarification,
  ClarifyFrom,
  Contradiction,
  Note,
  ScreenResponse,
} from "@track1/shared";
import {
  Check,
  ChevronDown,
  CircleDashed,
  Clock,
  FileSearch,
  FlaskConical,
  type LucideIcon,
  NotebookPen,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button, cx, formatDate } from "./components/ui";
import type { DocumentTarget } from "./DocumentPanel";
import { cites, LIT, useCitesHovered } from "./hoverLinks";
import { Field, PANE, SHEET, SourceQuote } from "./Pane";

export type NoteInput = Pick<Note, "topic" | "text" | "source" | "clarifies">;

export const WHO: Record<
  ClarifyFrom,
  { title: string; icon: LucideIcon; placeholder: string; source: Note["source"] }
> = {
  patient: {
    title: "Ask the patient",
    icon: UserRound,
    placeholder: "What did she say?",
    source: "patient",
  },
  test: {
    title: "Order or measure",
    icon: FlaskConical,
    placeholder: "The result, with its date",
    source: "clinician",
  },
  records: {
    title: "Check the records",
    icon: FileSearch,
    placeholder: "What did you find, and where?",
    source: "clinician",
  },
};

const ORDER: ClarifyFrom[] = ["patient", "test", "records"];
/** The pane has the height for this many; only a longer list folds, down to {@link SHOWN}. */
const FOLD_ABOVE = 10;
const SHOWN = 8;
const WHY: Record<Clarification["trigger"], string> = {
  gap: "Missing",
  contradiction: "Conflict",
  old: "Latest",
};

function TriggerIcon({ item, answered }: { item: Clarification; answered: boolean }) {
  if (answered) return <Check className="size-3.5 text-success" aria-label="Answered" />;
  if (item.trigger === "contradiction")
    return <TriangleAlert className="size-3.5 text-warning" aria-label="Contradiction" />;
  if (item.trigger === "old")
    return <Clock className="size-3.5 text-warning" aria-label="Old value" />;
  return <CircleDashed className="size-3.5 text-muted-foreground" aria-label="Not documented" />;
}

export function noteTime(note: Note): string {
  const time = new Date(note.recordedAt).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${formatDate(note.recordedAt.slice(0, 10))}, ${time}`;
}

function Row({
  item,
  note,
  onSelect,
}: {
  item: Clarification;
  note?: Note;
  onSelect: (id: string) => void;
}) {
  const lit = useCitesHovered(item.sources);
  return (
    <div className="py-1 [&+&]:shadow-[inset_0_1px_0_var(--border)]">
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        {...cites(item.sources)}
        className={cx(
          "grid w-full cursor-pointer grid-cols-[16px_minmax(0,1fr)] gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors duration-150",
          lit ? LIT : "hover:bg-surface-2",
        )}
      >
        <span className="translate-y-0.5">
          <TriggerIcon item={item} answered={Boolean(note)} />
        </span>
        <span className="min-w-0">
          <span className={cx("block leading-snug", note && "text-muted-foreground")}>
            <span className="font-semibold">{item.topic}</span>
            <span className="text-muted-foreground"> · </span>
            {item.step}
          </span>
          <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
            {note ? `“${note.text}”` : item.reason}
          </span>
        </span>
      </button>
    </div>
  );
}

/**
 * The open points, grouped by who can close them once there is more than one group; answered ones
 * fold away under their count.
 */
export function ClarifyList({
  items,
  notes,
  onSelect,
}: {
  items: Clarification[];
  notes: Note[];
  onSelect: (id: string) => void;
}) {
  const [more, setMore] = useState(false);
  const [showAnswered, setShowAnswered] = useState(false);
  const noteOf = (item: Clarification) => notes.filter((n) => n.clarifies === item.id).at(-1);
  const open = items
    .filter((item) => !noteOf(item))
    .sort((a, b) => ORDER.indexOf(a.from) - ORDER.indexOf(b.from));
  const answered = items.filter((item) => noteOf(item));
  const folds = open.length > FOLD_ABOVE;
  const shown = folds && !more ? open.slice(0, SHOWN) : open;
  const row = (item: Clarification) => (
    <Row key={item.id} item={item} note={noteOf(item)} onSelect={onSelect} />
  );
  const groups = ORDER.map((from) => ({
    from,
    rows: shown.filter((item) => item.from === from),
  })).filter((g) => g.rows.length > 0);
  return (
    <section aria-label="To clarify">
      {items.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Every need on this screen is documented, current and consistent.
        </p>
      )}
      {groups.map(({ from, rows }) => {
        const { title, icon: Icon } = WHO[from];
        return (
          <div key={from} className="mt-3 [&+&]:mt-5">
            {groups.length > 1 && (
              <h3 className="mb-1 flex items-center gap-1.5 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                <Icon className="size-3" aria-hidden />
                {title}
              </h3>
            )}
            {rows.map(row)}
          </div>
        );
      })}
      {folds && (
        <button
          type="button"
          onClick={() => setMore(!more)}
          className="mt-2 cursor-pointer px-2 text-xs text-accent-text hover:underline"
        >
          {more ? "Show fewer" : `${open.length - SHOWN} more open`}
        </button>
      )}
      {answered.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAnswered(!showAnswered)}
            aria-expanded={showAnswered}
            className="mt-3 flex w-full cursor-pointer items-center gap-1.5 px-2 pt-3 text-xs text-muted-foreground shadow-[inset_0_1px_0_var(--border)] hover:text-foreground"
          >
            {answered.length} answered
            <ChevronDown
              className={cx("size-3.5 transition-transform", showAnswered && "rotate-180")}
            />
          </button>
          {showAnswered && <div className="mt-1">{answered.map(row)}</div>}
        </>
      )}
    </section>
  );
}

function NoteCard({ note, onRemove }: { note: Note; onRemove: () => void }) {
  const Icon = note.source === "patient" ? UserRound : NotebookPen;
  return (
    <div className="rounded-xl bg-surface px-3 py-2.5 text-[13px]">
      <p className="mb-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          {note.source === "patient" ? "Reported by the patient" : "Clinician's note"} ·{" "}
          {noteTime(note)}
          {note.author ? ` · ${note.author}` : ""}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 cursor-pointer text-accent-text hover:underline"
        >
          Remove
        </button>
      </p>
      <p className="leading-relaxed whitespace-pre-wrap">{note.text}</p>
    </div>
  );
}

/** One open point: why it is open, the passages behind it, and where to record the answer. */
export function ClarifyPane({
  item,
  notes,
  passages,
  contradiction,
  onClose,
  onOpenLetter,
  onCompare,
  onAddNote,
  onRemoveNote,
}: {
  item: Clarification;
  notes: Note[];
  passages: ScreenResponse["passages"];
  contradiction?: Contradiction;
  onClose: () => void;
  onOpenLetter: (target: DocumentTarget) => void;
  onCompare: (c: Contradiction) => void;
  onAddNote: (note: NoteInput) => Promise<void>;
  onRemoveNote: (id: string) => void;
}) {
  const { placeholder, source } = WHO[item.from];
  const recorded = notes.filter((n) => n.clarifies === item.id);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onAddNote({ topic: item.topic, text: text.trim(), source, clarifies: item.id });
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside aria-label="Open point" className={cx(PANE, SHEET, "relative")}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-3 right-3"
      >
        <X className="size-4" />
      </Button>
      <h3 className="pr-10 text-[22px] leading-tight font-semibold tracking-tight">{item.step}</h3>
      <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-[13px]">
        <Field label="Topic">{item.topic}</Field>
        <Field label={WHY[item.trigger]}>
          <span className="min-w-0">{item.reason}</span>
        </Field>
      </dl>
      {contradiction && (
        <button
          type="button"
          onClick={() => onCompare(contradiction)}
          className="mt-2 cursor-pointer text-xs font-medium text-accent-text hover:underline"
        >
          Compare the passages
        </button>
      )}
      <form onSubmit={save} className="mt-5">
        <label
          htmlFor="clarify-answer"
          className="mb-1.5 block text-xs font-semibold text-muted-foreground"
        >
          Record the answer
        </label>
        <textarea
          id="clarify-answer"
          value={text}
          rows={3}
          maxLength={2000}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
            if (e.key === "Escape" && text.trim()) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          className="w-full resize-none rounded-xl bg-surface px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-2xs text-muted-foreground">
            Kept apart from the documents, as{" "}
            {source === "patient" ? "reported by the patient" : "a clinician's note"}.
          </span>
          <span className="flex-1" />
          <Button type="submit" size="sm" loading={saving} disabled={!text.trim()}>
            Save
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </form>
      {recorded.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          <h4 className="text-xs font-semibold text-muted-foreground">Recorded</h4>
          {recorded.map((note) => (
            <NoteCard key={note.id} note={note} onRemove={() => onRemoveNote(note.id)} />
          ))}
        </div>
      )}
      {item.sources.length > 0 && (
        <>
          <h4 className="mt-5 mb-2 text-xs font-semibold text-muted-foreground">
            {item.sources.length === 1 ? "Source" : `${item.sources.length} sources`}
          </h4>
          <div className="flex flex-col gap-2">
            {item.sources.map((s) => (
              <SourceQuote
                key={s.passageId}
                source={s}
                passages={passages}
                onOpenLetter={onOpenLetter}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
