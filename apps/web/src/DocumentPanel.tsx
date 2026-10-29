import type { PatientDocument, Source } from "@track1/shared";
import { X } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Button, ErrorText, formatDate } from "./components/ui";

/** A document to show, scrolled to the cited passage when there is one. */
export type DocumentTarget = Pick<Source, "documentId" | "documentTitle"> &
  Partial<Pick<Source, "passageId" | "quote">>;

/** Marks the quote the way the server checked it: any case and spacing, `…` between parts. */
function highlight(text: string, quote: string | undefined): ReactNode {
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
  if (parts.length === 0) return text;
  return text.split(new RegExp(`(${parts.join("|")})`, "gi")).map((piece, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed string
      <mark key={index}>{piece}</mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one fixed string
      <Fragment key={index}>{piece}</Fragment>
    ),
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
  const cited = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setError(undefined);
    api.document(target.documentId).then(setDocument, (e: Error) => setError(e.message));
  }, [target.documentId]);

  useEffect(() => {
    if (document?.id !== target.documentId) return;
    if (cited.current) cited.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [document, target]);

  const shown = document?.id === target.documentId ? document : undefined;

  return (
    <aside
      aria-label="Source document"
      className="fixed inset-0 z-50 flex flex-col bg-recessed lg:static lg:z-auto lg:w-[40%] lg:min-w-80 lg:max-w-xl"
    >
      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold tracking-tight">{target.documentTitle}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {shown ? `${formatDate(shown.date)} · ${shown.type} · ${shown.department}` : "…"}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close document" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto px-3 pb-6 [scrollbar-gutter:stable]">
        {error && <ErrorText title="The document could not be loaded." reason={error} />}
        {shown?.passages.map((passage) => {
          const isCited = passage.id === target.passageId;
          return (
            <p
              key={passage.id}
              ref={isCited ? cited : undefined}
              data-passage={passage.id}
              className={
                isCited
                  ? "ui-enter-up rounded-lg bg-surface px-2 py-1.5 text-sm leading-relaxed"
                  : "px-2 py-0.5 text-sm leading-relaxed text-foreground/80"
              }
            >
              {isCited ? highlight(passage.text, target.quote) : passage.text}
            </p>
          );
        })}
      </div>
    </aside>
  );
}
