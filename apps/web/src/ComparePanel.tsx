import type { Contradiction, ScreenResponse, Source } from "@track1/shared";
import { Calculator, FileText, Sparkles, TriangleAlert, X } from "lucide-react";
import { Badge, Button, formatDate } from "./components/ui";
import { highlight } from "./DocumentPanel";
import { COMPARE_PANE_KEY } from "./prefs";
import { SidePane } from "./resize";

/** Every passage of one contradiction next to the others, grouped by document, with the quotes marked. */
export function ComparePanel({
  contradiction,
  passages,
  onOpen,
  onClose,
}: {
  contradiction: Contradiction;
  passages: ScreenResponse["passages"];
  onOpen: (source: Source) => void;
  onClose: () => void;
}) {
  const byDocument = new Map<string, Source[]>();
  for (const source of contradiction.passages)
    byDocument.set(source.documentId, [...(byDocument.get(source.documentId) ?? []), source]);
  const columns = [...byDocument.values()];

  return (
    <SidePane label="Contradiction side by side" storageKey={COMPARE_PANE_KEY} share={0.48}>
      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
            Contradiction
            {contradiction.method === "rule" ? (
              <Badge tone="accent">
                <Calculator className="size-3" aria-hidden /> Calculated check
              </Badge>
            ) : (
              <Badge>
                <Sparkles className="size-3" aria-hidden /> Found by AI
              </Badge>
            )}
          </h2>
          <p className="text-sm">{contradiction.summary}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close comparison" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </header>
      <div className="grid flex-1 auto-rows-min gap-3 overflow-y-auto px-3 pb-6 [scrollbar-gutter:stable] xl:grid-cols-2">
        {columns.map((sources) => {
          const first = sources[0];
          if (!first) return null;
          return (
            <section
              key={first.documentId}
              className="flex flex-col gap-2 rounded-xl bg-surface p-3"
            >
              <h3 className="text-xs font-semibold tracking-tight">
                {first.documentTitle}
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {formatDate(first.documentDate)}
                </span>
              </h3>
              {sources.map((source) => {
                const passage = passages[source.passageId];
                return (
                  <div
                    key={`${source.passageId}-${source.quote}`}
                    className="flex flex-col gap-1.5"
                  >
                    {passage?.section && (
                      <span className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                        {passage.section}
                      </span>
                    )}
                    <p className="text-sm leading-relaxed">
                      {highlight(passage?.text ?? source.quote, source.quote)}
                    </p>
                    <button
                      type="button"
                      onClick={() => onOpen(source)}
                      className="inline-flex w-fit cursor-pointer items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors duration-150 hover:bg-hover hover:text-foreground"
                    >
                      <FileText className="size-3" aria-hidden />
                      Open in document
                    </button>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
    </SidePane>
  );
}
