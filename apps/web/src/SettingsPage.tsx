import type { AuthStatus, Note } from "@track1/shared";
import {
  Info,
  Keyboard,
  LogOut,
  type LucideIcon,
  Monitor,
  Moon,
  NotebookPen,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { BrandMark } from "./components/BrandMark";
import {
  Segmented,
  SettingRow,
  SettingsHeading,
  SettingsLayout,
  SettingsSection,
  Switch,
} from "./components/settings";
import { Button, formatDate, Keys } from "./components/ui";
import type { ThemePreference } from "./prefs";
import { SHORTCUT_ROWS } from "./ShortcutsDialog";
import type { ScreenEntry } from "./Timeline";

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "notes", label: "Notes", icon: NotebookPen },
  { id: "keyboard", label: "Keyboard", icon: Keyboard },
  { id: "about", label: "About", icon: Info },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** The section an address names, `general` for a bare or unknown `/settings`; none off settings. */
export function settingsSectionOf(path: string): SettingsSectionId | undefined {
  const match = path.match(/^\/settings(?:\/([^/]+))?\/?$/);
  if (!match) return undefined;
  return SETTINGS_SECTIONS.find((s) => s.id === match[1])?.id ?? "general";
}

export type SettingsProps = {
  section: SettingsSectionId;
  onSection: (section: SettingsSectionId) => void;
  auth: AuthStatus;
  theme: ThemePreference;
  onTheme: (theme: ThemePreference) => void;
  sidebarFolded: boolean;
  onSidebarFolded: (folded: boolean) => void;
  screens: ScreenEntry[];
  onClearScreens: () => void;
  /** Every clinician note; removing one here takes it off the screens too. */
  notes: Note[];
  onRemoveNote: (id: string) => void;
  onSignOut: () => void;
};

export function SettingsPage(props: SettingsProps) {
  const { section } = props;
  return (
    <SettingsLayout
      navigationLabel="Settings sections"
      items={SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => ({
        value: id,
        label,
        icon: <Icon aria-hidden />,
      }))}
      value={section}
      onValueChange={props.onSection}
    >
      {section === "general" ? (
        <GeneralSettings {...props} />
      ) : section === "notes" ? (
        <NoteSettings {...props} />
      ) : section === "keyboard" ? (
        <KeyboardSettings />
      ) : (
        <AboutSettings />
      )}
    </SettingsLayout>
  );
}

function GeneralSettings({
  auth,
  theme,
  onTheme,
  sidebarFolded,
  onSidebarFolded,
  onSignOut,
}: SettingsProps) {
  return (
    <>
      <SettingsHeading title="General" />
      <SettingsSection title="Appearance">
        <SettingRow label="Theme" description="System follows your computer's light or dark mode.">
          <Segmented
            label="Theme"
            value={theme}
            onValueChange={onTheme}
            options={[
              { value: "light", label: "Light", icon: <Sun aria-hidden /> },
              { value: "dark", label: "Dark", icon: <Moon aria-hidden /> },
              { value: "system", label: "System", icon: <Monitor aria-hidden /> },
            ]}
          />
        </SettingRow>
        <SettingRow
          htmlFor="settings-sidebar-folded"
          label="Fold the sidebar"
          description="Show only icons beside the screen on a wide window."
        >
          <Switch
            id="settings-sidebar-folded"
            checked={sidebarFolded}
            onCheckedChange={onSidebarFolded}
          />
        </SettingRow>
      </SettingsSection>
      {auth.stored && (
        <SettingsSection title="Account">
          <SettingRow label="Signed in as">
            <span className="text-sm text-muted-foreground">
              {auth.account ?? auth.providerName}
            </span>
          </SettingRow>
          <SettingRow label="Sign out" description="Ends the session in this browser.">
            <Button variant="secondary" size="sm" onClick={onSignOut}>
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </Button>
          </SettingRow>
        </SettingsSection>
      )}
    </>
  );
}

/** A button that asks once more in place, instead of a browser dialog. */
function ConfirmButton({
  label,
  confirm,
  onConfirm,
  disabled,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
        Keep
      </Button>
      <Button
        size="sm"
        className="bg-destructive text-surface"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirm}
      </Button>
    </>
  );
}

function NoteSettings({ screens, onClearScreens, notes, onRemoveNote }: SettingsProps) {
  return (
    <>
      <SettingsHeading title="Notes" />
      <SettingsSection
        title="Clinician notes"
        description="What you or the patient told the app to close an open point. Later screens and answers use them."
      >
        {notes.length === 0 ? (
          <p className="py-3.5 text-sm text-muted-foreground">
            No notes yet. Record one from an open point on a screen.
          </p>
        ) : (
          notes.map((note) => (
            <SettingRow
              key={note.id}
              label={
                <>
                  <span className="font-medium">{note.topic}</span>
                  <span className="text-muted-foreground"> · {note.text}</span>
                </>
              }
              description={[
                note.source === "patient" ? "The patient said" : "A clinician recorded",
                note.author,
                formatDate(note.recordedAt.slice(0, 10)),
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <ConfirmButton
                label="Remove"
                confirm="Remove note"
                onConfirm={() => onRemoveNote(note.id)}
              />
            </SettingRow>
          ))
        )}
      </SettingsSection>
      <SettingsSection title="Recent screens">
        <SettingRow
          label="Clear the list"
          description={`${screens.length} ${screens.length === 1 ? "screen" : "screens"} in the sidebar. The patient record is not changed.`}
        >
          <ConfirmButton
            label="Clear"
            confirm="Clear list"
            disabled={screens.length === 0}
            onConfirm={onClearScreens}
          />
        </SettingRow>
      </SettingsSection>
    </>
  );
}

function KeyboardSettings() {
  return (
    <>
      <SettingsHeading title="Keyboard" />
      <SettingsSection title="Shortcuts">
        {SHORTCUT_ROWS.map((row) => (
          <SettingRow key={row.description} label={row.description}>
            <Keys keys={row.keys} />
          </SettingRow>
        ))}
      </SettingsSection>
    </>
  );
}

function AboutSettings() {
  return (
    <>
      <SettingsHeading title="About" />
      <div className="flex items-center gap-3">
        <BrandMark size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Roter Faden</p>
          <p className="text-xs text-muted-foreground">
            The patient facts your role and task need, each linked to its source.
          </p>
        </div>
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          v{__APP_VERSION__}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Synthetic patient data only. The screen is a reading aid; the source documents count.
      </p>
    </>
  );
}
