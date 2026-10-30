import type { LetterBlock, LetterRow, Passage, PatientDocument, Source } from "@track1/shared";
import { Minus, Plus, X } from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import { Button, cx, ErrorText, formatDate } from "./components/ui";
import { DOCUMENT_PANE_KEY } from "./prefs";
import { SidePane } from "./resize";

/** A document to show, scrolled to the cited passage when there is one. */
export type DocumentTarget = Pick<Source, "documentId" | "documentTitle"> &
  Partial<Pick<Source, "passageId" | "quote">>;

/**
 * Marks the quote the way the server checked it: any case and spacing, `…` between parts. The
 * first `bold` characters are set bold, as a label such as `Größe:` is on the page.
 */
export function highlight(text: string, quote: string | undefined, bold = 0): ReactNode {
  const parts = (quote ?? "")
    .split(/\.{3}|…/)
    .map((part) => part.trim().replace(/^[\s,;:.]+|[\s,;:.]+$/g, ""))
    .filter(Boolean)
    .map((part) =>
      part
        .split(/\s+/)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
    );
  const marks =
    parts.length === 0
      ? []
      : [...text.matchAll(new RegExp(parts.join("|"), "gi"))].map((m): [number, number] => [
          m.index ?? 0,
          (m.index ?? 0) + m[0].length,
        ]);
  if (marks.length === 0 && bold === 0) return text;
  const cuts = [...new Set([0, bold, ...marks.flat(), text.length])].sort((a, b) => a - b);
  return cuts.slice(1).map((end, index) => {
    const start = cuts[index] ?? 0;
    const piece = text.slice(start, end);
    const node = marks.some(([from, to]) => from <= start && end <= to) ? (
      <mark>{piece}</mark>
    ) : (
      piece
    );
    return <Fragment key={start}>{end <= bold ? <b>{node}</b> : node}</Fragment>;
  });
}

/** A page in CSS pixels at 100 %: A4's 1 : √2, the type a little larger than print to read on screen. */
const PAGE = { width: 520, height: 735, top: 40, side: 44, bottom: 46, gap: 16 };
const LETTERHEAD = 64;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const [MIN_ZOOM, MAX_ZOOM] = [0.5, 2];
/** Room around the pages inside the panel. */
const GUTTER = 16;
/** The letter's own type on white paper in every theme, as the hospital prints it. */
const PAPER = "bg-white font-paper text-[11.5px] leading-[1.45] text-[#1f1f22]";
const SHEET =
  "shadow-[0_0_0_1px_rgb(0_0_0/0.04),0_1px_3px_rgb(0_0_0/0.08),0_10px_28px_rgb(0_0_0/0.07)]";
/** The cited passage: a highlighter tint that fades in; a bar marks its lines in the margin. */
const CITED = "bg-accent-wash motion-safe:animate-paper-cite";
/** A line that opens with a label, such as `Größe: 170 cm`, sets the label bold. */
const LABEL = /^[^:]{2,40}:(?=\s)/;
/** The dose columns of a medication table: morning, midday, evening and night. */
const SLOT = /^(?:mo|mi|ab|na)$/i;

const KIND: Record<Exclude<LetterBlock["kind"], "table">, string> = {
  address: "",
  date: "text-right",
  title: "text-[15px] leading-snug font-bold",
  heading: "font-bold",
  text: "",
  closing: "",
  signature: "",
};

/** What pages are cut between: one line, one table row, or a whole address. */
type Unit = {
  block: number;
  line: number;
  gap: number;
  keep: boolean;
  newPage: boolean;
  /** A table row under the head row, which a page it starts repeats. */
  row: boolean;
};
type Sheet = { units: number[]; height: number };
type Shared = { passages: Map<string, Passage>; target: DocumentTarget };

/** Space before a block in page pixels, standing in for the letter's blank lines. */
function gapBefore(block: LetterBlock, previous: LetterBlock | undefined): number {
  if (!previous) return 0;
  if (block.kind === "title") return 24;
  if (block.kind === "signature") return 30;
  if (block.kind === "closing") return 16;
  if (block.kind === "heading") return block.spaced ? 15 : 4;
  return block.spaced ? 12 : previous.kind === "heading" ? 2 : 0;
}

function unitsOf(blocks: LetterBlock[]): Unit[] {
  return blocks.flatMap((block, index) => {
    const count =
      block.kind === "table"
        ? block.rows.length + 1
        : block.kind === "address"
          ? 1
          : block.lines.length;
    const keep = ["table", "heading", "title", "closing"].includes(block.kind);
    return Array.from({ length: count }, (_, line) => ({
      block: index,
      line,
      gap: line === 0 ? gapBefore(block, blocks[index - 1]) : 0,
      keep: line === 0 && keep,
      newPage: line === 0 && Boolean(block.newPage),
      row: block.kind === "table" && line > 0,
    }));
  });
}

/** Fills A4 pages in reading order; a heading moves on with the line after it, an enclosure starts a page. */
function paginate(units: Unit[], heights: number[]): Sheet[] {
  const sheets: Sheet[] = [];
  let used = 0;
  units.forEach((unit, index) => {
    const sheet = sheets.at(-1);
    const head = sheets.length === 1 ? LETTERHEAD : 0;
    const height = heights[index] ?? 0;
    // A run of headings needs room for the first line under the last of them.
    let after = 0;
    for (let next = index; units[next]?.keep && next + 1 < units.length; next++)
      after += (units[next + 1]?.gap ?? 0) + (heights[next + 1] ?? 0);
    if (
      sheet &&
      !unit.newPage &&
      used + unit.gap + height + after <= PAGE.height - PAGE.top - PAGE.bottom - head
    ) {
      sheet.units.push(index);
      used += unit.gap + height;
    } else {
      sheets.push({ units: [index], height: 0 });
      used = (unit.row ? (heights[index - unit.line] ?? 0) : 0) + height;
    }
    const current = sheets.at(-1) as Sheet;
    const letterhead = sheets.length === 1 ? LETTERHEAD : 0;
    current.height = Math.max(PAGE.height, PAGE.top + PAGE.bottom + letterhead + used);
  });
  return sheets;
}

/** A page's units grouped by block, so a block split over two pages draws its part on each. */
function fragmentsOf(units: Unit[], sheet: Sheet) {
  const fragments: { block: number; lines: number[]; gap: number }[] = [];
  for (const index of sheet.units) {
    const unit = units[index] as Unit;
    const last = fragments.at(-1);
    if (last?.block === unit.block) last.lines.push(unit.line);
    else fragments.push({ block: unit.block, lines: [unit.line], gap: last ? unit.gap : 0 });
  }
  return fragments;
}

function Line({
  ids,
  unit,
  label,
  shared: { passages, target },
}: {
  ids: string[];
  unit: boolean;
  label: boolean;
  shared: Shared;
}) {
  return (
    <div data-unit={unit || undefined}>
      {ids.map((id, index) => {
        const text = passages.get(id)?.text ?? "";
        const isCited = id === target.passageId;
        const bold = label && index === 0 ? (LABEL.exec(text)?.[0].length ?? 0) : 0;
        return (
          <Fragment key={id}>
            {index > 0 && " "}
            <span
              data-passage={id}
              className={isCited ? cx(CITED, "rounded-[2px] box-decoration-clone") : undefined}
            >
              {highlight(text, isCited ? target.quote : undefined, bold)}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function Table({
  block,
  lines,
  style,
  shared: { target },
}: {
  block: Extract<LetterBlock, { kind: "table" }>;
  lines: number[];
  style?: CSSProperties;
  shared: Shared;
}) {
  const rows: LetterRow[] = [block.head, ...block.rows];
  const heads = block.head.cells;
  // The part of a table continued from the page before repeats the column heads, as print does.
  const continued = lines[0] !== 0;
  return (
    <table style={style} className="w-full table-fixed border-collapse text-[10.5px]">
      <colgroup>
        {heads.map((head, column) => (
          <col
            // biome-ignore lint/suspicious/noArrayIndexKey: the table's fixed columns
            key={column}
            className={cx(
              column > 0 &&
                (SLOT.test(head) ? "w-[2.4em]" : column === 1 ? "w-[6.4em]" : "w-[4.6em]"),
            )}
          />
        ))}
      </colgroup>
      <tbody>
        {(continued ? [0, ...lines] : lines).map((index, position) => {
          const row = rows[index] as LetterRow;
          const repeated = continued && position === 0;
          const cited = !repeated && row.passageId === target.passageId;
          return (
            <tr
              key={repeated ? "heads" : row.passageId}
              data-unit={repeated ? undefined : true}
              data-passage={repeated ? undefined : row.passageId}
              className={cx(index === 0 && "font-bold", cited && CITED)}
            >
              {row.cells.map((cell, column) => {
                const span = column === row.cells.length - 1 ? heads.length - column : 1;
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells of one fixed row
                    key={column}
                    colSpan={span > 1 ? span : undefined}
                    className={cx(
                      "border-b px-1 py-[3px] align-top first:pl-0",
                      index === 0 ? "border-[#1f1f22]/60" : "border-[#1f1f22]/10",
                      span === 1 && SLOT.test(heads[column] ?? "") && "text-center",
                    )}
                  >
                    {highlight(cell, cited ? target.quote : undefined)}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Block({
  block,
  lines,
  gap,
  shared,
}: {
  block: LetterBlock;
  /** The block's lines on this page; all of them when it is measured. */
  lines?: number[];
  gap: number;
  shared: Shared;
}) {
  const style = gap ? { marginTop: gap } : undefined;
  if (block.kind === "table")
    return (
      <Table
        block={block}
        lines={lines ?? [...Array(block.rows.length + 1).keys()]}
        style={style}
        shared={shared}
      />
    );
  const whole = block.kind === "address";
  const shown = whole || !lines ? block.lines : lines.map((index) => block.lines[index] ?? []);
  return (
    <div style={style} data-unit={whole || undefined} className={KIND[block.kind] || undefined}>
      {shown.map((ids) => (
        <Line
          key={ids.join()}
          ids={ids}
          unit={!whole}
          label={block.kind === "text"}
          shared={shared}
        />
      ))}
    </div>
  );
}

/** Where the cited passage's lines stand on its page, for the bar in the margin. */
type Bar = { page: number; top: number; height: number };

function PageSheet({
  document,
  number,
  count,
  height,
  bar,
  children,
}: {
  document: PatientDocument;
  number: number;
  count: number;
  height: number;
  bar?: Bar;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={`Page ${number} of ${count}`}
      className={cx(PAPER, SHEET, "relative")}
      style={{ height, padding: `${PAGE.top}px ${PAGE.side}px ${PAGE.bottom}px` }}
    >
      {bar && (
        <span
          aria-hidden
          className="absolute w-[3px] rounded-full bg-accent"
          style={{ left: PAGE.side - 14, top: bar.top, height: bar.height }}
        />
      )}
      {number === 1 && (
        <header
          className="flex flex-col justify-end border-b border-[#1f1f22]/60 pb-2"
          style={{ height: LETTERHEAD - 18, marginBottom: 18 }}
        >
          {document.hospital && (
            <p className="text-[15px] leading-tight font-bold tracking-[-0.01em]">
              {document.hospital}
            </p>
          )}
          <p className="text-[10.5px] text-[#5b5b60]">{document.department}</p>
        </header>
      )}
      {children}
      <footer
        className="absolute bottom-4 flex justify-between gap-4 text-[9px] text-[#8b8b90]"
        style={{ left: PAGE.side, right: PAGE.side }}
      >
        <span className="truncate">
          {document.title} · {formatDate(document.date)}
        </span>
        <span className="shrink-0 tabular-nums">
          Seite {number} von {count}
        </span>
      </footer>
    </section>
  );
}

/** The letter as its printed pages: measured once at page width, then cut into A4 sheets. */
function Letter({
  document,
  target,
  scale,
  onSheets,
}: {
  document: PatientDocument;
  target: DocumentTarget;
  scale: number;
  onSheets: (heights: number[]) => void;
}) {
  const blocks = useMemo<LetterBlock[]>(
    () =>
      document.layout ??
      document.passages.map((p) => ({ kind: "text", spaced: false, lines: [[p.id]] })),
    [document],
  );
  const passages = useMemo(() => new Map(document.passages.map((p) => [p.id, p])), [document]);
  const units = useMemo(() => unitsOf(blocks), [blocks]);
  const shared: Shared = { passages, target };
  const measure = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const [sheets, setSheets] = useState<Sheet[]>();
  const [bar, setBar] = useState<Bar>();

  useLayoutEffect(() => {
    const element = measure.current;
    if (!element) return;
    const cells = [...element.querySelectorAll<HTMLElement>("[data-unit]")];
    const laid = paginate(
      units,
      cells.map((cell) => cell.getBoundingClientRect().height),
    );
    setSheets(laid);
    onSheets(laid.map((sheet) => sheet.height));
  }, [units, onSheets]);

  // The bar spans the cited passage's own lines, not the whole paragraph it stands in.
  useLayoutEffect(() => {
    const root = sheets ? pages.current : null;
    const cited =
      root && target.passageId
        ? root.querySelector(`[data-passage="${CSS.escape(target.passageId)}"]`)
        : null;
    const sheet = cited?.closest("section");
    const lines = cited ? [...cited.getClientRects()] : [];
    const [first, last] = [lines[0], lines.at(-1)];
    if (!root || !sheet || !first || !last) setBar(undefined);
    else {
      const top = sheet.getBoundingClientRect().top;
      setBar({
        page: [...root.children].indexOf(sheet),
        top: (first.top - top) / scale,
        height: (last.bottom - first.top) / scale,
      });
    }
  }, [sheets, target, scale]);

  useEffect(() => {
    if (!sheets || !target.passageId) return;
    pages.current
      ?.querySelector(`[data-passage="${CSS.escape(target.passageId)}"]`)
      ?.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: scrolled.current ? "smooth" : "instant",
      });
    scrolled.current = true;
  }, [sheets, target]);

  if (!sheets)
    return (
      <div
        ref={measure}
        aria-hidden
        className={cx(PAPER, "pointer-events-none invisible absolute top-0 left-0")}
        style={{ width: PAGE.width - 2 * PAGE.side }}
      >
        {blocks.map((block, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one fixed letter
          <Block key={index} block={block} gap={0} shared={shared} />
        ))}
      </div>
    );

  const total =
    sheets.reduce((sum, sheet) => sum + sheet.height, 0) + PAGE.gap * (sheets.length - 1);
  return (
    <div className="mx-auto" style={{ width: PAGE.width * scale, height: total * scale }}>
      <div
        ref={pages}
        className="flex origin-top-left flex-col"
        style={{ width: PAGE.width, gap: PAGE.gap, transform: `scale(${scale})` }}
      >
        {sheets.map((sheet, index) => (
          <PageSheet
            key={sheet.units[0]}
            document={document}
            number={index + 1}
            count={sheets.length}
            height={sheet.height}
            bar={bar?.page === index ? bar : undefined}
          >
            {fragmentsOf(units, sheet).map((fragment) => (
              <Block
                key={`${fragment.block}-${fragment.lines[0]}`}
                block={blocks[fragment.block] as LetterBlock}
                lines={fragment.lines}
                gap={fragment.gap}
                shared={shared}
              />
            ))}
          </PageSheet>
        ))}
      </div>
    </div>
  );
}

export function DocumentPanel({
  target,
  onClose,
}: {
  target: DocumentTarget;
  onClose: () => void;
}) {
  const [document, setDocument] = useState<PatientDocument>();
  const [error, setError] = useState<string>();
  /** A chosen zoom; none fits the page to the panel's width. */
  const [zoom, setZoom] = useState<number>();
  const [width, setWidth] = useState(0);
  const [sheets, setSheets] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  /** The middle of the view as a share of the pages' width and height. */
  const center = useRef<{ x: number; y: number }>(undefined);

  useEffect(() => {
    setError(undefined);
    setSheets([]);
    setPage(1);
    center.current = undefined;
    api.document(target.documentId).then(setDocument, (e: Error) => setError(e.message));
  }, [target.documentId]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.min(1.25, Math.max(MIN_ZOOM, (width - 2 * GUTTER) / PAGE.width));
  const scale = zoom ?? fit;

  // A new zoom keeps the middle of the view where it was, as a PDF viewer does.
  const shownScale = useRef(scale);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (shownScale.current === scale || !element) return;
    shownScale.current = scale;
    const { x = 0.5, y } = center.current ?? {};
    element.scrollLeft = x * element.scrollWidth - element.clientWidth / 2;
    if (y !== undefined) element.scrollTop = y * element.scrollHeight - element.clientHeight / 2;
  }, [scale]);

  function onScroll() {
    const element = viewport.current;
    if (!element) return;
    const middle = element.scrollTop + element.clientHeight / 2;
    center.current = {
      x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
      y: middle / element.scrollHeight,
    };
    // The page in the middle of the view is the current one, as the cited passage is centred there.
    let bottom = GUTTER;
    let current = 1;
    for (const height of sheets.slice(0, -1)) {
      bottom += (height + PAGE.gap) * scale;
      if (middle < bottom) break;
      current++;
    }
    setPage(current);
  }

  const shown = document?.id === target.documentId ? document : undefined;

  return (
    <SidePane label="Source document" storageKey={DOCUMENT_PANE_KEY} share={0.44}>
      <header className="flex items-center gap-1.5 pt-4 pr-3 pb-3 pl-5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold tracking-tight">{target.documentTitle}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {shown ? `${formatDate(shown.date)} · ${shown.type} · ${shown.department}` : "…"}
          </p>
        </div>
        {sheets.length > 0 && (
          <span className="mr-1.5 shrink-0 text-xs text-muted-foreground tabular-nums">
            {page} / {sheets.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={scale <= MIN_ZOOM}
          onClick={() => setZoom(ZOOMS.filter((z) => z < scale - 0.01).at(-1) ?? MIN_ZOOM)}
        >
          <Minus className="size-3.5" />
        </Button>
        <button
          type="button"
          title="Fit to width"
          aria-label={`Fit to width, now ${Math.round(scale * 100)}%`}
          onClick={() => setZoom(undefined)}
          className="h-8 min-w-11 shrink-0 cursor-pointer rounded-lg text-xs text-muted-foreground tabular-nums transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
        >
          {Math.round(scale * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={() => setZoom(ZOOMS.find((z) => z > scale + 0.01) ?? MAX_ZOOM)}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close document" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div
        ref={viewport}
        onScroll={onScroll}
        className="relative flex-1 overflow-auto [scrollbar-gutter:stable]"
      >
        <div style={{ padding: GUTTER }}>
          {error && <ErrorText title="The document could not be loaded." reason={error} />}
          {shown && width > 0 ? (
            <Letter
              key={shown.id}
              document={shown}
              target={target}
              scale={scale}
              onSheets={setSheets}
            />
          ) : (
            !error && (
              <div
                aria-busy
                className={cx(SHEET, "mx-auto flex flex-col gap-[2.4%] bg-white p-[8.5%]")}
                style={{ width: PAGE.width * fit, height: PAGE.height * fit }}
              >
                {[46, 30, 0, 92, 86, 64, 0, 88, 72].map((w, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholder lines
                    key={index}
                    className="skeleton h-[1.3%] bg-black/5"
                    style={{ width: `${w}%`, opacity: w ? undefined : 0 }}
                  />
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </SidePane>
  );
}
