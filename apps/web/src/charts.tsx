import type { TrendPoint } from "@track1/shared";
import { formatDate } from "./components/ui";

/** A trend as its line draws it; a point is flagged when a contradiction cites its passage. */
export type TrendChart = {
  points: (TrendPoint & { flagged: boolean })[];
  /** The newest point minus the oldest, such as "−12 kg". */
  change: string;
};

const SPARK = { width: 112, height: 22, pad: 4 };

/**
 * The points in order, evenly spaced, the newest solid. The scale spans at least a fifth of the
 * largest value, so 140 → 145 mmHg reads as the small change it is.
 */
export function Sparkline({ chart }: { chart: TrendChart }) {
  const { width, height, pad } = SPARK;
  const values = chart.points.map((p) => p.value);
  const top = Math.max(...values);
  const bottom = Math.min(...values);
  const span = Math.max(top - bottom, Math.abs(top) * 0.2) || 1;
  const middle = (top + bottom) / 2;
  const step = (width - 2 * pad) / Math.max(1, chart.points.length - 1);
  const dots = chart.points.map((point, i) => ({
    point,
    x: pad + i * step,
    y: pad + ((middle + span / 2 - point.value) / span) * (height - 2 * pad),
  }));
  return (
    <svg
      role="img"
      aria-label={chart.points.map((p) => p.display).join(", ")}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mr-2.5 inline-block shrink-0 overflow-visible align-middle"
    >
      <polyline
        points={dots.map((d) => `${d.x},${d.y}`).join(" ")}
        className="fill-none stroke-accent"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {dots.map(({ point, x, y }, i) => (
        <circle
          key={point.date + point.display}
          cx={x}
          cy={y}
          r={point.flagged ? 3 : i === dots.length - 1 ? 2.6 : 2.2}
          strokeWidth={point.flagged ? 1.75 : 0}
          className={
            point.flagged
              ? "fill-surface stroke-warning"
              : i === dots.length - 1
                ? "fill-foreground"
                : "fill-accent"
          }
        >
          <title>
            {point.display} · {formatDate(point.date)}
            {point.flagged ? " · in a contradiction" : ""}
          </title>
        </circle>
      ))}
    </svg>
  );
}

/** Where a single value sits against a fixed reference, such as an ejection fraction against ≥ 50 %. */
export type Reference = {
  value: number;
  min: number;
  max: number;
  /** The shaded band. */
  from: number;
  to: number;
  text: string;
};

/** General reference ranges, hard-coded like the safety rules; the value always comes from a document. */
const REFERENCES: (Omit<Reference, "value"> & { names: RegExp })[] = [
  {
    names: /ejection fraction|\bLV-?EF\b|\bEF\b/i,
    min: 20,
    max: 80,
    from: 50,
    to: 80,
    text: "normal ≥ 50 %",
  },
  { names: /\bHbA1c\b/i, min: 5, max: 10, from: 5, to: 7, text: "target < 7 %" },
];

/** The reference for a line that states one percentage of a measure the table knows, such as "LVEF 60 %". */
export function referenceOf(label: string, value: string): Reference | undefined {
  const reference = REFERENCES.find((r) => r.names.test(label) || r.names.test(value));
  if (!reference) return undefined;
  const { names, ...rest } = reference;
  const numbers = value.replace(names, "").match(/\d+(?:[.,]\d+)?/g) ?? [];
  const [number] = numbers;
  if (numbers.length !== 1 || !number || !/%/.test(value)) return undefined;
  return { ...rest, value: Number(number.replace(",", ".")) };
}

const BAR = { width: 96, height: 10 };

export function RangeBar({ reference }: { reference: Reference }) {
  const { width, height } = BAR;
  const { min, max } = reference;
  const x = (v: number) => (Math.min(max, Math.max(min, v)) - min) / (max - min);
  return (
    <svg
      role="img"
      aria-label={`${reference.value} %, ${reference.text}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="mr-2.5 inline-block shrink-0 overflow-visible align-middle"
    >
      <title>{reference.text}</title>
      <rect y={2} width={width} height={6} rx={3} className="fill-surface-2" />
      <rect
        x={x(reference.from) * width}
        y={2}
        width={(x(reference.to) - x(reference.from)) * width}
        height={6}
        rx={3}
        className="fill-success/25"
      />
      <rect
        x={x(reference.value) * width - 1.25}
        width={2.5}
        height={height}
        rx={1}
        className="fill-foreground"
      />
    </svg>
  );
}
