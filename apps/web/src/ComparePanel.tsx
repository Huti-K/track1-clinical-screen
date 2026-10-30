import type { Contradiction, ScreenResponse, Source } from "@track1/shared";
import { Calculator, FileText, Sparkles, TriangleAlert, X } from "lucide-react";
import { Badge, Button, formatDate } from "./components/ui";
import { highlight } from "./DocumentPanel";
import { cites } from "./hoverLinks";
import { COMPARE_PANE_KEY } from "./prefs";
import { SidePane } from "./resize";

/**
 * Every passage of one contradiction next to the others, with the quotes marked: split by what
 * they say when the check knows it, such as left against right, otherwise by document.
 */
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
        {contradiction.claims
          ? contradiction.claims.map((claim) => (
              <section key={claim.label} className="flex flex-col gap-2">
                <h3 className="flex items-baseline gap-2 px-1 pt-1">
                  <span className="text-sm font-semibold tracking-tight">{claim.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {claim.total === 1 ? "1 passage" : `${claim.total} passages`}
                    {claim.total > claim.passages.length && `, ${claim.passages.length} shown`}
                  </span>
                </h3>
                {claim.passages.map((source) => (
                  <div
                    key={source.passageId}
                    className="flex flex-col gap-2 rounded-xl bg-surface p-3"
                  >
                    <h4 className="text-xs font-semibold tracking-tight">
                      {source.documentTitle}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {formatDate(source.documentDate)}
                      </span>
                    </h4>
                    <Quote source={source} term={source.term} passages={passages} onOpen={onOpen} />
                  </div>
                ))}
              </section>
            ))
          : byDocument(contradiction.passages).map((sources) => {
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
                  {sources.map((source) => (
                    <Quote
                      key={`${source.passageId}-${source.quote}`}
                      source={source}
                      passages={passages}
                      onOpen={onOpen}
                    />
                  ))}
                </section>
              );
            })}
      </div>
    </SidePane>
  );
}

function byDocument(sources: readonly Source[]): Source[][] {
  const groups = new Map<string, Source[]>();
  for (const source of sources)
    groups.set(source.documentId, [...(groups.get(source.documentId) ?? []), source]);
  return [...groups.values()];
}

/** The passage with its quote marked and, inside the quote, the words that say the claim marked stronger. */
function Quote({
  source,
  term,
  passages,
  onOpen,
}: {
  source: Source;
  term?: string;
  passages: ScreenResponse["passages"];
  onOpen: (source: Source) => void;
}) {
  const passage = passages[source.passageId];
  const text = passage?.text ?? source.quote;
  const at = text.indexOf(source.quote);
  const from = term && at >= 0 ? source.quote.indexOf(term) : -1;
  const end = at + source.quote.length;
  return (
    <div {...cites([source])} className="flex flex-col gap-1.5">
      {passage?.section && (
        <span className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">
          {passage.section}
        </span>
      )}
      <p className="text-sm leading-relaxed">
        {term && from >= 0 ? (
          <>
            {text.slice(0, at)}
            {from > 0 && <mark>{text.slice(at, at + from)}</mark>}
            <mark className="bg-warning-wash font-semibold text-warning ring-1 ring-warning/50">
              {term}
            </mark>
            {at + from + term.length < end && (
              <mark>{text.slice(at + from + term.length, end)}</mark>
            )}
            {text.slice(end)}
          </>
        ) : (
          highlight(text, source.quote)
        )}
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
}
