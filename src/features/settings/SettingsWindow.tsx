import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import { onSettingsSection } from "../../ipc/events";
import type { SettingsSection, SettingsView } from "../../types/note";
import { COLOR_PRESETS } from "../appearance/colors";
import { BackupPane } from "./BackupPane";
import { MinNoteSize } from "./MinNoteSize";
import { PrivacyPane } from "./PrivacyPane";
import { RecoveryCodeShown } from "./RecoveryCode";
import { ShortcutRow } from "./ShortcutRow";

type Section = "general" | "privacy" | "backup" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "privacy", label: "Privacy", icon: "lock" },
  { id: "backup", label: "Backup", icon: "download" },
  { id: "about", label: "About", icon: "info" },
];

const SECTION_NAMES: readonly SettingsSection[] = ["general", "privacy", "privacy-new-pin", "backup", "about"];

/** The section another window asked for (`open_settings(section)`), or null if unknown. */
export function parseSection(name: string | null | undefined): { section: Section; newPin: boolean } | null {
  const known = SECTION_NAMES.find((s) => s === name);
  if (!known) return null;
  return known === "privacy-new-pin" ? { section: "privacy", newPin: true } : { section: known, newPin: false };
}

/** Settings window (design S1–S4). Sections appear as their features are built.
 * A new window opens at `?section=…`; an open one switches on `settings-section`. */
export function SettingsWindow() {
  const [initial] = useState(() => parseSection(new URLSearchParams(window.location.search).get("section")));
  const [section, setSection] = useState<Section>(initial?.section ?? "general");
  /** Counts requests for "choose a new PIN"; the Privacy pane opens it once per request. */
  const [newPinRequest, setNewPinRequest] = useState(initial?.newPin ? 1 : 0);
  const [newPinPending, setNewPinPending] = useState(initial?.newPin ?? false);
  const newPinStarted = useCallback(() => setNewPinPending(false), []);

  const showSection = useCallback((name: string) => {
    const asked = parseSection(name);
    if (!asked) return;
    setSection(asked.section);
    if (asked.newPin) {
      setNewPinRequest((n) => n + 1);
      setNewPinPending(true);
    }
  }, []);

  // A recovery code on screen is shown once: a section asked for meanwhile waits until it is closed.
  const codesShown = useRef(0);
  const waitingSection = useRef<string | null>(null);
  const codeShown = useCallback(
    (shown: boolean) => {
      codesShown.current += shown ? 1 : -1;
      if (codesShown.current > 0 || waitingSection.current === null) return;
      const name = waitingSection.current;
      waitingSection.current = null;
      showSection(name);
    },
    [showSection],
  );

  useEffect(() => {
    // Outside the app (tests, preview without events) there is nothing to listen to.
    const unlisten = onSettingsSection((name) => {
      if (codesShown.current > 0) waitingSection.current = name;
      else showSection(name);
    }).catch(() => null);
    return () => void unlisten.then((f) => f?.());
  }, [showSection]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    commands.getSettings().then(setSettings, (e: Error) => setError(e.message));
  }, []);

  /** Run a change and merge its result. Returns false (and shows why) if it failed. */
  async function update(action: () => Promise<Partial<SettingsView>>): Promise<boolean> {
    try {
      const patch = await action();
      setSettings((s) => (s ? { ...s, ...patch } : s));
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  return (
    <RecoveryCodeShown.Provider value={codeShown}>
      <div className="dn-settings">
        <nav className="dn-settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              <Icon name={s.icon} />
              {s.label}
            </button>
          ))}
        </nav>
        <main className="dn-settings-pane">
          {error && (
            <div className="dn-banner-error" role="alert">
              <Icon name="alert" size={18} />
              <span>{error}</span>
            </div>
          )}
          {settings && section === "general" && (
            <>
              <h1>General</h1>
              <div className="dn-card">
                <div className="dn-card-row">
                  <div className="dn-card-label">Launch at login</div>
                  <Switch
                    label="Launch at login"
                    checked={settings.launchAtLogin}
                    onChange={(next) =>
                      void update(async () => ({ launchAtLogin: await commands.setLaunchAtLogin(next) }))
                    }
                  />
                </div>
                <div className="dn-card-sep" />
                <div className="dn-card-row">
                  <div className="dn-card-label" id="new-colour-label">
                    Colour for new notes
                  </div>
                  <div className="dn-mini-swatches" role="radiogroup" aria-labelledby="new-colour-label">
                    {COLOR_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        role="radio"
                        aria-checked={settings.newNoteColor === p.value}
                        aria-label={p.name}
                        title={p.name}
                        style={{ background: p.value }}
                        onClick={() =>
                          void update(async () => {
                            await commands.setNewNoteColor(p.value);
                            return { newNoteColor: p.value };
                          })
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="dn-card-sep" />
                <div className="dn-card-row">
                  <div className="dn-card-label">Minimum note size</div>
                  <MinNoteSize
                    value={settings.minNoteSize}
                    onSave={(size) =>
                      update(async () => ({ minNoteSize: await commands.setMinNoteSize(size.width, size.height) }))
                    }
                  />
                </div>
                <ShortcutRow />
              </div>
            </>
          )}
          {section === "privacy" && (
            <PrivacyPane key={newPinRequest} startNewPin={newPinPending} onNewPinStarted={newPinStarted} />
          )}
          {settings && section === "backup" && (
            <BackupPane
              lastBackupAt={settings.lastBackupAt}
              onExported={(at) => setSettings((s) => (s ? { ...s, lastBackupAt: at } : s))}
            />
          )}
          {settings && section === "about" && (
            <>
              <h1>About</h1>
              <div className="dn-about">
                <div>
                  <span className="dn-about-name">DeskNotes</span>{" "}
                  <span className="dn-muted">version {settings.version} · MIT license</span>
                </div>
                <div className="dn-about-folder">
                  <span className="dn-muted">Your notes are stored in</span>
                  <div className="dn-about-path">
                    <span className="dn-path">{settings.dataDir}</span>
                    <button type="button" className="dn-btn-outline" onClick={() => void update(async () => (await commands.openDataFolder(), {}))}>
                      <Icon name="folder" size={14} />
                      Open folder
                    </button>
                  </div>
                </div>
                <div className="dn-about-safe">
                  <Icon name="shield" />
                  No data leaves this computer.
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </RecoveryCodeShown.Provider>
  );
}
