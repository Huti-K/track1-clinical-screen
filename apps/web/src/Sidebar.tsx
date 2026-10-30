import type { AuthStatus, DocumentInfo, PatientSummary, ScreenResponse } from "@track1/shared";
import { Keyboard, LogOut, PanelLeftClose, PanelLeftOpen, Settings, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Brand, BrandMark } from "./components/BrandMark";
import { Avatar, Button, cx, Keys } from "./components/ui";
import { keysOf, SHORTCUTS } from "./hotkeys";
import { PatientSwitcher } from "./PatientSwitcher";
import { SIDEBAR_WIDTH_KEY, useStored } from "./prefs";
import { ResizeHandle, usePaneDrag } from "./resize";
import { type ScreenEntry, Timeline } from "./Timeline";

export type { ScreenEntry };

export type SidebarProps = {
  /** `rail` is the folded desktop column; `drawer` the mobile overlay, closed with its X. */
  mode: "full" | "rail" | "drawer";
  patient?: PatientSummary;
  auth: AuthStatus;
  screens: ScreenEntry[];
  currentScreenId?: string;
  /** The screen on display; the timeline marks the documents it cites. */
  screen?: ScreenResponse;
  /** The document open beside the screen. */
  documentId?: string;
  onHome: () => void;
  onScreen: (id: string) => void;
  onRemoveScreen: (id: string) => void;
  onDocument: (document: DocumentInfo) => void;
  onToggle: () => void;
  onShortcuts: () => void;
  onSettings: () => void;
  onSignOut: () => void;
};

function MenuItem({
  icon,
  label,
  keys,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  keys?: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-150 hover:bg-surface-2"
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <Keys keys={keys} />}
    </button>
  );
}

/** The signed-in account; a click opens settings, shortcuts and sign-out above it. */
function AccountMenu({
  auth,
  compact,
  onShortcuts,
  onSettings,
  onSignOut,
}: Pick<SidebarProps, "auth" | "onShortcuts" | "onSettings" | "onSignOut"> & {
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const who = auth.account ?? (auth.stored ? auth.providerName : "API key from .env");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const initial = (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
      {who.slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={compact ? `Account: ${who}` : undefined}
        title={compact ? who : undefined}
        className={cx(
          "flex cursor-pointer items-center gap-2.5 rounded-xl text-left transition-colors duration-150 hover:bg-surface-2 aria-expanded:bg-surface-2",
          compact ? "p-1" : "w-full px-2 py-1.5",
        )}
      >
        {initial}
        {!compact && <span className="min-w-0 flex-1 truncate text-sm">{who}</span>}
      </button>
      {open && (
        <div
          className={cx(
            "ui-enter-up absolute bottom-full z-50 mb-2 rounded-xl bg-surface p-1 shadow-[0_12px_32px_rgb(0_0_0/0.08)] ring-1 ring-border",
            compact ? "left-0 w-64" : "inset-x-0",
          )}
        >
          <div className="px-2.5 pt-1.5 pb-2">
            <p className="truncate text-sm font-medium">{who}</p>
          </div>
          <div className="mx-1 mb-1 h-px bg-border" />
          <MenuItem
            icon={<Settings />}
            label="Settings"
            keys={keysOf(SHORTCUTS.settings)}
            onClick={pick(onSettings)}
          />
          <MenuItem
            icon={<Keyboard />}
            label="Keyboard shortcuts"
            keys={keysOf(SHORTCUTS.shortcuts)}
            onClick={pick(onShortcuts)}
          />
          {auth.stored && <MenuItem icon={<LogOut />} label="Sign out" onClick={pick(onSignOut)} />}
        </div>
      )}
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { mode, patient, screens, currentScreenId, documentId, onHome, onToggle } = props;
  const account = <AccountMenu {...props} compact={mode === "rail"} />;

  if (mode === "rail")
    return (
      <nav aria-label="Navigation" className="flex w-16 shrink-0 flex-col items-center gap-2 py-4">
        <button
          type="button"
          onClick={onHome}
          aria-label="Home"
          title="Home · new screen"
          className="cursor-pointer rounded-[9px]"
        >
          <BrandMark />
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Show sidebar"
          onClick={onToggle}
          className="text-muted-foreground"
        >
          <PanelLeftOpen className="size-4" />
        </Button>
        {patient && (
          <button
            type="button"
            onClick={onHome}
            aria-label={`New screen for ${patient.name}`}
            title={`New screen for ${patient.name}`}
            className="mt-2 cursor-pointer rounded-full ring-[1.5px] ring-accent ring-offset-2 ring-offset-chrome"
          >
            <Avatar name={patient.name} />
          </button>
        )}
        <span className="flex-1" />
        {account}
      </nav>
    );

  return (
    <nav aria-label="Navigation" className="flex min-h-0 w-full shrink-0 flex-col gap-3 px-3 py-4">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onHome}
          title="Home · new screen"
          className="flex min-w-0 flex-1 cursor-pointer items-center rounded-[10px] px-2 py-1 transition-colors duration-150 hover:bg-surface-2"
        >
          <Brand />
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={mode === "drawer" ? "Close menu" : "Hide sidebar"}
          onClick={onToggle}
          className="text-muted-foreground"
        >
          {mode === "drawer" ? <X className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      </div>

      <PatientSwitcher
        patients={patient ? [patient] : []}
        current={patient}
        below={mode === "drawer"}
        onPick={onHome}
      />

      <div className="-mx-3 min-h-0 flex-1 overflow-y-auto px-3">
        <Timeline
          patient={patient}
          screens={screens}
          currentScreenId={currentScreenId}
          screen={props.screen}
          documentId={documentId}
          cards={mode === "full"}
          onNewScreen={onHome}
          onScreen={props.onScreen}
          onRemoveScreen={props.onRemoveScreen}
          onDocument={props.onDocument}
        />
      </div>

      {account}
    </nav>
  );
}

const RAIL = 64;
const WIDTH = { min: 232, initial: 288, max: 440, share: 0.4 };

/** The desktop sidebar at the width it was dragged to; dragged well past its minimum it folds to the rail. */
export function SidebarFrame({
  collapsed,
  onCollapsed,
  ...props
}: Omit<SidebarProps, "mode" | "onToggle"> & {
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
}) {
  const [width, setWidth] = useStored(SIDEBAR_WIDTH_KEY, WIDTH.initial);
  const frame = useRef<HTMLDivElement>(null);
  const id = useId();
  const max = () => Math.max(WIDTH.min, Math.min(WIDTH.max, window.innerWidth * WIDTH.share));
  const drag = usePaneDrag({
    measure: () => frame.current?.getBoundingClientRect().width ?? width,
    min: WIDTH.min,
    max,
    grows: "right",
    reset: () => WIDTH.initial,
    onDrag: (next) => frame.current?.style.setProperty("--sidebar-width", `${next ?? width}px`),
    onCommit: (next) => {
      setWidth(next);
      onCollapsed(false);
    },
    onFold: () => onCollapsed(true),
  });
  const rail = drag.dragging ? drag.folding : collapsed;
  return (
    <div className="hidden lg:flex">
      <div
        ref={frame}
        id={id}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
        className={cx("flex", !rail && "w-(--sidebar-width) max-w-[40vw]")}
      >
        <Sidebar
          {...props}
          mode={rail ? "rail" : "full"}
          onToggle={() => onCollapsed(!collapsed)}
        />
      </div>
      <ResizeHandle
        label="Resize sidebar"
        drag={drag}
        value={rail ? RAIL : width}
        min={RAIL}
        max={max()}
        controls={id}
        className="-mx-[5px]"
        onKeyDown={(event) => {
          // Enter folds and unfolds; from the rail, only widening keys open it.
          if (event.key === "Enter") onCollapsed(!collapsed);
          else if (!collapsed) return;
          else if (event.key === "ArrowRight" || event.key === "End") onCollapsed(false);
          else if (event.key !== "ArrowLeft" && event.key !== "Home") return;
          event.preventDefault();
        }}
      />
    </div>
  );
}
