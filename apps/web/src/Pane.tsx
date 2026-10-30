import type { PatientDocument, ScreenResponse, Source } from "@track1/shared";
import { FileText } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { formatDate } from "./components/ui";
import { type DocumentTarget, highlight } from "./DocumentPanel";
import { cites } from "./hoverLinks";
import { usePatientId } from "./patient";
import { loadDocument } from "./SourcePopover";

/**
 * The right-hand pane beside the screen's list. On wide screens it fills the column from top to
 * bottom and scrolls on its own; on narrow ones it is a card below the list.
 */
export const PANE =
  "mx-4 mb-8 rounded-2xl bg-recessed px-5 pt-4 pb-5 sm:mx-10 @4xl:m-0 @4xl:h-full @4xl:w-[min(var(--detail-width),50%)] @4xl:shrink-0 @4xl:overflow-y-auto @4xl:rounded-none @4xl:bg-chrome @4xl:px-6 @4xl:pt-8 @4xl:pb-8";

/**
 * On narrow screens a selection opens the pane as a sheet over the list's foot. While a document
 * or a comparison is open beside the screen the sheet would cover it, so it stays hidden until
 * that closes.
 */
export const SHEET =
  "ui-enter-up @max-4xl:group-data-[beside]/screen:hidden @max-4xl:fixed @max-4xl:inset-x-3 @max-4xl:bottom-3 @max-4xl:z-40 @max-4xl:mx-0 @max-4xl:mb-0 @max-4xl:max-h-[75dvh] @max-4xl:overflow-y-auto @max-4xl:shadow-[0_12px_32px_rgb(0_0_0/0.12)]";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">{children}</dd>
    </>
  );
}

/** The cited passage with the line before and after it, as they stand in the letter. */
export function SourceQuote({
  source,
  passages,
  onOpenLetter,
}: {
  source: Source;
  passages: ScreenResponse["passages"];
  onOpenLetter: (target: DocumentTarget) => void;
}) {
  const patientId = usePatientId();
  const [document, setDocument] = useState<PatientDocument>();
  useEffect(() => {
    if (patientId) loadDocument(patientId, source.documentId).then(setDocument, () => {});
  }, [patientId, source.documentId]);
  const index = document?.passages.findIndex((p) => p.id === source.passageId) ?? -1;
  const passage = passages[source.passageId] ?? document?.passages[index];
  const before = index > 0 ? document?.passages[index - 1] : undefined;
  const after = index >= 0 ? document?.passages[index + 1] : undefined;
  return (
    <div {...cites([source])} className="rounded-xl bg-surface px-3 py-2.5">
      <p className="mb-1 flex items-start gap-1.5 text-2xs text-muted-foreground">
        <FileText className="mt-px size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          {source.documentTitle} · {formatDate(source.documentDate)}
          {passage?.section ? ` · ${passage.section}` : ""}
        </span>
        <button
          type="button"
          onClick={() => onOpenLetter(source)}
          className="shrink-0 cursor-pointer text-accent-text hover:underline"
        >
          Open
        </button>
      </p>
      <div className="flex flex-col gap-px text-[12.5px] leading-relaxed">
        {before && <p className="text-muted-foreground">{before.text}</p>}
        <p>{highlight(passage?.text ?? source.quote, source.quote)}</p>
        {after && <p className="text-muted-foreground">{after.text}</p>}
      </div>
    </div>
  );
}
