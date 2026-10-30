import type { DocumentInfo, PatientDocument } from "@track1/shared";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, formatDate } from "./components/ui";
import { type DocumentTarget, highlight } from "./DocumentPanel";
import { loadDocument } from "./SourcePopover";

/**
 * Searches every passage of the patient's documents, so the doctor is not limited to the screen.
 * Shows only a search icon until it is clicked or `/` is pressed.
 */
export function RecordSearch({
  documents,
  onOpen,
}: {
  documents: DocumentInfo[];
  onOpen: (target: DocumentTarget) => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<PatientDocument[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused || loaded.length > 0) return;
    Promise.all(documents.map((d) => loadDocument(d.id))).then(setLoaded, () => {});
  }, [focused, loaded.length, documents]);

  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select");
      if (e.key === "/" && !typing) {
        e.preventDefault();
        setOpen(true);
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", slash);
    return () => document.removeEventListener("keydown", slash);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open)
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search all documents"
        title="Search all documents (/)"
        onClick={() => setOpen(true)}
      >
        <Search className="size-3.5" />
      </Button>
    );

  const q = query.trim().toLowerCase();
  const hits =
    q.length < 2
      ? []
      : loaded
          .flatMap((d) =>
            d.passages.filter((p) => p.text.toLowerCase().includes(q)).map((p) => ({ d, p })),
          )
          .slice(0, 12);

  return (
    <div className="relative">
      <label className="flex w-[250px] items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-[7px] text-[13px] transition-colors duration-150 focus-within:bg-hover/60 has-focus-visible:shadow-[0_0_0_2px_var(--accent-text)]">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() =>
            setTimeout(() => {
              setFocused(false);
              if (!input.current?.value) setOpen(false);
            }, 150)
          }
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            if (query) setQuery("");
            else input.current?.blur();
          }}
          placeholder={`Search her ${documents.length} documents`}
          aria-label="Search all documents"
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
        />
        <kbd className="font-mono text-2xs text-muted-foreground">/</kbd>
      </label>
      {focused && q.length >= 2 && (
        <div className="ui-enter-up absolute top-full right-0 z-40 mt-1.5 max-h-96 w-[28rem] overflow-y-auto rounded-xl bg-surface p-1.5 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border">
          {loaded.length === 0 && <p className="p-2 text-muted-foreground">Loading documents…</p>}
          {loaded.length > 0 && hits.length === 0 && (
            <p className="p-2 text-muted-foreground">No passage contains “{query.trim()}”.</p>
          )}
          {hits.map(({ d, p }) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                onOpen({ documentId: d.id, documentTitle: d.title, passageId: p.id, quote: query })
              }
              className="block w-full cursor-pointer rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <span className="block text-2xs text-muted-foreground">
                {d.title} · {formatDate(d.date)}
                {p.section ? ` · ${p.section}` : ""}
              </span>
              <span className="line-clamp-2 leading-relaxed">{highlight(p.text, query)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
