import type { Need, ScreenResponse, Source } from "@track1/shared";
import { CircleAlert, FileText, TriangleAlert } from "lucide-react";
import { Badge, cx, formatDate, GroupLabel } from "./components/ui";

export function SourceChip({
  source,
  active,
  onOpen,
}: {
  source: Source;
  active: boolean;
  onOpen: (source: Source) => void;
}) {
  return (
    <button
      type="button"
      title={`“${source.quote}”`}
      onClick={() => onOpen(source)}
      className={cx(
        "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs transition-colors duration-150",
        active
          ? "bg-accent-wash text-accent-text"
          : "bg-surface-2 text-muted-foreground hover:bg-hover hover:text-foreground",
      )}
    >
      <FileText className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        {source.documentTitle} · {formatDate(source.documentDate)}
      </span>
    </button>
  );
}

function NeedGroup({
  need,
  open,
  onOpen,
}: {
  need: Need;
  open?: Partial<Pick<Source, "passageId" | "quote">>;
  onOpen: (source: Source) => void;
}) {
  if (need.status === "not_documented")
    return (
      <section className="ui-enter-up">
        <GroupLabel aside={<Badge tone="warning">Not documented</Badge>}>{need.title}</GroupLabel>
        <p className="flex gap-2 text-sm text-muted-foreground">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {need.note || "None of the documents contain this."}
        </p>
      </section>
    );
  return (
    <section className="ui-enter-up">
      <GroupLabel>{need.title}</GroupLabel>
      <ul className="flex flex-col">
        {need.facts.map((fact) => (
          <li
            key={`${fact.label}-${fact.value}`}
            className="-mx-2 flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-surface-2/60"
          >
            <span className="text-xs text-muted-foreground">{fact.label}</span>
            <span className="text-sm font-medium">{fact.value}</span>
            <span className="flex flex-wrap gap-1">
              {fact.sources.map((source) => (
                <SourceChip
                  key={`${source.passageId}-${source.quote}`}
                  source={source}
                  active={open?.passageId === source.passageId && open.quote === source.quote}
                  onOpen={onOpen}
                />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScreenView({
  result,
  loadMs,
  open,
  onOpen,
}: {
  result: ScreenResponse;
  loadMs?: number;
  open?: Partial<Pick<Source, "passageId" | "quote">>;
  onOpen: (source: Source) => void;
}) {
  const { screen, contradictions } = result;
  return (
    <div className="flex flex-col gap-10">
      <header className="ui-enter-up flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">
          {screen.role} <span className="text-muted-foreground">·</span> {screen.task}
        </h2>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
          {loadMs !== undefined && <span>{(loadMs / 1000).toFixed(1)} s</span>}
          {result.cached && <Badge>Saved screen</Badge>}
          <span className="font-mono">{screen.model}</span>
          {screen.rejected > 0 && (
            <span>· {screen.rejected} fact(s) left out because no passage says them</span>
          )}
        </p>
      </header>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-x-10 gap-y-8">
        {screen.needs.map((need) => (
          <NeedGroup key={need.title} need={need} open={open} onOpen={onOpen} />
        ))}
      </div>

      <section className="ui-enter-up">
        <GroupLabel aside={<Badge>{contradictions.length}</Badge>}>
          Contradictions in the documents
        </GroupLabel>
        {contradictions.length === 0 && (
          <p className="text-sm text-muted-foreground">None found.</p>
        )}
        <ul className="flex flex-col">
          {contradictions.map((c) => (
            <li
              key={c.id}
              className="-mx-2 flex gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-2/60"
            >
              <TriangleAlert
                className={cx(
                  "mt-0.5 size-4 shrink-0",
                  c.relevant ? "text-warning" : "text-muted-foreground",
                )}
                aria-hidden
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="text-sm">
                  {c.summary}
                  {c.relevant && (
                    <Badge tone="warning" className="ml-2 align-middle">
                      Affects this screen
                    </Badge>
                  )}
                </p>
                <span className="flex flex-wrap gap-1">
                  {c.passages.map((source) => (
                    <SourceChip
                      key={`${source.passageId}-${source.quote}`}
                      source={source}
                      active={open?.passageId === source.passageId && open.quote === source.quote}
                      onOpen={onOpen}
                    />
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ScreenSkeleton({ documents }: { documents: number }) {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <p className="text-sm text-shimmer">Reading {documents} documents for your task…</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-x-10 gap-y-8">
        {[0, 1, 2, 3].map((group) => (
          <div key={group} className="flex flex-col gap-3">
            <div className="skeleton h-4 w-32" />
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-3 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
