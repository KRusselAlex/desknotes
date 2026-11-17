// The desktop's notification service, played by tests/e2e/notifications.py on the
// tests' private D-Bus session: it records what DeskNotes shows and clicks its buttons.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { scratchFolder } from "./app";
import { waitFor } from "./webdriver";

/** One Notify call, as DeskNotes made it. */
export interface Shown {
  id: number;
  app: string;
  replaces: number;
  icon: string;
  summary: string;
  body: string;
  /** (key, label) pairs; "default" is a click on the notification itself. */
  actions: [string, string][];
  hints: Record<string, unknown>;
  timeout: number;
}

export class Notifications {
  /** Every notification shown, in order. */
  readonly shown: Shown[] = [];
  /** Ids DeskNotes took away (CloseNotification). */
  readonly closed: number[] = [];
  private ready = false;

  private constructor(private readonly service: ChildProcess) {}

  /** Starts the service and waits until it owns its name on the session bus. */
  static async start(): Promise<Notifications> {
    scratchFolder(); // only on the private bus that scripts/e2e/run.sh starts
    const service = spawn("python3", ["-I", resolve("tests/e2e/notifications.py")], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const n = new Notifications(service);
    createInterface({ input: service.stdout! }).on("line", (line) => {
      const event = JSON.parse(line) as { event: string } & Shown;
      if (event.event === "ready") n.ready = true;
      else if (event.event === "notify") n.shown.push(event);
      else if (event.event === "close") n.closed.push(event.id);
    });
    try {
      await waitFor("the notification service", async () => n.ready || (service.exitCode !== null && "exited"));
      if (!n.ready) throw new Error(`The notification service exited (${service.exitCode}): is python3-gi installed?`);
    } catch (e) {
      await n.stop();
      throw e;
    }
    return n;
  }

  /** Waits until `count` notifications have been shown; returns them all. */
  async waitForShown(count: number, timeoutMs = 10_000): Promise<Shown[]> {
    return waitFor(`${count} notifications`, async () => this.shown.length >= count && [...this.shown], timeoutMs);
  }

  /** The person clicks the button `key` ("default": the notification itself). */
  invoke(id: number, key: string): void {
    this.service.stdin!.write(JSON.stringify({ invoke: id, key }) + "\n");
  }

  /** Stops the service and waits until it is gone, so the next one can own the name. */
  async stop(): Promise<void> {
    if (this.service.exitCode !== null || this.service.signalCode !== null) return;
    const gone = new Promise((done) => this.service.once("exit", done));
    this.service.stdin!.end();
    this.service.kill();
    await gone;
  }
}
