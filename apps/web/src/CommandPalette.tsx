import type { DocumentInfo } from "@track1/shared";
import { FileText, LayoutList, Plus, Search } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, formatDate, Keys } from "./components/ui";
import { keysOf, SHORTCUTS } from "./hotkeys";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./SettingsPage";
import type { ScreenEntry } from "./Timeline";

/** A palette you have to scroll has failed, so each group shows only its best few. */
const MAX_PER_GROUP = 6;

type Result = {
  id: string;
  group: "Go to" | "Screens" | "Documents" | "Settings";
  label: string;
  detail?: string;
  icon: ReactNode;
  keys?: string[];
  run: () => void;
};

/**
 * Substring match, ranked: a hit at the start beats one in the middle, a shorter text beats a
 * longer one with the same hit. Oktoplan's palette ranks the same way, for the same reason.
 */
function score(haystack: string, needle: string): number | null {
  const at = haystack.toLowerCase().indexOf(needle);
  return at === -1 ? null : at * 100 + haystack.length;
}

/**
 * ⌘K: go to a saved screen, one of her documents or a setting. It navigates and never acts on the
 * record, so Enter is always safe to press.
 */
export function CommandPalette({
  open,
  onClose,
  screens,
  documents,
  onNewScreen,
  onScreen,
  onDocument,
  onSettings,
}: {
  open: boolean;
  onClose: () => void;
  screens: ScreenEntry[];
  documents: DocumentInfo[];
  onNewScreen: () => void;
  onScreen: (id: string) => void;
  onDocument: (document: DocumentInfo) => void;
  onSettings: (section: SettingsSectionId) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (open && !d?.open) {
      setQuery("");
      setActive(0);
      d?.showModal();
    }
    if (!open && d?.open) d.close();
  }, [open]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const rank = <T,>(rows: T[], text: (row: T) => string, cap = MAX_PER_GROUP): T[] =>
      rows
        .map((row) => ({ row, s: q ? score(text(row), q) : 0 }))
        .filter((r): r is { row: T; s: number } => r.s !== null)
        .sort((a, b) => a.s - b.s)
        .slice(0, cap)
        .map((r) => r.row);

    const actions: Result[] = rank(
      [
        {
          id: "new",
          group: "Go to" as const,
          label: "New screen",
          icon: <Plus />,
          keys: keysOf(SHORTCUTS.newScreen),
          run: onNewScreen,
        },
      ],
      (r) => r.label,
    );
    // Opened and not yet typed into, it offers the latest screens rather than every document.
    const screenRows: Result[] = rank(
      screens,
      (s) => `${s.task} ${s.role}`,
      q ? MAX_PER_GROUP : 4,
    ).map((s) => ({
      id: `screen:${s.id}`,
      group: "Screens",
      label: s.task,
      detail: s.role,
      icon: <LayoutList />,
      run: () => onScreen(s.id),
    }));
    const documentRows: Result[] = q
      ? rank(documents, (d) => `${d.title} ${d.department} ${d.date}`).map((d) => ({
          id: `document:${d.id}`,
          group: "Documents",
          label: d.title,
          detail: `${formatDate(d.date)} · ${d.department}`,
          icon: <FileText />,
          run: () => onDocument(d),
        }))
      : [];
    const settingRows: Result[] = rank(
      [...SETTINGS_SECTIONS],
      (s) => `${s.label} settings`,
      q ? MAX_PER_GROUP : 0,
    ).map(({ id, label, icon: Icon }) => ({
      id: `settings:${id}`,
      group: "Settings",
      label,
      icon: <Icon />,
      run: () => onSettings(id),
    }));
    return [...actions, ...screenRows, ...documentRows, ...settingRows];
  }, [query, screens, documents, onNewScreen, onScreen, onDocument, onSettings]);

  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function choose(result: Result | undefined) {
    if (!result) return;
    onClose();
    result.run();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes it; Escape closes the native dialog
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-label="Go to"
      className="mx-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-surface text-foreground backdrop:bg-black/25"
    >
      <div className="flex items-center gap-2.5 px-4 shadow-[inset_0_-1px_0_var(--border)]">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + results.length) % Math.max(results.length, 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[current]);
            }
          }}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results[current] ? `${listId}-${current}` : undefined}
          placeholder="Go to a screen, document or setting…"
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground focus-visible:shadow-none"
        />
      </div>
      <div
        ref={list}
        id={listId}
        role="listbox"
        className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5"
      >
        {results.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing matches “{query.trim()}”.
          </p>
        )}
        {results.map((result, index) => (
          <div key={result.id}>
            {result.group !== results[index - 1]?.group && (
              <p className="px-2.5 pt-2 pb-1 text-2xs font-medium text-muted-foreground">
                {result.group}
              </p>
            )}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: the field above moves through the options and Enter picks one */}
            <div
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === current}
              tabIndex={-1}
              onMouseMove={() => index !== current && setActive(index)}
              onClick={() => choose(result)}
              className={cx(
                "flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm",
                index === current && "bg-surface-2",
              )}
            >
              <span className="text-muted-foreground [&_svg]:size-4">{result.icon}</span>
              <span className="min-w-0 flex-1 truncate">
                {result.label}
                {result.detail && <span className="text-muted-foreground"> · {result.detail}</span>}
              </span>
              {result.keys && <Keys keys={result.keys} />}
            </div>
          </div>
        ))}
      </div>
    </dialog>
  );
}
