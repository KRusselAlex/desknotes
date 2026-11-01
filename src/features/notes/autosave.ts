// Autosave for one note. Framework-free so it can be tested with fake timers.
//
// Guarantees:
// - no write per keystroke: waits `debounceMs` after the last change;
// - continuous typing still saves at least every `maxWaitMs`;
// - one save in flight at a time; only the newest content is written next;
// - a failed save keeps the content in memory and reports "error" until a
//   later save succeeds. Nothing is dropped silently.

export type SaveState = "saved" | "pending" | "saving" | "error";

export interface AutosaveOptions {
  save: (content: string) => Promise<void>;
  onStateChange?: (state: SaveState, error?: string) => void;
  debounceMs?: number;
  maxWaitMs?: number;
}

export class Autosave {
  private pending: string | null = null;
  private draining: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SaveState = "saved";
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.maxWaitMs = options.maxWaitMs ?? 2000;
  }

  get currentState(): SaveState {
    return this.state;
  }

  /** True while some content has not been confirmed as written. */
  get hasUnsavedChanges(): boolean {
    return this.pending !== null || this.draining !== null || this.state === "error";
  }

  /** Record new content. Cheap; call it on every editor update. */
  change(content: string): void {
    this.pending = content;
    if (this.state !== "error") this.setState("pending");
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
    this.maxWaitTimer ??= setTimeout(() => void this.flush(), this.maxWaitMs);
  }

  /**
   * Write everything now. Resolves once all content known at call time is
   * saved, or when a save fails (check `currentState`). Never rejects.
   */
  flush(): Promise<void> {
    this.clearTimers();
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Stop timers without saving. Call `flush()` first when closing. */
  dispose(): void {
    this.clearTimers();
  }

  private async drain(): Promise<void> {
    while (this.pending !== null) {
      const snapshot = this.pending;
      this.pending = null;
      this.setState("saving");
      try {
        await this.options.save(snapshot);
      } catch (error) {
        // Keep the content unless something newer already replaced it.
        this.pending ??= snapshot;
        this.setState("error", error instanceof Error ? error.message : String(error));
        return;
      }
    }
    this.setState("saved");
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }

  private setState(state: SaveState, error?: string): void {
    this.state = state;
    this.options.onStateChange?.(state, error);
  }
}
