import { describe, expect, it, vi } from "vitest";

import { arrangementOf, compose, parseArrangement, parseWindowState, sameArrangement, windowOf } from "./arrangement.js";
import { violations } from "./invariants.js";
import { apply } from "./operations.js";
import { memoryStorage, WorkspaceStore, type SharedStorage } from "./store.js";
import { emptyWorkspace, findStack, stackOfPanel } from "./tree.js";
import { type Operation, type WorkspaceState } from "./types.js";

const run = (operations: readonly Operation[], from = emptyWorkspace()): WorkspaceState =>
  operations.reduce((state, operation) => apply(state, operation), from);

function workspace(): WorkspaceState {
  return run([
    { type: "add", panel: { id: "a", kind: "doc" } },
    { type: "add", panel: { id: "b", kind: "doc" } },
    { type: "add", panel: { id: "c", kind: "doc" }, target: { at: "split", stack: "n1", side: "right" } },
    { type: "add", panel: { id: "nav", kind: "nav", leads: false }, target: { at: "edge", side: "left" } },
    { type: "add", panel: { id: "notes", kind: "notes", follows: "leader" }, target: { at: "edge", side: "right" } },
    { type: "activate", panel: "c" },
  ]);
}

describe("arrangement and window state", () => {
  it("put back together they are the state they were taken from", () => {
    for (const view of ["tiling", "columns", "canvas"] as const) {
      const state = run([{ type: "setView", view }, { type: "setCamera", camera: { x: 40, zoom: 0.5 } }], workspace());
      const again = compose(
        parseArrangement(JSON.parse(JSON.stringify(arrangementOf(state)))),
        parseWindowState(JSON.parse(JSON.stringify(windowOf(state)))),
      );
      expect(violations(again)).toEqual([]);
      expect(again).toEqual(state);
    }
  });

  it("looking around changes the window state and never the arrangement", () => {
    const state = run([{ type: "setView", view: "canvas" }], workspace());
    const looked = run(
      [
        { type: "activate", panel: "a" },
        { type: "focus", stack: stackOfPanel(state, "c")?.id ?? "" },
        { type: "configureEdge", side: "left", options: { visible: false } },
        { type: "maximize", stack: "n1" },
        { type: "setCamera", camera: { x: 300, y: -20, zoom: 2 } },
        { type: "activate", panel: "notes" },
      ],
      state,
    );
    expect(sameArrangement(state, looked)).toBe(true);
    expect(windowOf(looked)).not.toEqual(windowOf(state));
  });

  it("opening, closing, moving and resizing change the arrangement", () => {
    const state = workspace();
    const changes: Operation[] = [
      { type: "add", panel: { id: "d", kind: "doc" } },
      { type: "remove", panel: "b" },
      { type: "move", panel: "a", target: { at: "edge", side: "left" } },
      { type: "configureEdge", side: "left", options: { size: 320 } },
      { type: "update", panel: "a", changes: { title: "A" } },
      { type: "follow", panel: "notes", follows: { pane: "n1" } },
      { type: "setView", view: "canvas" },
    ];
    for (const change of changes) {
      expect(sameArrangement(state, run([change], state)), change.type).toBe(false);
    }
  });

  it("an arrangement opens without a window state, with every side region showing", () => {
    const state = compose(arrangementOf(run([{ type: "configureEdge", side: "left", options: { visible: false } }], workspace())));
    expect(violations(state)).toEqual([]);
    expect(state.edges.left?.visible).toBe(true);
    expect(findStack(state, "n1")?.active).toBe("a");
  });

  it("a window keeps its own view of an arrangement that changed under it", () => {
    const mine = run([{ type: "activate", panel: "a" }, { type: "configureEdge", side: "right", options: { visible: false } }], workspace());
    const theirs = run([{ type: "add", panel: { id: "d", kind: "doc" }, target: { at: "stack", stack: "n1" } }, { type: "remove", panel: "c" }], workspace());
    const state = compose(arrangementOf(theirs), windowOf(mine));
    expect(violations(state)).toEqual([]);
    expect(findStack(state, "n1")?.panels).toEqual(["a", "b", "d"]);
    expect(findStack(state, "n1")?.active).toBe("a");
    expect(state.focus).toBe("n1");
    expect(state.edges.right?.visible).toBe(false);
  });

  it("refuses what is not an arrangement", () => {
    expect(() => parseArrangement({ format: "mdbase-panels", version: 1 })).toThrow();
    expect(() => parseArrangement({ ...arrangementOf(workspace()), panels: { a: { id: "b", kind: "doc" } } })).toThrow();
    expect(() => parseWindowState(null)).toThrow();
  });
});

/** Two windows on one arrangement: what one saves, the other is told. */
function sharedPair(): { open: () => { store: WorkspaceStore; window: ReturnType<typeof memoryStorage> }; writes: () => number } {
  let arrangement: unknown;
  let writes = 0;
  const watchers = new Set<{ owner: object; changed: (value: unknown) => void }>();
  return {
    writes: () => writes,
    open: () => {
      const owner = {};
      const window = memoryStorage();
      const shared: SharedStorage = {
        arrangement: {
          load: () => arrangement,
          save: (value) => {
            writes += 1;
            arrangement = JSON.parse(JSON.stringify(value));
            for (const watcher of watchers) {
              if (watcher.owner !== owner) {
                watcher.changed(arrangement);
              }
            }
          },
          watch: (changed) => {
            const watcher = { owner, changed };
            watchers.add(watcher);
            return () => watchers.delete(watcher);
          },
        },
        window,
      };
      return { store: new WorkspaceStore({ shared, saveDelay: 0 }), window };
    },
  };
}

describe("a store with shared storage", () => {
  it("saves the arrangement only when it changes, and the window state on its own", () => {
    vi.useFakeTimers();
    const pair = sharedPair();
    const { store, window } = pair.open();
    store.dispatch({ type: "add", panel: { id: "a", kind: "doc" } });
    store.dispatch({ type: "add", panel: { id: "b", kind: "doc" } });
    vi.runAllTimers();
    expect(pair.writes()).toBe(1);
    store.dispatch({ type: "activate", panel: "a" });
    vi.runAllTimers();
    expect(pair.writes()).toBe(1);
    expect(parseWindowState(window.value).active).toEqual({ n1: "a" });
    vi.useRealTimers();
  });

  it("two windows share what is open and keep their own tab in front", () => {
    vi.useFakeTimers();
    const pair = sharedPair();
    const first = pair.open().store;
    first.dispatch({ type: "add", panel: { id: "a", kind: "doc" } });
    first.dispatch({ type: "add", panel: { id: "b", kind: "doc" } });
    vi.runAllTimers();
    const second = pair.open().store;
    expect(findStack(second.state, "n1")?.panels).toEqual(["a", "b"]);
    second.dispatch({ type: "activate", panel: "a" });
    vi.runAllTimers();
    first.dispatch({ type: "add", panel: { id: "c", kind: "doc" } });
    vi.runAllTimers();
    expect(findStack(second.state, "n1")?.panels).toEqual(["a", "b", "c"]);
    expect(findStack(second.state, "n1")?.active).toBe("a");
    expect(findStack(first.state, "n1")?.active).toBe("c");
    // Being told is not a change of the second window's own, so nothing is written back.
    expect(pair.writes()).toBe(2);
    second.dispose();
    first.dispatch({ type: "remove", panel: "a" });
    vi.runAllTimers();
    expect(findStack(second.state, "n1")?.panels).toEqual(["a", "b", "c"]);
    vi.useRealTimers();
  });

  it("adopting an arrangement drops undo steps and lets the app adjust what arrives", () => {
    const store = new WorkspaceStore();
    store.dispatch({ type: "add", panel: { id: "a", kind: "doc" } });
    store.dispatch({ type: "add", panel: { id: "b", kind: "doc" } });
    const other = apply(store.state, { type: "remove", panel: "b" });
    const kept = store.state.panels["b"];
    expect(
      store.adopt(arrangementOf(other), (state) =>
        kept ? apply(state, { type: "add", panel: kept, activate: false }) : state,
      ),
    ).toBe(true);
    expect(Object.keys(store.state.panels).sort()).toEqual(["a", "b"]);
    expect(store.canUndo).toBe(false);
    expect(store.adopt(arrangementOf(store.state))).toBe(false);
  });
});
