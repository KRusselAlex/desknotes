// Starts the real DeskNotes under tauri-driver, with its own data folder, and gives
// the tests a handle on its windows. Run through `npm run test:e2e`, which wraps the
// run in a hidden display and a private D-Bus session (scripts/e2e/run.sh).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { Session, waitFor } from "./webdriver";

// Outside scripts/e2e/run.sh the app would use the real display, session bus and home
// folder: it could hand over to the owner's DeskNotes, or take notes the owner types.
export function scratchFolder(): string {
  const dir = process.env.DESKNOTES_E2E_TMP;
  if (!dir || !process.env.HOME?.startsWith(dir + "/")) {
    throw new Error("Run the end-to-end tests with `npm run test:e2e` (scripts/e2e/run.sh), never vitest directly.");
  }
  return dir;
}
const SCRATCH = scratchFolder();
const BINARY = realpathSync(resolve(process.env.DESKNOTES_E2E_BINARY ?? "target/release/desknotes"));
const DRIVER = process.env.TAURI_DRIVER ?? "tauri-driver";

/** A fresh, empty data folder (what `XDG_DATA_HOME` points at). */
export function newDataDir(): string {
  return mkdtempSync(join(SCRATCH, "data-"));
}

/** Where DeskNotes keeps its database inside a data folder. */
export function databasePath(dataDir: string): string {
  return join(dataDir, "io.github.krusselalex.desknotes", "desknotes.db");
}

export class App {
  private constructor(
    readonly session: Session,
    private readonly driver: ChildProcess,
    readonly dataDir: string,
  ) {}

  /** Starts DeskNotes on `dataDir` and waits for the manager's lists. */
  static async launch(dataDir: string): Promise<App> {
    await waitFor("no DeskNotes of this run left running", async () => appPids().length === 0);
    const [port, nativePort] = [await freePort(), await freePort()];
    const driver = spawn(DRIVER, ["--port", String(port), "--native-port", String(nativePort)], {
      env: { ...process.env, XDG_DATA_HOME: dataDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
    let app: App | undefined;
    try {
      const base = `http://127.0.0.1:${port}`;
      const session = await waitFor("tauri-driver to start DeskNotes", async () => {
        if (driver.exitCode !== null) throw new Error(`tauri-driver exited (${driver.exitCode})`);
        try {
          return await Session.create(base, { "tauri:options": { application: BINARY } });
        } catch (e) {
          // Retry only while the driver is not listening yet: a failed session may
          // have started an app, and a second one would hand over to it.
          if (e instanceof TypeError) return undefined;
          throw e;
        }
      }, 20_000);
      app = new App(session, driver, dataDir);
      await app.switchToLabel("manager");
      await waitFor("the manager's lists", () => session.execute<boolean>("return !!document.querySelector('[role=tab]')"));
      return app;
    } catch (e) {
      if (app) await app.quit().catch(() => {});
      else stop(driver);
      throw e;
    }
  }

  /**
   * Ends the session, which closes DeskNotes, and waits until its process is gone.
   * A copy still running after that is killed, and the quit fails.
   */
  async quit(): Promise<void> {
    try {
      await this.session.delete();
      await waitFor("DeskNotes to exit", async () => appPids().length === 0, 15_000);
    } finally {
      stop(this.driver);
      for (const pid of appPids()) process.kill(pid, "SIGKILL");
    }
  }

  /** Window labels by handle ("manager", "note-<id>", "settings", …). Keeps the current window. */
  async windows(): Promise<Map<string, string>> {
    const current = await this.session.windowHandle().catch(() => undefined);
    const out = new Map<string, string>();
    for (const handle of await this.session.windowHandles()) {
      try {
        await this.session.switchTo(handle);
        const label = await this.session.execute<string | null>(
          "return window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null",
        );
        if (label) out.set(handle, label);
      } catch {
        // The window closed between listing and switching.
      }
    }
    if (current && out.has(current)) await this.session.switchTo(current);
    return out;
  }

  /**
   * Switches to the manager and makes sure it is on screen. DeskNotes starts with the
   * manager hidden when it has notes to show: this opens it the way the app menu does,
   * by starting DeskNotes again (the new copy hands over and exits).
   */
  async manager(): Promise<void> {
    await this.switchToLabel("manager");
    if (!(await this.onScreen())) await this.openManagerFromMenu();
  }

  /** Starts DeskNotes a second time, as the app menu does, and waits for the manager. */
  async openManagerFromMenu(): Promise<void> {
    const second = spawn(BINARY, [], { env: { ...process.env, XDG_DATA_HOME: this.dataDir }, stdio: "ignore" });
    const code = await Promise.race([
      new Promise<number | null>((done) => second.on("exit", done)),
      new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 10_000)),
    ]);
    if (code !== 0) {
      second.kill("SIGKILL");
      throw new Error(`The second DeskNotes did not hand over and exit (${code})`);
    }
    await this.switchToLabel("manager");
    await waitFor("the manager on screen", () => this.onScreen());
  }

  /** Whether the current window's X window is on screen (mapped and viewable). */
  async onScreen(): Promise<boolean> {
    const rect = await this.session.rect();
    return x11Windows().some(
      (w) => w.viewable && w.width === rect.width && w.height === rect.height && w.x === rect.x && w.y === rect.y,
    );
  }

  /** Switches to the window with this label; waits for it to exist. */
  async switchToLabel(label: string, timeoutMs = 10_000): Promise<void> {
    const handle = await waitFor(
      `window ${label}`,
      async () => [...(await this.windows())].find(([, l]) => l === label)?.[0],
      timeoutMs,
    );
    await this.session.switchTo(handle);
  }

  /** Labels of the open note windows ("note-<id>"). */
  async noteLabels(): Promise<string[]> {
    return [...(await this.windows()).values()].filter((l) => l.startsWith("note-")).sort();
  }
}

export interface X11Window {
  name: string;
  viewable: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The named top-level X windows on the test display, as other programs see them. */
export function x11Windows(): X11Window[] {
  const tree = execFileSync("xwininfo", ["-root", "-children"], { encoding: "utf8" });
  const out: X11Window[] = [];
  for (const m of tree.matchAll(/^\s+(0x[0-9a-f]+) "(.*)": .*$/gm)) {
    const info = execFileSync("xwininfo", ["-id", m[1]!, "-stats"], { encoding: "utf8" });
    const num = (key: string) => Number(new RegExp(`${key}:\\s+(-?\\d+)`).exec(info)?.[1]);
    out.push({
      name: m[2]!,
      viewable: /Map State: IsViewable/.test(info),
      x: num("Absolute upper-left X"),
      y: num("Absolute upper-left Y"),
      width: num("Width"),
      height: num("Height"),
    });
  }
  return out;
}

function stop(driver: ChildProcess): void {
  if (driver.exitCode === null) driver.kill();
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))));
    });
  });
}

/** DeskNotes processes of this run (the binary under test, started inside our scratch folder). */
function appPids(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(`/proc/${entry}/exe`) !== BINARY) continue;
      const env = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      if (env.includes(`DESKNOTES_E2E_TMP=${SCRATCH}`)) pids.push(Number(entry));
    } catch {
      // Not ours, or already gone.
    }
  }
  return pids;
}
