import type { Source } from "@track1/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * What the pointer rests on, so each side lights up the other: a line of the screen lights the
 * documents and passages it cites, a document in the timeline lights the lines that cite it.
 */
type Hovered =
  | { from: "screen"; key: string; documents: Set<string>; passages: Set<string> }
  | { from: "record"; key: string; documentId: string };

let hovered: Hovered | undefined;
/** Whether keyboard focus set it, so only a blur from focus clears it. */
let focused = false;
const listeners = new Set<() => void>();

function set(next: Hovered | undefined) {
  if (next?.key === hovered?.key) return;
  hovered = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const useHovered = (select: (h: Hovered | undefined) => boolean) =>
  useSyncExternalStore(subscribe, () => select(hovered));

/** The element's own citations, or the timeline document it stands for. */
function hoveredOf(target: EventTarget | null): Hovered | undefined {
  const element = target instanceof Element ? target.closest("[data-cites],[data-document]") : null;
  if (!(element instanceof HTMLElement)) return undefined;
  const { cites, document: documentId } = element.dataset;
  if (documentId) return { from: "record", key: `record:${documentId}`, documentId };
  const passages = (cites ?? "").split(" ").filter(Boolean);
  if (passages.length === 0) return undefined;
  return {
    from: "screen",
    key: `screen:${cites}`,
    passages: new Set(passages.map((p) => p.slice(p.indexOf("@") + 1))),
    documents: new Set(passages.map((p) => p.slice(0, p.indexOf("@")))),
  };
}

/** A line on the screen that cites the document hovered in the timeline: a tint and a hairline. */
export const LIT =
  "bg-[color-mix(in_oklch,var(--accent)_7%,transparent)] ring-1 ring-[color-mix(in_oklch,var(--accent)_30%,transparent)] ring-inset";

/** Marks an element as citing these sources; hovering or focusing it lights them up. */
export const cites = (sources: readonly Source[]) =>
  sources.length > 0
    ? { "data-cites": sources.map((s) => `${s.documentId}@${s.passageId}`).join(" ") }
    : {};

/** Marks a timeline row as this document; hovering or focusing it lights the lines that cite it. */
export const standsFor = (documentId: string) => ({ "data-document": documentId });

/** Whether the document hovered in the timeline is among these sources. */
export const useCitesHovered = (sources: readonly Source[]) =>
  useHovered((h) => h?.from === "record" && sources.some((s) => s.documentId === h.documentId));

/** Whether what is hovered on the screen cites this document. */
export const useDocumentHovered = (documentId: string) =>
  useHovered((h) => h?.from === "screen" && h.documents.has(documentId));

/** Which of these passages what is hovered on the screen cites. */
export function useHoveredPassages(ids: readonly string[]): ReadonlySet<string> {
  const lit = useSyncExternalStore(subscribe, () => {
    const h = hovered;
    return h?.from === "screen" ? ids.filter((id) => h.passages.has(id)).join(" ") : "";
  });
  return useMemo(() => new Set(lit.split(" ").filter(Boolean)), [lit]);
}

/**
 * Follows the pointer and keyboard focus across the page. One listener on the document, rather
 * than one per element, so a row that disappears under the pointer lights nothing once it moves.
 */
export function useHoverLinks() {
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      focused = false;
      set(hoveredOf(e.target));
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget && !focused) set(undefined);
    };
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof Element && e.target.matches(":focus-visible"))) return;
      focused = true;
      set(hoveredOf(e.target));
    };
    const onBlur = () => {
      if (focused) set(undefined);
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      set(undefined);
    };
  }, []);
}
