import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import type { SettingsView } from "../../types/note";
import { COLOR_PRESETS } from "../appearance/colors";
import { BackupPane } from "./BackupPane";

type Section = "general" | "backup" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "backup", label: "Backup", icon: "download" },
  { id: "about", label: "About", icon: "info" },
];

/** Settings window (design S1–S4). Sections appear as their features are built. */
export function SettingsWindow() {
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    commands.getSettings().then(setSettings, (e: Error) => setError(e.message));
  }, []);

  async function update(action: () => Promise<Partial<SettingsView>>) {
    try {
      const patch = await action();
      setSettings((s) => (s ? { ...s, ...patch } : s));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
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
            </div>
          </>
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
  );
}
