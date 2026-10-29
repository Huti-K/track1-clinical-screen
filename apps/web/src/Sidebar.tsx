import type { AuthStatus, PatientSummary } from "@track1/shared";
import { FileText, LogOut } from "lucide-react";
import { Brand } from "./components/BrandMark";
import { Button, cx, formatDate } from "./components/ui";
import type { DocumentTarget } from "./DocumentPanel";

export function Sidebar({
  patient,
  auth,
  openDocumentId,
  onOpenDocument,
  onSignOut,
}: {
  patient?: PatientSummary;
  auth: AuthStatus;
  openDocumentId?: string;
  onOpenDocument: (target: DocumentTarget) => void;
  onSignOut: () => void;
}) {
  const who = auth.account ?? (auth.stored ? auth.providerName : "API key from .env");
  return (
    <nav className="hidden w-64 shrink-0 flex-col gap-6 px-3 py-4 lg:flex">
      <div className="px-2">
        <Brand />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <p className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
          Documents{patient ? ` · ${patient.documents.length}` : ""}
        </p>
        <div className="flex flex-col overflow-y-auto">
          {[...(patient?.documents ?? [])].reverse().map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => onOpenDocument({ documentId: doc.id, documentTitle: doc.title })}
              className={cx(
                "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
                openDocumentId === doc.id ? "bg-hover" : "hover:bg-surface-2",
              )}
            >
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-sm">{doc.title}</span>
                <span className="block text-2xs text-muted-foreground tabular-nums">
                  {formatDate(doc.date)} · {doc.type}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2.5 px-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
          {who.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{who}</span>
          <span className="block truncate font-mono text-3xs text-muted-foreground">
            {auth.model}
          </span>
        </span>
        {auth.stored && (
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={onSignOut}>
            <LogOut className="size-4" />
          </Button>
        )}
      </div>
    </nav>
  );
}
