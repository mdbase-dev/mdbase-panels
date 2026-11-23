import {
  arrangementOf,
  compose,
  parseArrangement,
  parseWindowState,
  windowOf,
  type Arrangement,
  type WindowState,
} from "./arrangement.js";
import { normalize } from "./normalize.js";
import { apply } from "./operations.js";
import { fromSnapshot, toSnapshot } from "./serialize.js";
import { emptyWorkspace } from "./tree.js";
import { type Operation, type WorkspaceState } from "./types.js";

/** Where a workspace is kept between sessions. Every level is optional. */
export interface WorkspaceStorage {
  load(): unknown;
  save(snapshot: unknown): void;
}

/**
 * Where a workspace is kept as its two halves: the arrangement, which every window showing the
 * workspace shares, and this window's own state. `watch` reports an arrangement saved by
 * another window, which the store then adopts.
 */
export interface SharedStorage {
  readonly arrangement: WorkspaceStorage & {
    readonly watch?: (changed: (arrangement: unknown) => void) => () => void;
  };
  readonly window: WorkspaceStorage;
}

export interface DispatchOptions {
  /**
   * How the change joins the undo history. `record` (the default) makes it one undoable step;
   * `merge` folds it into the previous step (a splitter drag is one step, not hundreds);
   * `skip` leaves history alone (focus changes, or anything the app replays itself).
   */
  readonly history?: "record" | "merge" | "skip";
  /** Ask the view to animate from the old layout to the new one. Defaults to true. */
  readonly animate?: boolean;
}

export interface WorkspaceChange {
  readonly state: WorkspaceState;
  readonly previous: WorkspaceState;
  readonly operation: Operation;
  readonly animate: boolean;
}

/**
 * Adjusts the state an undo or redo is about to restore, given the state being left. Use
 * `keepPanels` to rewind the arrangement without closing or reopening anything.
 */
export type Rebase = (target: WorkspaceState, current: WorkspaceState) => WorkspaceState;

export interface StoreOptions {
  readonly initial?: WorkspaceState;
  readonly storage?: WorkspaceStorage;
  /** Keep the arrangement and the window state apart, instead of `storage`. */
  readonly shared?: SharedStorage;
  /** Undo steps to keep. */
  readonly historyLimit?: number;
  /** Delay before a change is written to storage. */
  readonly saveDelay?: number;
}

const quiet = new Set<Operation["type"]>(["activate", "focus", "lead", "setCamera"]);

/** Holds a workspace, applies operations to it, and tells subscribers. */
export class WorkspaceStore {
  private current: WorkspaceState;
  private past: WorkspaceState[] = [];
  private future: WorkspaceState[] = [];
  private listeners = new Set<(change: WorkspaceChange) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly limit: number;
  private readonly delay: number;
  private readonly storage: WorkspaceStorage | undefined;
  private readonly shared: SharedStorage | undefined;
  /** The arrangement and window state as last read or written, so only changes are saved. */
  private saved: { arrangement: string | null; window: string | null } = {
    arrangement: null,
    window: null,
  };
  private unwatch: (() => void) | undefined;
  /** True while merged changes are still being folded into the latest undo step. */
  private open = false;

  constructor(options: StoreOptions = {}) {
    this.limit = options.historyLimit ?? 100;
    this.delay = options.saveDelay ?? 200;
    this.storage = options.shared ? undefined : options.storage;
    this.shared = options.shared;
    let initial = options.initial ?? emptyWorkspace();
    try {
      const saved = this.storage?.load();
      if (saved !== undefined && saved !== null) {
        initial = fromSnapshot(saved);
      }
      const arrangement = this.shared?.arrangement.load();
      if (arrangement !== undefined && arrangement !== null) {
        initial = compose(parseArrangement(arrangement), readWindow(this.shared?.window.load()));
      }
    } catch {
      /* A saved workspace that cannot be read is not a reason to fail to start. */
    }
    this.current = initial;
    if (this.shared) {
      this.saved = {
        arrangement: JSON.stringify(arrangementOf(initial)),
        window: JSON.stringify(windowOf(initial)),
      };
      this.unwatch = this.shared.arrangement.watch?.((value) => {
        try {
          this.adopt(parseArrangement(value));
        } catch {
          /* Another window's arrangement that cannot be read is ignored. */
        }
      });
    }
  }

  /** Stop listening for arrangements from other windows. */
  dispose(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /**
   * Take an arrangement made somewhere else (another window, a synced record) and keep looking
   * at it the way this window was. Undo history is dropped: its steps were arrangements of this
   * window's own making, and stepping back to one would undo the other window's work.
   */
  adopt(arrangement: Arrangement, adjust?: (state: WorkspaceState) => WorkspaceState): boolean {
    const text = JSON.stringify(arrangement);
    if (text === JSON.stringify(arrangementOf(this.current))) {
      return false;
    }
    const previous = this.current;
    const composed = compose(arrangement, windowOf(previous));
    const next = adjust ? normalize(adjust(composed)) : composed;
    this.clearHistory();
    // What arrived is what is saved; only what `adjust` changed is this window's to write.
    this.saved = { ...this.saved, arrangement: text };
    this.commit(next, previous, { type: "load", state: next }, true);
    return true;
  }

  get state(): WorkspaceState {
    return this.current;
  }
  getState = (): WorkspaceState => this.current;

  subscribe = (listener: (change: WorkspaceChange) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch(operation: Operation, options: DispatchOptions = {}): WorkspaceState {
    const previous = this.current;
    const next = apply(previous, operation);
    if (next === previous) {
      return previous;
    }
    const history = options.history ?? (quiet.has(operation.type) ? "skip" : "record");
    if (history === "record" || (history === "merge" && !this.open)) {
      this.past.push(previous);
      if (this.past.length > this.limit) {
        this.past.shift();
      }
    }
    if (history !== "skip") {
      this.future = [];
      this.open = history === "merge";
    }
    this.commit(next, previous, operation, options.animate ?? true);
    return next;
  }

  /** Forget undo and redo steps, for example once an app has finished arranging its first layout. */
  clearHistory(): void {
    this.past = [];
    this.future = [];
    this.open = false;
  }

  /** Close the current run of merged changes, so the next one starts a new undo step. */
  endMerge(): void {
    this.open = false;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(rebase?: Rebase): boolean {
    return this.travel(this.past, this.future, rebase);
  }

  redo(rebase?: Rebase): boolean {
    return this.travel(this.future, this.past, rebase);
  }

  private travel(from: WorkspaceState[], to: WorkspaceState[], rebase?: Rebase): boolean {
    const saved = from.pop();
    if (!saved) {
      return false;
    }
    this.open = false;
    const previous = this.current;
    // Where the canvas is looking is not something to undo, any more than a scroll position is.
    const kept = { ...saved, canvas: { ...saved.canvas, camera: previous.canvas.camera } };
    const target = normalize(rebase ? rebase(kept, previous) : kept);
    to.push(previous);
    this.commit(target, previous, { type: "load", state: target }, true);
    return true;
  }

  /** Write to storage now (for example before the page is hidden). */
  flush = (): void => {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.storage?.save(toSnapshot(this.current));
      if (this.shared) {
        const arrangement = arrangementOf(this.current);
        const window = windowOf(this.current);
        const next = { arrangement: JSON.stringify(arrangement), window: JSON.stringify(window) };
        if (next.arrangement !== this.saved.arrangement) {
          this.shared.arrangement.save(arrangement);
        }
        if (next.window !== this.saved.window) {
          this.shared.window.save(window);
        }
        this.saved = next;
      }
    } catch {
      /* Losing a saved layout must never interrupt the app. */
    }
  };

  private commit(
    state: WorkspaceState,
    previous: WorkspaceState,
    operation: Operation,
    animate: boolean,
  ): void {
    this.current = state;
    for (const listener of [...this.listeners]) {
      listener({ state, previous, operation, animate });
    }
    if (this.storage || this.shared) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.flush, this.delay);
    }
  }
}

/** Keeps a workspace only for the life of the page. Useful in tests. */
export function memoryStorage(initial?: unknown): WorkspaceStorage & { readonly value: unknown } {
  let value = initial;
  return {
    load: () => value,
    save: (snapshot) => {
      value = snapshot;
    },
    get value() {
      return value;
    },
  };
}

/** Keeps a workspace in the browser's local (or session) storage under one key. */
export function webStorage(
  key: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
): WorkspaceStorage {
  return {
    load: () => {
      const text = storage?.getItem(key);
      return text ? (JSON.parse(text) as unknown) : undefined;
    },
    save: (snapshot) => storage?.setItem(key, JSON.stringify(snapshot)),
  };
}

function readWindow(value: unknown): WindowState | null {
  try {
    return value === undefined || value === null ? null : parseWindowState(value);
  } catch {
    return null;
  }
}

/**
 * Keeps a workspace in the browser as its two halves. The arrangement goes in local storage
 * under `<key>:arrangement`, where every window on the same origin reads and watches it. The
 * window state goes in session storage, which each window (tab) has to itself and keeps across
 * a reload; a copy in local storage gives a new window the state of the one used last.
 */
export function webSharedStorage(
  key: string,
  local: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
  session: Pick<Storage, "getItem" | "setItem"> | null = safeSessionStorage(),
): SharedStorage {
  const read = (storage: Pick<Storage, "getItem"> | null, name: string): unknown => {
    const text = storage?.getItem(name);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  const arrangementKey = `${key}:arrangement`;
  const windowKey = `${key}:window`;
  return {
    arrangement: {
      load: () => read(local, arrangementKey),
      save: (value) => local?.setItem(arrangementKey, JSON.stringify(value)),
      watch: (changed) => {
        const listener = (event: StorageEvent): void => {
          if (event.key === arrangementKey && event.newValue) {
            try {
              changed(JSON.parse(event.newValue) as unknown);
            } catch {
              /* Not JSON: not ours. */
            }
          }
        };
        globalThis.addEventListener?.("storage", listener);
        return () => globalThis.removeEventListener?.("storage", listener);
      },
    },
    window: {
      load: () => read(session, windowKey) ?? read(local, windowKey),
      save: (value) => {
        const text = JSON.stringify(value);
        session?.setItem(windowKey, text);
        local?.setItem(windowKey, text);
      },
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}
