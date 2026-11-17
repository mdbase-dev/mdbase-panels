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
  /** Undo steps to keep. */
  readonly historyLimit?: number;
  /** Delay before a change is written to storage. */
  readonly saveDelay?: number;
}

const quiet = new Set<Operation["type"]>(["activate", "focus"]);

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
  /** True while merged changes are still being folded into the latest undo step. */
  private open = false;

  constructor(options: StoreOptions = {}) {
    this.limit = options.historyLimit ?? 100;
    this.delay = options.saveDelay ?? 200;
    this.storage = options.storage;
    let initial = options.initial ?? emptyWorkspace();
    try {
      const saved = this.storage?.load();
      if (saved !== undefined && saved !== null) {
        initial = fromSnapshot(saved);
      }
    } catch {
      /* A saved workspace that cannot be read is not a reason to fail to start. */
    }
    this.current = initial;
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
    const target = rebase ? normalize(rebase(saved, previous)) : saved;
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
    if (this.storage) {
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

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
