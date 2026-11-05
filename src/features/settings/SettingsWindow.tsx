import { useCallback, useEffect, useId, useRef, useState } from "react";
import appIcon from "../../assets/app-icon.png";
import { Icon } from "../../components/Icon";
import type { IconName } from "../../components/icons";
import { Switch } from "../../components/Switch";
import { commands } from "../../ipc/commands";
import { onSettingsSection } from "../../ipc/events";
import type { AboutLink, AppAppearance, SettingsSection, SettingsView } from "../../types/note";
import { COLOR_PRESETS } from "../appearance/colors";
import { AppearancePane } from "./AppearancePane";
import { BackupPane } from "./BackupPane";
import { MinNoteSize } from "./MinNoteSize";
import { PrivacyPane } from "./PrivacyPane";
import { SettingsHold } from "./hold";
import { ShortcutRow } from "./ShortcutRow";

type Section = "general" | "appearance" | "privacy" | "backup" | "about";

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "privacy", label: "Privacy", icon: "lock" },
  { id: "backup", label: "Backup", icon: "download" },
  { id: "about", label: "About", icon: "info" },
];

const SECTION_NAMES: readonly SettingsSection[] = ["general", "appearance", "privacy", "privacy-new-pin", "backup", "about"];

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

  // While a recovery code is on screen (shown once) or a call that may issue one runs,
  // the nav is inert and a section asked for meanwhile waits until the hold ends (R25).
  const holds = useRef(0);
  const [held, setHeld] = useState(false);
  const waitingSection = useRef<string | null>(null);
  const hold = useCallback(
    (on: boolean) => {
      holds.current += on ? 1 : -1;
      setHeld(holds.current > 0);
      if (holds.current > 0 || waitingSection.current === null) return;
      const name = waitingSection.current;
      waitingSection.current = null;
      showSection(name);
    },
    [showSection],
  );

  useEffect(() => {
    // Outside the app (tests, preview without events) there is nothing to listen to.
    const unlisten = onSettingsSection((name) => {
      if (holds.current > 0) waitingSection.current = name;
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

  // Appearance saves the whole value. The pane shows what was asked for at once; a change made
  // while a save runs waits (only the newest is kept) so saves never overlap. If one is refused,
  // the saved value comes back and the reason is shown.
  const [asked, setAsked] = useState<AppAppearance | null>(null);
  const saving = useRef(false);
  const waiting = useRef<AppAppearance | null>(null);
  const saveAppearance = useCallback(async (next: AppAppearance) => {
    setAsked(next);
    if (saving.current) {
      waiting.current = next;
      return;
    }
    saving.current = true;
    let sending: AppAppearance | null = next;
    while (sending) {
      waiting.current = null;
      try {
        const saved = await commands.setAppAppearance(sending);
        setSettings((s) => (s ? { ...s, appAppearance: saved } : s));
        setError(null);
        if (!waiting.current) setAsked(null);
      } catch (e) {
        setError((e as Error).message);
        waiting.current = null;
        setAsked(null);
      }
      sending = waiting.current;
    }
    saving.current = false;
  }, []);

  return (
    <SettingsHold.Provider value={hold}>
      <div className="dn-settings">
        <nav className="dn-settings-nav" aria-label="Settings sections" inert={held}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={section === s.id ? "page" : undefined}
              disabled={held}
              onClick={() => {
                if (holds.current === 0) setSection(s.id);
              }}
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
          {settings && section === "appearance" && (
            <AppearancePane value={asked ?? settings.appAppearance} onChange={(next) => void saveAppearance(next)} />
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
            <AboutPane
              settings={settings}
              onOpenFolder={() => void update(async () => (await commands.openDataFolder(), {}))}
              onOpenLink={(id) => void update(async () => (await commands.openExternalLink(id), {}))}
            />
          )}
        </main>
      </div>
    </SettingsHold.Provider>
  );
}

const COPIED_FOR_MS = 2000;

/** A link to the system browser: only the fixed id goes to Rust, which builds the address. */
function ExternalLink({
  id,
  onOpen,
  describedBy,
  children,
}: {
  id: AboutLink;
  onOpen: (id: AboutLink) => void;
  describedBy?: string;
  children: string;
}) {
  return (
    <button type="button" className="dn-about-link" aria-describedby={describedBy} onClick={() => onOpen(id)}>
      {children}
    </button>
  );
}

function AboutPane({
  settings,
  onOpenFolder,
  onOpenLink,
}: {
  settings: SettingsView;
  onOpenFolder: () => void;
  onOpenLink: (id: AboutLink) => void;
}) {
  const hintBase = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function stopTimer() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }

  async function copyVersion() {
    let failed = false;
    try {
      await navigator.clipboard.writeText(`DeskNotes ${settings.version} · ${settings.osName}`);
    } catch {
      failed = true;
    }
    if (!mounted.current) return;
    stopTimer();
    setCopyFailed(failed);
    setCopied(!failed);
    if (!failed) timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS);
  }

  return (
    <>
      <h1>About</h1>
      <div className="dn-about">
        <div className="dn-about-head">
          <img className="dn-about-icon" src={appIcon} alt="" width={48} height={48} />
          <div>
            <div className="dn-about-name">DeskNotes</div>
            <div className="dn-muted dn-about-version">
              <span>version {settings.version}</span>
              <button type="button" className="dn-btn-outline" onClick={() => void copyVersion()}>
                {copied ? "Copied" : "Copy"}
              </button>
              <span className="dn-visually-hidden" role="status" aria-live="polite">
                {copied ? "Copied" : ""}
              </span>
              <span>· MIT license</span>
            </div>
          </div>
        </div>
        {copyFailed && (
          <div className="dn-field-error" role="alert">
            Could not copy.
          </div>
        )}
        <p className="dn-about-text">Sticky notes for your desktop that work offline and keep everything on your computer.</p>
        <p className="dn-about-text">
          Made by <strong>Alex</strong> (KRusselAlex) and DeskNotes contributors.
        </p>
        <div className="dn-about-links">
          {(
            [
              ["source", "Source code on GitHub"],
              ["issues", "Report a problem or suggest an idea"],
              ["more_tools", "More free open-source tools by Alex"],
            ] as const
          ).map(([id, label]) => (
            <div key={id} className="dn-about-link-row">
              <ExternalLink id={id} onOpen={onOpenLink} describedBy={`${hintBase}-${id}`}>
                {label}
              </ExternalLink>
              <span id={`${hintBase}-${id}`} className="dn-muted dn-about-hint">
                opens browser
              </span>
            </div>
          ))}
        </div>
        <div className="dn-about-folder">
          <span className="dn-muted">Your notes are stored in</span>
          <div className="dn-about-path">
            <span className="dn-path">{settings.dataDir}</span>
            <button type="button" className="dn-btn-outline" onClick={onOpenFolder}>
              <Icon name="folder" size={14} />
              Open folder
            </button>
          </div>
        </div>
        <div className="dn-about-safe">
          <Icon name="shield" />
          No data leaves this computer. The app never connects to the internet on its own.
        </div>
        <div className="dn-muted dn-about-foot">
          Icons derived from Lucide (ISC).{" "}
          <ExternalLink id="notices" onOpen={onOpenLink}>
            Third-party notices
          </ExternalLink>{" "}
          ·{" "}
          <ExternalLink id="license" onOpen={onOpenLink}>
            Licence text
          </ExternalLink>
        </div>
      </div>
    </>
  );
}
