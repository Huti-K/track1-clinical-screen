import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button, Keys } from "./components/ui";
import { keysOf, SHORTCUTS } from "./hotkeys";

/** Every key the app answers to, for this dialog and the Keyboard settings. */
export const SHORTCUT_ROWS = [
  ...Object.values(SHORTCUTS).map((s) => ({ keys: keysOf(s), description: s.description })),
  { keys: ["/"], description: "Search the patient's documents" },
  { keys: ["Esc"], description: "Close the open document or menu" },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (open && !d?.open) d?.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop closes it; Escape closes the native dialog
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      aria-labelledby="shortcuts-title"
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-surface text-foreground backdrop:bg-black/25"
    >
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-sm font-semibold tracking-tight">
            Keyboard shortcuts
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-1">
          {SHORTCUT_ROWS.map((row) => (
            <div
              key={row.description}
              className="flex items-center justify-between gap-4 py-2.5 text-sm [&+&]:shadow-[inset_0_1px_0_var(--border)]"
            >
              <span>{row.description}</span>
              <Keys keys={row.keys} />
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
