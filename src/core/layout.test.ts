import { describe, expect, it } from "vitest";

import { dropTargetAt } from "./drop.js";
import { computeLayout } from "./layout.js";
import { apply } from "./operations.js";
import { resizeSplitter } from "./resize.js";
import { emptyWorkspace, stackOfPanel } from "./tree.js";
import { type Operation, type WorkspaceState } from "./types.js";

const run = (operations: readonly Operation[]): WorkspaceState =>
  operations.reduce(apply, emptyWorkspace());
const add = (id: string, target?: Extract<Operation, { type: "add" }>["target"]): Operation => ({
  type: "add",
  panel: { id, kind: "doc" },
  ...(target ? { target } : {}),
});
const size = { width: 1200, height: 800 };

const sides: Operation[] = [
  { type: "add", panel: { id: "nav", kind: "side" }, target: { at: "edge", side: "left" }, activate: false },
  { type: "add", panel: { id: "notes", kind: "side" }, target: { at: "edge", side: "right" }, activate: false },
  { type: "configureEdge", side: "left", options: { size: 260, priority: 1 } },
  { type: "configureEdge", side: "right", options: { size: 340, priority: 0 } },
];

describe("layout", () => {
  it("gives edge regions their size and the rest to the main area", () => {
    const layout = computeLayout(run([add("a"), ...sides]), size);
    expect(layout.mode).toBe("tiling");
    expect(layout.main).toEqual({ x: 261, y: 0, width: 598, height: 800 });
    expect(layout.stacks.find(({ edge }) => edge === "left")?.rect).toMatchObject({ x: 0, width: 260 });
    expect(layout.stacks.find(({ edge }) => edge === "right")?.rect).toMatchObject({ x: 860, width: 340 });
  });

  it("lets the lowest-priority edge give way when the main area would be too narrow", () => {
    const layout = computeLayout(run([add("a"), ...sides]), { width: 760, height: 800 });
    expect(layout.yielded).toEqual(["right"]);
    expect(layout.stacks.some(({ edge }) => edge === "right")).toBe(false);
    expect(layout.panels.find(({ id }) => id === "notes")?.visible).toBe(false);
    expect(layout.main.width).toBe(760 - 261);
  });

  it("shows one panel when the workspace is narrower than the compact width", () => {
    const state = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" }), ...sides]);
    const layout = computeLayout(state, { width: 400, height: 700 }, { compactBelow: 681 });
    expect(layout.mode).toBe("stack");
    expect(layout.panels.filter(({ visible }) => visible).map(({ id }) => id)).toEqual(["b"]);
    expect(layout.panels.find(({ id }) => id === "b")?.rect).toEqual({ x: 0, y: 0, width: 400, height: 700 });
    expect(layout.splitters).toEqual([]);
  });

  it("fills the workspace with a maximized stack and hides the edges", () => {
    const start = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" }), ...sides]);
    const state = apply(start, { type: "maximize", stack: start.focus });
    const layout = computeLayout(state, size);
    expect(layout.stacks).toHaveLength(1);
    expect(layout.stacks[0]?.rect).toEqual({ x: 0, y: 0, ...size });
  });

  it("scales every panel into a card in the overview", () => {
    const state = run([add("a"), add("b"), add("c", { at: "beside", panel: "a", side: "right" })]);
    const layout = computeLayout(state, size, { overview: true });
    expect(layout.mode).toBe("overview");
    expect(layout.cards.map(({ panel }) => panel).sort()).toEqual(["a", "b", "c"]);
    expect(layout.panels.every(({ visible, scale }) => visible && scale < 1)).toBe(true);
  });
});

describe("splitters", () => {
  it("turns a drag into a resize that moves the boundary by the same distance", () => {
    const state = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" })]);
    const layout = computeLayout(state, size);
    const splitter = layout.splitters.find(({ kind }) => kind === "split");
    expect(splitter).toBeDefined();
    const result = splitter && resizeSplitter(splitter, 120);
    expect(result?.moved).toBe(120);
    const next = computeLayout(apply(state, result?.operation ?? { type: "flatten" }), size);
    const before = layout.stacks[0]?.rect.width ?? 0;
    expect(next.stacks[0]?.rect.width).toBeCloseTo(before + 120, 0);
  });

  it("stops at a stack's minimum width", () => {
    const state = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" })]);
    const layout = computeLayout(state, size);
    const splitter = layout.splitters.find(({ kind }) => kind === "split");
    const result = splitter && resizeSplitter(splitter, -5000);
    const next = computeLayout(apply(state, result?.operation ?? { type: "flatten" }), size);
    expect(next.stacks[0]?.rect.width).toBeGreaterThanOrEqual(180);
  });

  it("resizes an edge region", () => {
    const state = run([add("a"), ...sides]);
    const splitter = computeLayout(state, size).splitters.find(
      ({ kind, rect }) => kind === "edge" && rect.x < 400,
    );
    const result = splitter && resizeSplitter(splitter, 40);
    expect(result?.operation).toMatchObject({ type: "configureEdge", side: "left", options: { size: 300 } });
  });
});

describe("drop targets", () => {
  const state = run([add("a"), add("b"), add("c", { at: "beside", panel: "a", side: "right" })]);
  const layout = computeLayout(state, size);
  const left = stackOfPanel(state, "a")?.id ?? "";
  const right = stackOfPanel(state, "c")?.id ?? "";

  it("joins a stack when dropped in the middle of its body", () => {
    expect(dropTargetAt(state, layout, "c", { x: 300, y: 400 })?.target).toEqual({ at: "stack", stack: left });
  });

  it("splits a stack when dropped near a side of its body", () => {
    expect(dropTargetAt(state, layout, "b", { x: 900, y: 780 })?.target).toEqual({
      at: "split",
      stack: right,
      side: "bottom",
    });
  });

  it("splits the whole main area from its outer band", () => {
    expect(dropTargetAt(state, layout, "b", { x: 4, y: 400 })?.target).toEqual({ at: "root", side: "left" });
  });

  it("places a tab by the measured tab boxes", () => {
    const tabs = [{ x: 0, y: 0, width: 100, height: 36 }];
    const target = dropTargetAt(state, layout, "c", { x: 20, y: 10 }, { tabs: () => tabs });
    expect(target?.target).toEqual({ at: "stack", stack: left, index: 0 });
    const after = dropTargetAt(state, layout, "c", { x: 90, y: 10 }, { tabs: () => tabs });
    expect(after?.target).toEqual({ at: "stack", stack: left, index: 1 });
  });

  it("does not split a lone panel away from itself", () => {
    expect(dropTargetAt(state, layout, "c", { x: 1190, y: 400 })?.target).toEqual({ at: "stack", stack: right });
  });

  it("accepts nothing while one panel fills the workspace", () => {
    const compact = computeLayout(state, { width: 400, height: 700 }, { compactBelow: 681 });
    expect(dropTargetAt(state, compact, "a", { x: 100, y: 300 })).toBeNull();
  });
});
