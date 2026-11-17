import { describe, expect, it, vi } from "vitest";

import { fromSnapshot, toSnapshot } from "./serialize.js";
import { keepPanels } from "./operations.js";
import { memoryStorage, WorkspaceStore } from "./store.js";
import { mainStacks } from "./tree.js";

const add = (id: string) => ({ type: "add" as const, panel: { id, kind: "doc" } });

describe("store", () => {
  it("undoes and redoes structural changes but not focus changes", () => {
    const store = new WorkspaceStore();
    store.dispatch(add("a"));
    store.dispatch(add("b"));
    store.dispatch({ type: "activate", panel: "a" });
    expect(store.undo()).toBe(true);
    expect(Object.keys(store.state.panels)).toEqual(["a"]);
    expect(store.redo()).toBe(true);
    expect(Object.keys(store.state.panels)).toEqual(["a", "b"]);
    expect(store.canRedo).toBe(false);
  });

  it("folds merged changes into one undo step", () => {
    const store = new WorkspaceStore();
    store.dispatch(add("a"));
    store.dispatch({ type: "add", panel: { id: "nav", kind: "side" }, target: { at: "edge", side: "left" } });
    for (const size of [300, 320, 340]) {
      store.dispatch({ type: "configureEdge", side: "left", options: { size } }, { history: "merge" });
    }
    store.endMerge();
    store.dispatch({ type: "configureEdge", side: "left", options: { size: 400 } }, { history: "merge" });
    store.undo();
    expect(store.state.edges.left?.size).toBe(340);
    store.undo();
    expect(store.state.edges.left?.size).toBe(280);
  });

  it("can rewind the arrangement while keeping the panels that are open now", () => {
    const store = new WorkspaceStore();
    for (const id of ["a", "b", "d"]) {
      store.dispatch(add(id), { history: "skip" });
    }
    store.dispatch({ type: "move", panel: "b", target: { at: "root", side: "right" } });
    store.dispatch({ type: "remove", panel: "d" }, { history: "skip" });
    store.dispatch(add("c"), { history: "skip" });
    store.dispatch({ type: "update", panel: "b", changes: { title: "B" } }, { history: "skip" });
    expect(mainStacks(store.state).map(({ panels }) => panels)).toEqual([["a"], ["b", "c"]]);
    expect(store.undo(keepPanels)).toBe(true);
    // The split is gone, but "d" stays closed and "c" stays open.
    expect(mainStacks(store.state).map(({ panels }) => [...panels].sort())).toEqual([["a", "b", "c"]]);
    expect(store.state.panels["b"]?.title).toBe("B");
    expect(store.redo(keepPanels)).toBe(true);
    expect(mainStacks(store.state).map(({ panels }) => panels)).toEqual([["a"], ["b", "c"]]);
  });

  it("tells subscribers what changed and ignores operations that change nothing", () => {
    const store = new WorkspaceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch(add("a"));
    store.dispatch({ type: "activate", panel: "a" });
    store.dispatch({ type: "remove", panel: "missing" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ operation: { type: "add" }, animate: true });
  });

  it("saves to storage and starts from what was saved", () => {
    const storage = memoryStorage();
    const store = new WorkspaceStore({ storage, saveDelay: 0 });
    store.dispatch(add("a"));
    store.dispatch({ type: "add", panel: { id: "b", kind: "doc", data: { source: "x" } }, target: { at: "root", side: "right" } });
    store.flush();
    expect(storage.value).toMatchObject({ format: "mdbase-panels", version: 1 });
    const reopened = new WorkspaceStore({ storage });
    expect(reopened.state).toEqual(store.state);
    expect(mainStacks(reopened.state)).toHaveLength(2);
  });

  it("starts empty when the saved workspace cannot be read", () => {
    const store = new WorkspaceStore({ storage: memoryStorage({ format: "mdbase-panels", version: 99 }) });
    expect(store.state.root).toBeNull();
  });
});

describe("snapshots", () => {
  it("rejects anything that is not a workspace", () => {
    expect(() => fromSnapshot(null)).toThrow();
    expect(() => fromSnapshot({ format: "other", version: 1, workspace: {} })).toThrow();
    expect(() => fromSnapshot({ format: "mdbase-panels", version: 1, workspace: { root: 3 } })).toThrow();
  });

  it("repairs a snapshot that refers to panels it does not describe", () => {
    const store = new WorkspaceStore();
    store.dispatch(add("a"));
    store.dispatch(add("b"));
    const snapshot = toSnapshot(store.state) as { workspace: { panels: Record<string, unknown> } };
    delete snapshot.workspace.panels["b"];
    const state = fromSnapshot(snapshot);
    expect(mainStacks(state)[0]).toMatchObject({ panels: ["a"], active: "a" });
  });
});
