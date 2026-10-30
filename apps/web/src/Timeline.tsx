import type {
  AssessedFact,
  Contradiction,
  DocumentInfo,
  PatientSummary,
  ScreenResponse,
} from "@track1/shared";
import {
  Activity,
  Ambulance,
  ArrowRight,
  Bed,
  Building2,
  CalendarDays,
  Eye,
  FileText,
  HeartPulse,
  type LucideIcon,
  MessageSquareText,
  Microscope,
  Plus,
  Ribbon,
  ScanLine,
  Scissors,
  Stethoscope,
  Syringe,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cx, formatDate } from "./components/ui";
import { keysOf, SHORTCUTS } from "./hotkeys";
import { standsFor, useDocumentHovered } from "./hoverLinks";
import { citationsOf, departmentOf, type Stay, staysOf } from "./stays";

/** A screen built in this browser, listed so the clinician can go back to it. */
export type ScreenEntry = {
  id: string;
  role: string;
  task: string;
  /** When it was last built, as an ISO time; older entries have none. */
  savedAt?: string;
};

/** The newest screens show; older ones fold behind "N more". */
const RECENT = 4;

const KINDS: { pattern: RegExp; label: string; icon: LucideIcon }[] = [
  { pattern: /langzeit-ekg|holter/i, label: "Holter ECG", icon: HeartPulse },
  { pattern: /24\s*h-?rr|blutdruck/i, label: "24-h blood pressure", icon: Activity },
  { pattern: /histolog|patholog/i, label: "Histology", icon: Microscope },
  { pattern: /augen/i, label: "Eye consult", icon: Eye },
  { pattern: /konsil/i, label: "Consult", icon: MessageSquareText },
  { pattern: /radiolog|röntgen|sonograph|tomograph/i, label: "Radiology report", icon: ScanLine },
  { pattern: /ambulan/i, label: "Outpatient letter", icon: FileText },
  { pattern: /patientenbrief|arztbrief|entlassung/i, label: "Discharge letter", icon: FileText },
];

/** The document's kind in English, such as "Discharge letter" for "Stat. Patientenbrief (Interne)". */
function kindOf(doc: DocumentInfo): { label: string; icon: LucideIcon } {
  const text = `${doc.title} ${doc.type}`;
  return KINDS.find((kind) => kind.pattern.test(text)) ?? { label: doc.title, icon: FileText };
}

const ROLES: [RegExp, LucideIcon][] = [
  [/an(a|e)?esth/i, Syringe],
  [/surg/i, Scissors],
  [/emergenc/i, Ambulance],
  [/oncolog/i, Ribbon],
  [/general practitioner|\bgp\b|family/i, Stethoscope],
];

export const roleIcon = (role: string) =>
  ROLES.find(([pattern]) => pattern.test(role))?.[1] ?? UserRound;

/** "08:41" today, "Yesterday", then the date. */
function savedWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString())
    return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return "Yesterday";
  return at.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const TONES = {
  plain: "bg-surface text-muted-foreground ring-1 ring-border",
  cited: "bg-[color-mix(in_oklch,var(--accent)_14%,var(--chrome))] text-accent-text",
  current: "bg-accent text-accent-foreground",
  stay: "bg-chrome text-muted-foreground",
} as const;

/**
 * A dot on the line for something that opens: the icon says what it is, the fill whether the screen
 * cites it. Stays only label their documents and carry a bare icon instead.
 */
function Node({
  icon: Icon,
  tone,
  warn,
}: {
  icon: LucideIcon;
  tone: keyof typeof TONES;
  warn?: boolean;
}) {
  return (
    <span
      className={cx(
        "relative grid size-[22px] shrink-0 place-items-center rounded-full",
        TONES[tone],
        warn && "shadow-[0_0_0_2px_var(--chrome),0_0_0_3.5px_var(--warning)]",
      )}
    >
      <Icon className="size-3" aria-hidden />
    </span>
  );
}

function Label({
  first,
  children,
  aside,
}: {
  first: boolean;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex items-end gap-1.5 pr-2 pb-1 pl-[41px] text-2xs font-medium text-muted-foreground",
        first ? "h-7" : "h-9",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {aside}
    </div>
  );
}

function ScreenRow({
  entry,
  current,
  onOpen,
  onRemove,
}: {
  entry: ScreenEntry;
  current: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={cx(
        "group relative flex h-11 items-center rounded-lg transition-colors duration-150",
        current ? "bg-hover" : "hover:bg-surface-2",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
        className="grid h-full min-w-0 flex-1 cursor-pointer grid-cols-[22px_minmax(0,1fr)] items-center gap-x-2.5 pl-[9px] text-left"
      >
        <Node icon={roleIcon(entry.role)} tone={current ? "current" : "plain"} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{entry.task}</span>
          <span className="block truncate text-2xs text-muted-foreground tabular-nums">
            {entry.role}
            {entry.savedAt && ` · ${savedWhen(entry.savedAt)}`}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${entry.task} from the list`}
        title="Remove from the list"
        className="mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-hover hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/** Where the hover card for a document sits, beside the sidebar at the row's height. */
type Card = { doc: DocumentInfo; top: number; left: number };

function useHoverCard() {
  const [card, setCard] = useState<Card>();
  const timer = useRef<number>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!card) return;
    const close = () => setCard(undefined);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [card]);

  return {
    card,
    show(doc: DocumentInfo, row: HTMLElement, delay: number) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const box = row.getBoundingClientRect();
        setCard({ doc, top: box.top - 6, left: box.right + 20 });
      }, delay);
    },
    /** A short grace period lets the pointer cross from the row to the card. */
    hide() {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCard(undefined), 150);
    },
    keep() {
      window.clearTimeout(timer.current);
    },
    close() {
      window.clearTimeout(timer.current);
      setCard(undefined);
    },
  };
}

/** What the screen takes from one document and where the document disagrees with the record. */
function DocumentCard({
  card,
  facts,
  conflicts,
  onOpen,
  onEnter,
  onLeave,
}: {
  card: Card;
  facts: AssessedFact[];
  conflicts: Contradiction[];
  onOpen: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { doc } = card;
  const { label, icon: Icon } = kindOf(doc);
  const labels = [...new Set(facts.map((f) => f.label))];
  const keepOnScreen = (el: HTMLDivElement | null) => {
    if (!el) return;
    const lowest = window.innerHeight - el.offsetHeight - 8;
    if (card.top > lowest) el.style.top = `${Math.max(8, lowest)}px`;
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering keeps the card open; the row it belongs to is the button
    <div
      ref={keepOnScreen}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      {...standsFor(doc.id)}
      style={{ top: card.top, left: card.left }}
      className="ui-enter-up fixed z-50 w-80 rounded-xl bg-surface p-3.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border"
    >
      <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{departmentOf(doc.department)}</span>
        <span className="ml-auto shrink-0 tabular-nums">{formatDate(doc.date)}</span>
      </p>
      <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight">{label}</h3>
      <p className="truncate text-muted-foreground">{doc.title}</p>
      {labels.length > 0 && (
        <div className="mt-3 pt-2.5 text-[12.5px] shadow-[inset_0_1px_0_var(--border)]">
          <p>
            <b className="font-semibold tabular-nums">{plural(facts.length, "fact")}</b> on this
            screen
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {labels.slice(0, 6).join(", ")}
            {labels.length > 6 && ` and ${labels.length - 6} more`}
          </p>
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="mt-3 pt-2.5 text-[12.5px] shadow-[inset_0_1px_0_var(--border)]">
          <p className="flex items-center gap-1.5">
            <TriangleAlert className="size-3 shrink-0 text-warning" aria-hidden />
            <b className="font-semibold">{plural(conflicts.length, "contradiction")}</b>
          </p>
          {conflicts.slice(0, 2).map((c) => (
            <p key={c.id} className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {c.summary}
            </p>
          ))}
          {conflicts.length > 2 && (
            <p className="mt-1 text-xs text-muted-foreground">and {conflicts.length - 2} more</p>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onOpen}
        className="mt-3 inline-flex cursor-pointer items-center gap-1 text-[12.5px] font-medium text-accent-text hover:underline"
      >
        Open letter <ArrowRight className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/** A document on the line; it lights up while a line it is cited by is hovered on the screen. */
function DocumentRow({
  doc,
  cited,
  conflicted,
  current,
  dimmed,
  onOpen,
  onHover,
  onLeave,
}: {
  doc: DocumentInfo;
  /** How many facts on the screen it gives. */
  cited: number;
  conflicted: boolean;
  current: boolean;
  /** A screen is on display, so an uncited document's name steps back. */
  dimmed: boolean;
  onOpen: () => void;
  onHover: (row: HTMLElement, delay: number) => void;
  onLeave: () => void;
}) {
  const { label, icon } = kindOf(doc);
  const lit = useDocumentHovered(doc.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={(e) => onHover(e.currentTarget, 350)}
      onMouseLeave={onLeave}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && onHover(e.currentTarget, 0)}
      onBlur={onLeave}
      {...standsFor(doc.id)}
      aria-current={current ? "true" : undefined}
      className={cx(
        "relative grid h-10 w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg pr-2 pl-[9px] text-left transition-colors duration-150",
        lit ? "bg-accent-wash" : current ? "bg-hover" : "hover:bg-surface-2",
      )}
    >
      <Node icon={icon} tone={lit ? "current" : cited ? "cited" : "plain"} warn={conflicted} />
      <span className="min-w-0">
        <span
          className={cx(
            "block truncate text-[13px]",
            cited || lit ? "font-medium" : dimmed && "text-muted-foreground",
            lit && "text-accent-text",
          )}
        >
          {label}
        </span>
        <span className="block truncate text-2xs text-muted-foreground tabular-nums">
          {formatDate(doc.date)} · {departmentOf(doc.department)}
        </span>
      </span>
      {cited > 0 && (
        <span className="grid h-[18px] min-w-[22px] place-items-center rounded-full bg-accent-wash px-1.5 text-2xs font-semibold text-accent-text tabular-nums">
          {cited}
          <span className="sr-only"> {cited === 1 ? "fact" : "facts"} on this screen</span>
        </span>
      )}
    </button>
  );
}

function Gap({ months }: { months: number }) {
  return (
    <div className="relative flex h-8 items-center pl-[41px] text-2xs text-muted-foreground">
      <span aria-hidden className="absolute inset-y-0 left-[18px] w-[5px] bg-chrome" />
      <span
        aria-hidden
        className="absolute inset-y-1 left-[20px] w-px"
        style={{
          backgroundImage:
            "repeating-linear-gradient(var(--muted-foreground) 0 2px, transparent 2px 5px)",
        }}
      />
      {months >= 24 ? `${Math.floor(months / 12)} years` : `${months} months`} without documents
    </div>
  );
}

/**
 * The sidebar's timeline: the screens built in this browser on top, then the record stay by stay,
 * newest first. Documents the screen on display cites carry their fact count; documents in a
 * contradiction get a warning ring, and each stay counts its contradictions.
 */
export function Timeline({
  patient,
  screens,
  currentScreenId,
  screen,
  documentId,
  cards,
  onNewScreen,
  onScreen,
  onRemoveScreen,
  onDocument,
}: {
  patient?: PatientSummary;
  screens: ScreenEntry[];
  currentScreenId?: string;
  /** The screen on display, whose facts and contradictions mark the documents. */
  screen?: ScreenResponse;
  /** The document open beside the screen. */
  documentId?: string;
  /** Hovering a document opens its card; off in the touch drawer. */
  cards: boolean;
  onNewScreen: () => void;
  onScreen: (id: string) => void;
  onRemoveScreen: (id: string) => void;
  onDocument: (document: DocumentInfo) => void;
}) {
  const [all, setAll] = useState(false);
  const stays = useMemo(() => staysOf(patient?.documents ?? []), [patient]);
  const { facts, conflicts } = useMemo(() => citationsOf(screen), [screen]);
  const hover = useHoverCard();
  if (!patient) return null;

  const shown = all ? screens : screens.slice(0, RECENT);
  const open = (doc: DocumentInfo) => {
    hover.close();
    onDocument(doc);
  };

  const row = (doc: DocumentInfo) => (
    <DocumentRow
      key={doc.id}
      doc={doc}
      cited={facts.get(doc.id)?.length ?? 0}
      conflicted={conflicts.has(doc.id)}
      current={doc.id === documentId}
      dimmed={Boolean(screen)}
      onOpen={() => open(doc)}
      onHover={(row, delay) => cards && hover.show(doc, row, delay)}
      onLeave={() => cards && hover.hide()}
    />
  );

  const group = (stay: Stay) => {
    const inStay = new Set(
      stay.documents.flatMap((d) => (conflicts.get(d.id) ?? []).map((c) => c.id)),
    );
    const kind =
      stay.type === "outpatient" ? "Outpatient visit" : stay.type ? "Inpatient stay" : "Document";
    return (
      <div className="relative">
        <span
          aria-hidden
          className="absolute top-4 bottom-5 left-[19px] w-[3px] rounded-full bg-[color-mix(in_oklch,var(--foreground)_16%,transparent)]"
        />
        <div
          title={kind}
          className="relative grid h-8 grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-2.5 pr-2 pl-[9px] text-2xs text-muted-foreground"
        >
          <Node
            icon={stay.type === "outpatient" ? Building2 : stay.type ? Bed : CalendarDays}
            tone="stay"
          />
          <span className="truncate">
            {stay.type && (
              <span className="font-medium">
                {stay.type === "outpatient" ? "Outpatient" : "Inpatient"} ·{" "}
              </span>
            )}
            <span className="font-medium">{stay.department}</span>
            <span className="tabular-nums"> · {stay.months}</span>
          </span>
          {inStay.size > 0 && (
            <span
              title={`${plural(inStay.size, "contradiction")} in this ${stay.type ? "stay" : "document"}`}
              className="flex items-center gap-1 text-2xs font-semibold text-warning tabular-nums"
            >
              <TriangleAlert className="size-3" aria-hidden />
              {inStay.size}
              <span className="sr-only">
                {" "}
                {inStay.size === 1 ? "contradiction" : "contradictions"}
              </span>
            </span>
          )}
        </div>
        {stay.documents.map(row)}
      </div>
    );
  };

  return (
    <div className="relative pb-2">
      <span
        aria-hidden
        className="absolute left-[20px] w-px bg-border"
        style={{ top: screens.length > 0 ? 50 : 44, bottom: 28 }}
      />
      {screens.length > 0 && (
        <>
          <Label
            first
            aside={
              <button
                type="button"
                onClick={onNewScreen}
                aria-label="New screen"
                title={`New screen · ${keysOf(SHORTCUTS.newScreen).join(" ")}`}
                className="-mb-0.5 grid size-5 cursor-pointer place-items-center rounded-md hover:bg-surface-2 hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            }
          >
            Screens
          </Label>
          {shown.map((s) => (
            <ScreenRow
              key={s.id}
              entry={s}
              current={s.id === currentScreenId}
              onOpen={() => onScreen(s.id)}
              onRemove={() => onRemoveScreen(s.id)}
            />
          ))}
          {screens.length > RECENT && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              aria-expanded={all}
              className="relative flex h-7 w-full cursor-pointer items-center pl-[41px] text-2xs text-muted-foreground hover:text-foreground"
            >
              {all ? "Show fewer" : `${screens.length - RECENT} more`}
            </button>
          )}
        </>
      )}
      <Label
        first={screens.length === 0}
        aside={screen && <span className="w-[22px] text-center">facts</span>}
      >
        Record · as of {formatDate(patient.asOf)}
      </Label>
      {stays.map((stay) => (
        <Fragment key={stay.key}>
          {group(stay)}
          {stay.gapMonths >= 2 && <Gap months={stay.gapMonths} />}
        </Fragment>
      ))}
      {hover.card && (
        <DocumentCard
          key={hover.card.doc.id}
          card={hover.card}
          facts={facts.get(hover.card.doc.id) ?? []}
          conflicts={conflicts.get(hover.card.doc.id) ?? []}
          onOpen={() => hover.card && open(hover.card.doc)}
          onEnter={hover.keep}
          onLeave={hover.hide}
        />
      )}
    </div>
  );
}
