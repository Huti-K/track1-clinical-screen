import type { PatientDocument, ScreenResponse, Source } from "@track1/shared";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "./api";
import { formatDate } from "./components/ui";
import { highlight } from "./DocumentPanel";
import { usePatientId } from "./patient";

const documents = new Map<string, Promise<PatientDocument>>();

/** Each document is fetched once per page load; the popover asks for it to show a quote's neighbours. */
export function loadDocument(patientId: string, id: string): Promise<PatientDocument> {
  const key = `${patientId}/${id}`;
  let pending = documents.get(key);
  if (!pending) {
    pending = api.document(patientId, id);
    pending.catch(() => documents.delete(key));
    documents.set(key, pending);
  }
  return pending;
}

/** The cited passage with the line before and after it, as they stand in the letter. */
export function SourcePopover({
  source,
  passages,
  onOpenLetter,
}: {
  source: Source;
  passages: ScreenResponse["passages"];
  onOpenLetter: (source: Source) => void;
}) {
  const patientId = usePatientId();
  const [document, setDocument] = useState<PatientDocument>();
  useEffect(() => {
    if (patientId) loadDocument(patientId, source.documentId).then(setDocument, () => {});
  }, [patientId, source.documentId]);
  const passage = passages[source.passageId];
  const index = document?.passages.findIndex((p) => p.id === source.passageId) ?? -1;
  const before = index > 0 ? document?.passages[index - 1] : undefined;
  const after = index >= 0 ? document?.passages[index + 1] : undefined;

  return (
    <div
      role="dialog"
      aria-label={`Source: ${source.documentTitle}`}
      data-popover
      className="ui-enter-up absolute top-full left-0 z-30 mt-1.5 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl bg-surface p-3 text-xs shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border"
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <FileText className="size-3 shrink-0" aria-hidden />
        <span className="truncate">
          {source.documentTitle} · {formatDate(source.documentDate)}
          {passage?.section ? ` · ${passage.section}` : ""}
        </span>
        <button
          type="button"
          onClick={() => onOpenLetter(source)}
          className="ml-auto shrink-0 cursor-pointer text-accent-text hover:underline"
        >
          Open letter
        </button>
      </p>
      <div className="flex flex-col gap-px leading-relaxed">
        {before && <p className="text-muted-foreground">{before.text}</p>}
        <p>{highlight(passage?.text ?? source.quote, source.quote)}</p>
        {after && <p className="text-muted-foreground">{after.text}</p>}
      </div>
    </div>
  );
}
