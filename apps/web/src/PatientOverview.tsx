import type {
  Contradiction,
  OverviewResponse,
  PatientSummary,
  Source,
  Trend,
  TrendPoint,
} from "@track1/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Badge, cx, formatDate } from "./components/ui";
import type { DocumentTarget } from "./DocumentPanel";

const overviews = new Map<string, Promise<OverviewResponse>>();

/** Each patient's overview is fetched once per page load; it changes only with the documents. */
function loadOverview(patientId: string): Promise<OverviewResponse> {
  let pending = overviews.get(patientId);
  if (!pending) {
    pending = api.overview(patientId);
    pending.catch(() => overviews.delete(patientId));
    overviews.set(patientId, pending);
  }
  return pending;
}

/** The office thresholds for high blood pressure, systolic and diastolic, drawn on its chart. */
const PRESSURE_LINES = [140, 90];

const monthYear = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

/** Each passage's contradictions, with the words each one quotes from it. */
type Conflicts = Map<string, { contradiction: Contradiction; quote: string }[]>;

/**
 * The contradiction that quotes this value, such as a BMI that does not match the weight. One
 * about other words of the same sentence, such as a stenosis's side, is not about the value.
 */
function conflictOf(point: TrendPoint, conflicts: Conflicts): Contradiction | undefined {
  for (const source of point.sources) {
    const value = source.quote.toLowerCase();
    const found = conflicts.get(source.passageId)?.find(({ quote }) => {
      const quoted = quote.toLowerCase();
      return value.includes(quoted) || quoted.includes(value);
    });
    if (found) return found.contradiction;
  }
  return undefined;
}

/**
 * What the documents say about the patient at a glance, below the scenario box: counts, every
 * measurement over time and the values stated once. Every value opens the passage it comes from.
 */
export function PatientOverview({
  patient,
  onOpenLetter,
}: {
  patient: PatientSummary;
  onOpenLetter: (target: DocumentTarget) => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; overview?: OverviewResponse }>();
  useEffect(() => {
    let current = true;
    loadOverview(patient.id).then(
      (overview) => {
        if (current) setLoaded({ id: patient.id, overview });
      },
      () => {
        if (current) setLoaded({ id: patient.id });
      },
    );
    return () => {
      current = false;
    };
  }, [patient.id]);

  const done = loaded?.id === patient.id;
  const overview = done ? loaded.overview : undefined;
  // Without an overview the start page stays as it was; the scenario box does not need it.
  if (done && !overview) return null;

  return (
    <section aria-labelledby="overview-title" className="mt-14 flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <h2 id="overview-title" className="text-sm font-semibold tracking-tight">
          Overview
        </h2>
        <p className="text-xs text-muted-foreground">
          From the documents · select a value to open its passage
        </p>
      </div>
      {overview ? (
        <Loaded patient={patient} overview={overview} onOpenLetter={onOpenLetter} />
      ) : (
        <div className="flex flex-col gap-3" aria-busy>
          <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-[84px] rounded-xl" />
            ))}
          </div>
          <div className="grid gap-3 @3xl:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-[212px] rounded-xl" />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Loaded({
  patient,
  overview,
  onOpenLetter,
}: {
  patient: PatientSummary;
  overview: OverviewResponse;
  onOpenLetter: (target: DocumentTarget) => void;
}) {
  const { vitals, basics, contradictions } = overview;
  const conflicts: Conflicts = new Map();
  for (const contradiction of contradictions)
    for (const { passageId, quote } of contradiction.passages)
      conflicts.set(passageId, [...(conflicts.get(passageId) ?? []), { contradiction, quote }]);
  const years = [...new Set(patient.documents.map((d) => d.date.slice(0, 4)))].sort();
  const stays = new Set(patient.documents.flatMap((d) => (d.stay ? [d.stay.id] : []))).size;
  const [allergy] = basics.allergies;
  const listDate = basics.medication[0]?.date;
  const charted = vitals.filter((t) => t.points.length > 1);
  const once = vitals.filter((t) => t.points.length === 1);

  return (
    <>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        <Tile
          label="Documents"
          value={patient.documents.length}
          sub={[
            stays > 0 && `${stays} ${stays === 1 ? "stay" : "stays"}`,
            years.length > 1 ? `${years[0]}–${years.at(-1)}` : years[0],
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        <Tile
          label="Medication"
          value={basics.medication.length}
          sub={listDate ? `latest list, ${formatDate(listDate)}` : "no list in the documents"}
          source={basics.medication[0]?.sources[0]}
          onOpen={onOpenLetter}
        />
        <Tile
          tone={allergy ? "danger" : "neutral"}
          label={basics.allergies.length > 1 ? `Allergies (${basics.allergies.length})` : "Allergy"}
          value={allergy?.label ?? "None documented"}
          sub={allergy ? allergy.value : "no document names one"}
          source={allergy?.sources[0]}
          onOpen={onOpenLetter}
        />
        <Tile
          tone={contradictions.length > 0 ? "warning" : "neutral"}
          label="Contradictions"
          value={contradictions.length}
          sub="in the documents"
          title={contradictions.map((c) => `• ${c.summary}`).join("\n")}
        />
      </div>
      {charted.length > 0 && (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {charted.map((trend) => (
            <TrendCard key={trend.kind} trend={trend} conflicts={conflicts} onOpen={onOpenLetter} />
          ))}
        </div>
      )}
      {once.length > 0 && (
        <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
          {once.map((trend) => {
            const [point] = trend.points;
            return point ? (
              <Tile
                key={trend.kind}
                label={trend.label}
                value={point.display}
                sub={`only value, ${formatDate(point.date)}`}
                source={point.sources[0]}
                onOpen={onOpenLetter}
              />
            ) : null;
          })}
        </div>
      )}
    </>
  );
}

const TILE_TONES = {
  neutral: "border border-border hover:[button&]:bg-surface-2",
  warning: "bg-warning-wash [&_strong]:text-warning hover:[button&]:opacity-85",
  danger: "bg-destructive-wash [&_strong]:text-destructive hover:[button&]:opacity-85",
} as const;

function Tile({
  label,
  value,
  sub,
  tone = "neutral",
  title,
  source,
  onOpen,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: keyof typeof TILE_TONES;
  title?: string;
  source?: Source;
  onOpen?: (target: DocumentTarget) => void;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <strong className="mt-1 truncate text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </strong>
      {sub && <span className="mt-0.5 truncate text-2xs text-muted-foreground">{sub}</span>}
    </>
  );
  const className = cx("flex min-w-0 flex-col rounded-xl px-4 py-3 text-left", TILE_TONES[tone]);
  return source && onOpen ? (
    <button
      type="button"
      onClick={() => onOpen(source)}
      title={title ?? `Open the passage in the ${source.documentTitle}`}
      className={cx(className, "cursor-pointer transition-[background-color,opacity] duration-150")}
    >
      {body}
    </button>
  ) : (
    <div className={className} title={title}>
      {body}
    </div>
  );
}

function TrendCard({
  trend,
  conflicts,
  onOpen,
}: {
  trend: Trend;
  conflicts: Conflicts;
  onOpen: (target: DocumentTarget) => void;
}) {
  const last = trend.points.at(-1);
  const flagged = trend.points.filter((p) => conflictOf(p, conflicts)).length;
  const source = last?.sources[0];
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border px-4 pt-3 pb-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{trend.label}</h3>
        {trend.change && (
          <Badge className="truncate tabular-nums">{trend.change}, calculated</Badge>
        )}
      </div>
      {last && source && (
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={() => onOpen(source)}
            title={`Open the passage in the ${source.documentTitle}`}
            className="cursor-pointer text-xl font-semibold tracking-tight whitespace-nowrap tabular-nums hover:text-accent-text"
          >
            {last.display}
          </button>
          <span className="text-2xs text-muted-foreground tabular-nums">
            {formatDate(last.date)}
          </span>
          {flagged > 0 && (
            <Badge tone="danger" className="ml-auto self-center">
              {flagged} in a contradiction
            </Badge>
          )}
        </p>
      )}
      <TrendChart trend={trend} conflicts={conflicts} onOpen={onOpen} />
      {trend.kind === "bp" && (
        <p className="flex flex-wrap gap-x-3 pb-1 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-accent-text" />
            Systolic
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded bg-accent-text/45" />
            Diastolic
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 border-t border-dashed border-warning" />
            {PRESSURE_LINES.join("/")} mmHg
          </span>
        </p>
      )}
    </div>
  );
}

const HEIGHT = 128;
const PAD = { left: 30, right: 12, top: 16, bottom: 22 };

/** Ticks at a round step, three or four of them, spanning the values. */
function ticks(values: number[]): number[] {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const list: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step)
    list.push(Math.round(v * 100) / 100);
  return list;
}

function useWidth<T extends Element>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The values in the order the documents give them, at equal steps: the letters come in stays
 * months apart, so a time axis would stack each stay's values on one spot.
 */
function TrendChart({
  trend,
  conflicts,
  onOpen,
}: {
  trend: Trend;
  conflicts: Conflicts;
  onOpen: (target: DocumentTarget) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { points } = trend;
  const lines = trend.kind === "bp" ? PRESSURE_LINES : [];
  const scale = ticks([...points.flatMap((p) => [p.value, p.secondary ?? p.value]), ...lines]);
  const lo = scale[0] ?? 0;
  const hi = scale.at(-1) ?? 1;
  const right = width - PAD.right;
  const x = (i: number) =>
    points.length === 1
      ? (PAD.left + right) / 2
      : PAD.left + (i * (right - PAD.left)) / (points.length - 1);
  const y = (v: number) => PAD.top + ((hi - v) * (HEIGHT - PAD.top - PAD.bottom)) / (hi - lo);
  const path = (get: (p: TrendPoint) => number | undefined) =>
    points
      .flatMap((p, i) => {
        const v = get(p);
        return v === undefined ? [] : [`${x(i)},${y(v)}`];
      })
      .join(" ");
  const labelled = points.length <= 4;

  return (
    <div ref={ref} className="mt-2 min-w-0">
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          aria-label={`${trend.label} over time`}
          className="block overflow-visible"
        >
          {scale.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={right} y1={y(v)} y2={y(v)} className="stroke-border" />
              <text
                x={PAD.left - 8}
                y={y(v) + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {v}
              </text>
            </g>
          ))}
          {lines.map((v) => (
            <line
              key={v}
              x1={PAD.left}
              x2={right}
              y1={y(v)}
              y2={y(v)}
              strokeDasharray="4 4"
              className="stroke-warning"
            />
          ))}
          {points.map((p, i) => {
            const label = monthYear(p.date);
            return label !== (points[i - 1] && monthYear(points[i - 1]?.date ?? "")) ? (
              <text
                key={p.date}
                x={x(i)}
                y={HEIGHT - 4}
                textAnchor={i === 0 && points.length > 1 ? "start" : "middle"}
                className="fill-muted-foreground text-[10px]"
              >
                {label}
              </text>
            ) : null;
          })}
          {points.some((p) => p.secondary !== undefined) && (
            <polyline
              points={path((p) => p.secondary)}
              fill="none"
              strokeWidth={2}
              strokeLinejoin="round"
              className="stroke-accent-text/45"
            />
          )}
          <polyline
            points={path((p) => p.value)}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            className="stroke-accent-text"
          />
          {points.map((p, i) => {
            const conflict = conflictOf(p, conflicts);
            const [source] = p.sources;
            const open = () => source && onOpen(source);
            const name = `${p.display}, ${formatDate(p.date)}, ${source?.documentTitle ?? ""}`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG point cannot be a <button>; it takes focus and Enter as one
              <g
                key={`${p.date}-${p.display}`}
                role="button"
                tabIndex={0}
                aria-label={`${name}. Open the passage`}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open();
                  }
                }}
                className="group cursor-pointer outline-none"
              >
                <title>
                  {[name, conflict && `In a contradiction: ${conflict.summary}`]
                    .filter(Boolean)
                    .join("\n")}
                </title>
                <circle cx={x(i)} cy={y(p.value)} r={12} className="fill-transparent" />
                {conflict && (
                  <circle
                    cx={x(i)}
                    cy={y(p.value)}
                    r={7.5}
                    fill="none"
                    strokeWidth={1.5}
                    className="stroke-destructive"
                  />
                )}
                <circle
                  cx={x(i)}
                  cy={y(p.value)}
                  r={9}
                  fill="none"
                  strokeWidth={2}
                  className="stroke-accent-text opacity-0 group-focus-visible:opacity-100"
                />
                {p.secondary !== undefined && (
                  <circle
                    cx={x(i)}
                    cy={y(p.secondary)}
                    r={3}
                    className="fill-surface stroke-accent-text/60"
                    strokeWidth={1.5}
                  />
                )}
                <circle
                  cx={x(i)}
                  cy={y(p.value)}
                  r={3.75}
                  strokeWidth={2}
                  className={cx(
                    "stroke-accent-text transition-[r] duration-150 group-hover:[r:5]",
                    conflict ? "fill-destructive" : "fill-surface",
                  )}
                />
                {labelled && (
                  <text
                    x={x(i)}
                    y={y(p.value) - 10}
                    textAnchor="middle"
                    className={cx(
                      "text-[10.5px] font-semibold tabular-nums",
                      conflict ? "fill-destructive" : "fill-foreground",
                    )}
                  >
                    {p.value}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
