// A small W3C WebDriver client: just the calls the end-to-end tests use.
// tauri-driver forwards these to WebKitWebDriver, which drives every DeskNotes
// webview (the manager and each note window) as a window handle.

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export interface Element {
  [ELEMENT_KEY]: string;
}

export class WebDriverError extends Error {
  constructor(
    readonly command: string,
    readonly error: string,
    message: string,
  ) {
    super(`${command}: ${error}: ${message}`);
  }
}

export class Session {
  constructor(
    private readonly base: string,
    readonly id: string,
  ) {}

  static async create(base: string, capabilities: Record<string, unknown>): Promise<Session> {
    const value = await request<{ sessionId: string }>(base, "POST", "/session", {
      capabilities: { alwaysMatch: capabilities },
    });
    return new Session(base, value.sessionId);
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  delete(): Promise<void> {
    return this.call("DELETE", "");
  }

  windowHandle(): Promise<string> {
    return this.call("GET", "/window");
  }

  windowHandles(): Promise<string[]> {
    return this.call("GET", "/window/handles");
  }

  switchTo(handle: string): Promise<void> {
    return this.call("POST", "/window", { handle });
  }

  /** The current window's position and size, in screen pixels. */
  rect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.call("GET", "/window/rect");
  }

  url(): Promise<string> {
    return this.call("GET", "/url");
  }

  title(): Promise<string> {
    return this.call("GET", "/title");
  }

  /** Runs `script` as a function body in the current window; `arguments` holds `args`. */
  execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.call("POST", "/execute/sync", { script, args });
  }

  /** Like `execute`, for a script that ends by calling `arguments[arguments.length - 1]`. */
  executeAsync<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.call("POST", "/execute/async", { script, args });
  }

  find(css: string): Promise<Element> {
    return this.call("POST", "/element", { using: "css selector", value: css });
  }

  findAll(css: string): Promise<Element[]> {
    return this.call("POST", "/elements", { using: "css selector", value: css });
  }

  click(el: Element): Promise<void> {
    return this.call("POST", `/element/${el[ELEMENT_KEY]}/click`, {});
  }

  /** Moves the pointer over the element's centre (for controls shown on hover). */
  hover(el: Element): Promise<void> {
    return this.call("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [{ type: "pointerMove", duration: 0, origin: el, x: 0, y: 0 }],
        },
      ],
    });
  }

  /** Types `text` into the element, as key presses. */
  type(el: Element, text: string): Promise<void> {
    return this.call("POST", `/element/${el[ELEMENT_KEY]}/value`, { text });
  }

  text(el: Element): Promise<string> {
    return this.call("GET", `/element/${el[ELEMENT_KEY]}/text`);
  }
}

async function request<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as { value: T | { error: string; message: string } };
  if (!res.ok) {
    const v = json.value as { error: string; message: string };
    throw new WebDriverError(`${method} ${path}`, v.error, v.message);
  }
  return json.value as T;
}

/** Retries `fn` until it returns a value other than undefined/null/false, or throws after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== null && v !== false) return v;
      last = undefined;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
