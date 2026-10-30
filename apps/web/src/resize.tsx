import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./components/ui";
import { useStored } from "./prefs";

/** Pixels the pointer travels before a press on a handle becomes a drag. */
const THRESHOLD = 6;
/** How far below its minimum a foldable pane is dragged before it folds. */
const FOLD = 64;
/** One arrow key press. */
const STEP = 24;

type PaneDragOptions = {
  /** The pane's width in pixels as it is on screen now. */
  measure: () => number;
  min: number;
  /** The widest the pane may get at this window size. */
  max: () => number;
  /** The way the pointer moves to widen the pane. */
  grows: "left" | "right";
  /** The width a double-click puts back. */
  reset: () => number;
  /** Each width while dragging, written straight to the page so nothing re-renders; null puts back the saved one. */
  onDrag: (width: number | null) => void;
  onCommit: (width: number) => void;
  /** When given, dragging well below the minimum folds the pane, shown meanwhile through `folding`. */
  onFold?: () => void;
};

export type PaneDrag = ReturnType<typeof usePaneDrag>;

/** Marlene's pane gestures: drag, Escape to cancel, arrows, Home and End, double-click to reset. */
export function usePaneDrag(options: PaneDragOptions) {
  const [dragging, setDragging] = useState(false);
  const [folding, setFolding] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const cleanup = useRef<() => void>(undefined);
  useEffect(() => () => cleanup.current?.(), []);

  const clamp = (value: number) => {
    const { min, max } = latest.current;
    return Math.round(Math.min(Math.max(min, max()), Math.max(min, value)));
  };

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || cleanup.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    const { measure, min, grows, onFold } = latest.current;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const start = measure();
    let current = start;
    let started = false;
    // A folded pane starts folded, so a short drag leaves it as it was.
    let folded = onFold !== undefined && start < min - FOLD;
    const body = document.body.style;
    const previous = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = "col-resize";
    body.userSelect = "none";
    setDragging(true);
    setFolding(folded);

    const finish = (cancelled: boolean) => {
      cleanup.current?.();
      setDragging(false);
      setFolding(false);
      const { onDrag, onCommit } = latest.current;
      if (cancelled || !started) onDrag(null);
      else if (folded) {
        onDrag(null);
        latest.current.onFold?.();
      } else onCommit(current);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const delta = (e.clientX - startX) * (grows === "right" ? 1 : -1);
      if (!started && Math.abs(delta) < THRESHOLD) return;
      started = true;
      const proposed = start + delta;
      const fold = latest.current.onFold !== undefined && proposed < latest.current.min - FOLD;
      if (!fold) {
        current = clamp(proposed);
        latest.current.onDrag(current);
      }
      if (fold !== folded) {
        folded = fold;
        setFolding(fold);
      }
    };
    const up = (e: globalThis.PointerEvent) => e.pointerId === pointerId && finish(false);
    const cancelPointer = (e: globalThis.PointerEvent) => e.pointerId === pointerId && finish(true);
    const cancel = () => finish(true);
    // Captured first, so the Escape that cancels the drag does not also close a panel.
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    };
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      body.cursor = previous.cursor;
      body.userSelect = previous.userSelect;
      cleanup.current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const { measure, min, max, grows, onCommit } = latest.current;
    const step = event.key === "ArrowRight" ? STEP : event.key === "ArrowLeft" ? -STEP : 0;
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max()
          : step
            ? measure() + (grows === "right" ? step : -step)
            : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onCommit(clamp(next));
  }

  return {
    dragging,
    folding,
    onPointerDown,
    onKeyDown,
    onDoubleClick: () => latest.current.onCommit(clamp(latest.current.reset())),
  };
}

/** The grip on a pane's edge; it overlaps the seam, so it takes no room of its own. */
export function ResizeHandle({
  label,
  drag,
  value,
  min,
  max,
  controls,
  onKeyDown,
  className,
}: {
  label: string;
  drag: PaneDrag;
  value: number;
  min: number;
  max: number;
  controls?: string;
  /** Runs first; a key it marks handled skips the resizing keys. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter; <hr> cannot take focus or keys
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-controls={controls}
      tabIndex={0}
      data-dragging={drag.dragging || undefined}
      onPointerDown={drag.onPointerDown}
      onDoubleClick={drag.onDoubleClick}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) drag.onKeyDown(event);
      }}
      title="Drag to resize · double-click to reset"
      className={cx(
        "group relative z-10 flex w-2.5 shrink-0 cursor-col-resize touch-none items-center justify-center select-none focus-visible:shadow-none",
        className,
      )}
    >
      <span
        aria-hidden
        className="h-8 w-1 rounded-full bg-foreground/10 transition-colors duration-150 group-hover:bg-foreground/35 group-focus-visible:bg-accent-text group-focus-visible:shadow-[0_0_0_2px_var(--chrome),0_0_0_4px_var(--accent-text)] group-data-dragging:bg-accent motion-reduce:transition-none"
      />
    </div>
  );
}

const PANE = { min: 320, max: 0.7 };

/** A panel beside the screen; its width is kept as a share of the row, so it follows the window. */
export function SidePane({
  label,
  storageKey,
  share: initial,
  children,
}: {
  label: string;
  storageKey: string;
  share: number;
  children: ReactNode;
}) {
  const [share, setShare] = useStored(storageKey, initial);
  const pane = useRef<HTMLElement>(null);
  const row = () => pane.current?.parentElement?.clientWidth ?? window.innerWidth;
  const show = (width: string) => pane.current?.style.setProperty("--pane-width", width);
  const drag = usePaneDrag({
    measure: () => pane.current?.getBoundingClientRect().width ?? 0,
    min: PANE.min,
    max: () => row() * PANE.max,
    grows: "left",
    reset: () => row() * initial,
    onDrag: (width) => show(width === null ? `${share * 100}%` : `${width}px`),
    onCommit: (width) => {
      const next = width / row();
      show(`${next * 100}%`);
      setShare(next);
    },
  });
  const width = share * row();
  return (
    <>
      <ResizeHandle
        label={`Resize ${label.toLowerCase()}`}
        drag={drag}
        value={width}
        min={PANE.min}
        max={row() * PANE.max}
        className="hidden lg:-mr-2.5 lg:flex"
      />
      <aside
        ref={pane}
        aria-label={label}
        style={{ "--pane-width": `${share * 100}%` } as CSSProperties}
        className="fixed inset-0 z-50 flex flex-col bg-recessed lg:static lg:z-auto lg:w-(--pane-width) lg:min-w-80 lg:max-w-[70%]"
      >
        {children}
      </aside>
    </>
  );
}
