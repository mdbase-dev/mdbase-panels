import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { violations } from "./invariants.js";
import { computeLayout } from "./layout.js";
import { normalize } from "./normalize.js";
import { apply } from "./operations.js";
import { fromSnapshot, toSnapshot } from "./serialize.js";
import { allStacks, emptyWorkspace, mainStacks, stackOfPanel } from "./tree.js";
import {
  edgeSides,
  type Operation,
  type PanelDescriptor,
  type Target,
  viewModes,
  type WorkspaceState,
} from "./types.js";

// "f" is a follower: it shows something about another panel and never leads.
const panel = (id: string): PanelDescriptor =>
  id === "f" ? { id, kind: "tool", leads: false } : { id, kind: "doc" };
const run = (operations: readonly Operation[], from = emptyWorkspace()): WorkspaceState =>
  operations.reduce(apply, from);
const add = (id: string, target?: Target): Operation => ({
  type: "add",
  panel: panel(id),
  ...(target ? { target } : {}),
});

describe("operations", () => {
  it("opens a new top-level column next to the column that holds the focused stack", () => {
    const start = run([
      add("a"),
      add("b", { at: "beside", panel: "a", side: "right" }),
      add("c", { at: "beside", panel: "a", side: "bottom" }),
    ]);
    // Focus is on "c", nested inside the first column.
    const state = apply(start, add("d", { at: "column", side: "right" }));
    expect(state.root?.type === "split" && state.root.children.map((child) => child.type)).toEqual([
      "split",
      "stack",
      "stack",
    ]);
    expect(mainStacks(state).map(({ panels }) => panels)).toEqual([["a"], ["c"], ["d"], ["b"]]);
    // Without a row at the root the new column goes beside the whole main area.
    const lone = run([add("a"), add("b", { at: "column", side: "left" })]);
    expect(mainStacks(lone).map(({ panels }) => panels)).toEqual([["b"], ["a"]]);
  });

  it("opens the first panel as the root stack and focuses it", () => {
    const state = run([add("a")]);
    expect(state.root).toMatchObject({ type: "stack", panels: ["a"], active: "a" });
    expect(state.focus).toBe(state.root?.id);
  });

  it("adds tabs to the focused stack", () => {
    const state = run([add("a"), add("b")]);
    expect(mainStacks(state)).toHaveLength(1);
    expect(mainStacks(state)[0]).toMatchObject({ panels: ["a", "b"], active: "b" });
  });

  it("opens a panel beside another", () => {
    const state = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" })]);
    expect(state.root).toMatchObject({ type: "split", direction: "row", sizes: [0.5, 0.5] });
    expect(mainStacks(state).map(({ panels }) => panels)).toEqual([["a"], ["b"]]);
    expect(state.focus).toBe(stackOfPanel(state, "b")?.id);
  });

  it("keeps a row flat when splitting inside it", () => {
    const state = run([
      add("a"),
      add("b", { at: "beside", panel: "a", side: "right" }),
      add("c", { at: "beside", panel: "b", side: "right" }),
    ]);
    expect(state.root).toMatchObject({ type: "split", direction: "row" });
    expect(state.root?.type === "split" && state.root.children).toHaveLength(3);
    const sizes = state.root?.type === "split" ? state.root.sizes : [];
    expect(sizes.map((size) => Math.round(size * 1000))).toEqual([333, 333, 333]);
  });

  it("halves the neighbour when the row has been resized", () => {
    const row = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" })]);
    const state = run(
      [
        { type: "resize", split: row.root?.id ?? "", sizes: [0.6, 0.4] },
        add("c", { at: "beside", panel: "b", side: "right" }),
      ],
      row,
    );
    const sizes = state.root?.type === "split" ? state.root.sizes : [];
    expect(sizes.map((size) => Math.round(size * 1000))).toEqual([600, 200, 200]);
  });

  it("nests a column inside a row", () => {
    const state = run([
      add("a"),
      add("b", { at: "beside", panel: "a", side: "right" }),
      add("c", { at: "beside", panel: "b", side: "bottom" }),
    ]);
    const root = state.root;
    expect(root?.type === "split" && root.children[1]).toMatchObject({
      type: "split",
      direction: "column",
    });
  });

  it("collapses a split when a stack empties", () => {
    const state = run([
      add("a"),
      add("b", { at: "beside", panel: "a", side: "right" }),
      { type: "remove", panel: "b" },
    ]);
    expect(state.root).toMatchObject({ type: "stack", panels: ["a"] });
    expect(state.focus).toBe(state.root?.id);
    expect(state.panels["b"]).toBeUndefined();
  });

  it("activates the neighbouring tab when the active one closes", () => {
    const state = run([add("a"), add("b"), add("c"), { type: "activate", panel: "b" }, { type: "remove", panel: "b" }]);
    expect(mainStacks(state)[0]).toMatchObject({ panels: ["a", "c"], active: "c" });
  });

  it("moves a panel to another stack at an index", () => {
    const start = run([add("a"), add("b"), add("c", { at: "beside", panel: "a", side: "right" })]);
    const first = stackOfPanel(start, "a")?.id ?? "";
    const state = apply(start, { type: "move", panel: "c", target: { at: "stack", stack: first, index: 1 } });
    expect(mainStacks(state)).toHaveLength(1);
    expect(mainStacks(state)[0]?.panels).toEqual(["a", "c", "b"]);
  });

  it("reorders within a stack without changing focus", () => {
    const start = run([add("a"), add("b"), add("c", { at: "beside", panel: "a", side: "right" })]);
    const first = stackOfPanel(start, "a")?.id ?? "";
    const state = apply(start, {
      type: "move",
      panel: "b",
      target: { at: "stack", stack: first, index: 0 },
      activate: false,
    });
    expect(stackOfPanel(state, "a")?.panels).toEqual(["b", "a"]);
    expect(state.focus).toBe(start.focus);
  });

  it("does nothing when a lone panel is split from itself", () => {
    const start = run([add("a")]);
    const stack = stackOfPanel(start, "a")?.id ?? "";
    expect(apply(start, { type: "move", panel: "a", target: { at: "split", stack, side: "right" } })).toBe(start);
    expect(apply(start, { type: "move", panel: "a", target: { at: "root", side: "left" } })).toBe(start);
  });

  it("creates an edge region on demand and keeps it when empty", () => {
    const state = run([add("a"), add("nav", { at: "edge", side: "left" })]);
    expect(state.edges.left?.stack.panels).toEqual(["nav"]);
    expect(state.edges.left?.visible).toBe(true);
    const removed = apply(state, { type: "remove", panel: "nav" });
    expect(removed.edges.left?.stack.panels).toEqual([]);
    expect(removed.focus).toBe(stackOfPanel(removed, "a")?.id);
  });

  it("leaves what the user wants alone when a panel in a hidden edge takes focus", () => {
    const state = run([
      add("a"),
      { type: "add", panel: panel("nav"), target: { at: "edge", side: "left" }, activate: false },
      { type: "configureEdge", side: "left", options: { visible: false } },
      { type: "activate", panel: "nav" },
    ]);
    // A narrow screen shows the focused panel whatever the region says; the wish is not rewritten.
    expect(state.edges.left?.visible).toBe(false);
    expect(state.focus).toBe(state.edges.left?.stack.id);
  });

  it("shows a hidden edge when a panel is put into it", () => {
    const state = run([
      add("a"),
      add("b"),
      { type: "add", panel: panel("nav"), target: { at: "edge", side: "left" }, activate: false },
      { type: "configureEdge", side: "left", options: { visible: false } },
      { type: "move", panel: "b", target: { at: "edge", side: "left" } },
    ]);
    expect(state.edges.left?.visible).toBe(true);
    expect(state.edges.left?.stack.panels).toEqual(["nav", "b"]);
  });

  it("returns focus to the main area when the focused edge is hidden", () => {
    const state = run([
      add("a"),
      add("nav", { at: "edge", side: "left" }),
      { type: "configureEdge", side: "left", options: { visible: false } },
    ]);
    expect(state.focus).toBe(stackOfPanel(state, "a")?.id);
  });

  it("lets maximize follow focus and ends it when an edge takes focus", () => {
    const start = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" }), add("nav", { at: "edge", side: "left" })]);
    const a = stackOfPanel(start, "a")?.id ?? "";
    const b = stackOfPanel(start, "b")?.id ?? "";
    const maximized = apply(start, { type: "maximize", stack: a });
    expect(maximized.maximized).toBe(a);
    expect(apply(maximized, { type: "activate", panel: "b" }).maximized).toBe(b);
    expect(apply(maximized, { type: "activate", panel: "nav" }).maximized).toBeNull();
  });

  it("flattens the main area into the focused stack, keeping every panel", () => {
    const start = run([add("a"), add("b", { at: "beside", panel: "a", side: "right" }), add("c", { at: "beside", panel: "b", side: "bottom" })]);
    const state = apply(start, { type: "flatten" });
    expect(mainStacks(state)).toHaveLength(1);
    expect(mainStacks(state)[0]?.panels).toEqual(["a", "b", "c"]);
    expect(mainStacks(state)[0]?.active).toBe("c");
  });

  it("moves a whole stack", () => {
    const start = run([add("a"), add("b"), add("c", { at: "beside", panel: "a", side: "right" })]);
    const from = stackOfPanel(start, "a")?.id ?? "";
    const state = apply(start, { type: "moveStack", stack: from, target: { at: "edge", side: "right" } });
    expect(state.edges.right?.stack.panels).toEqual(["a", "b"]);
    expect(mainStacks(state).map(({ panels }) => panels)).toEqual([["c"]]);
  });

  it("is pure and deterministic", () => {
    const operations = [add("a"), add("b", { at: "root", side: "left" }), add("c", { at: "edge", side: "bottom" })];
    expect(run(operations)).toEqual(run(operations));
  });

  it("updates a descriptor without moving the panel", () => {
    const start = run([add("a")]);
    const state = apply(start, { type: "update", panel: "a", changes: { title: "Renamed", data: { page: 3 } } });
    expect(state.panels["a"]).toEqual({ id: "a", kind: "doc", title: "Renamed", data: { page: 3 } });
    expect(state.root).toBe(start.root);
  });
});

const ids = ["a", "b", "c", "d", "e", "f"] as const;
const coordinate = fc.double({ min: -4000, max: 4000, noNaN: true });
const side = fc.constantFrom("left", "right", "top", "bottom");
const anyPanel = fc.constantFrom(...ids);
const target = (stacks: fc.Arbitrary<string>): fc.Arbitrary<Target> =>
  fc.oneof(
    fc.record({ at: fc.constant("focus" as const) }),
    fc.record({ at: fc.constant("stack" as const), stack: stacks, index: fc.nat(4) }),
    fc.record({ at: fc.constant("split" as const), stack: stacks, side }),
    fc.record({ at: fc.constant("beside" as const), panel: anyPanel, side }),
    fc.record({ at: fc.constant("root" as const), side }),
    fc.record({ at: fc.constant("column" as const), side: fc.constantFrom("left" as const, "right" as const) }),
    fc.record({ at: fc.constant("column" as const), stack: stacks, side: fc.constantFrom("left" as const, "right" as const) }),
    fc.record({ at: fc.constant("edge" as const), side: fc.constantFrom(...edgeSides), index: fc.nat(3) }),
    fc.record(
      { at: fc.constant("canvas" as const), x: coordinate, y: coordinate, width: coordinate, height: coordinate },
      { requiredKeys: ["at", "x", "y"] },
    ),
  );
// Node ids are deterministic (`n1`, `n2`, …), so a small range reaches real stacks and misses.
const stackId = fc.nat(14).map((value) => `n${String(value)}`);
const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({ type: fc.constant("add" as const), panel: anyPanel.map(panel), target: target(stackId), activate: fc.boolean() }),
  fc.record({ type: fc.constant("add" as const), panel: anyPanel.map(panel) }),
  fc.record({ type: fc.constant("remove" as const), panel: anyPanel }),
  fc.record({ type: fc.constant("move" as const), panel: anyPanel, target: target(stackId), activate: fc.boolean() }),
  fc.record({ type: fc.constant("moveStack" as const), stack: stackId, target: target(stackId) }),
  fc.record({ type: fc.constant("activate" as const), panel: anyPanel }),
  fc.record({ type: fc.constant("focus" as const), stack: stackId }),
  fc.record({ type: fc.constant("maximize" as const), stack: fc.option(stackId, { nil: null }) }),
  fc.record({ type: fc.constant("resize" as const), split: stackId, sizes: fc.array(fc.double({ min: -1, max: 5, noNaN: true }), { maxLength: 4 }) }),
  fc.record({
    type: fc.constant("configureEdge" as const),
    side: fc.constantFrom(...edgeSides),
    options: fc.record({ visible: fc.boolean(), size: fc.double({ min: -50, max: 900, noNaN: true }) }, { requiredKeys: [] }),
  }),
  fc.record({ type: fc.constant("setView" as const), view: fc.constantFrom(...viewModes) }),
  fc.record({
    type: fc.constant("setView" as const),
    view: fc.constant("canvas" as const),
    frames: fc.dictionary(stackId, fc.record({ x: coordinate, y: coordinate, width: coordinate, height: coordinate })),
  }),
  fc.record({
    type: fc.constant("setFrame" as const),
    stack: stackId,
    frame: fc.record({ x: coordinate, y: coordinate, width: coordinate, height: coordinate }, { requiredKeys: [] }),
  }),
  fc.record({
    type: fc.constant("setCamera" as const),
    camera: fc.record({ x: coordinate, y: coordinate, zoom: fc.double({ min: -1, max: 5, noNaN: true }) }, { requiredKeys: [] }),
  }),
  fc.record({ type: fc.constant("setColumnWidth" as const), node: stackId, fraction: fc.double({ min: -1, max: 3, noNaN: true }) }),
  fc.record({ type: fc.constant("flatten" as const) }),
);

describe("any sequence of operations", () => {
  it("leaves a canonical workspace", () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 40 }), (operations) => {
        let state = emptyWorkspace();
        for (const next of operations) {
          state = apply(state, next);
          expect(violations(state)).toEqual([]);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("is stable under normalization and survives a snapshot round trip", () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 30 }), (operations) => {
        const state = run(operations);
        expect(normalize(state)).toBe(state);
        expect(fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))))).toEqual(state);
      }),
      { numRuns: 300 },
    );
  });

  it("never loses or duplicates a panel when moving", () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 30 }), anyPanel, target(stackId), (operations, moved, to) => {
        const before = run(operations);
        const after = apply(before, { type: "move", panel: moved, target: to });
        expect(Object.keys(after.panels).sort()).toEqual(Object.keys(before.panels).sort());
      }),
      { numRuns: 300 },
    );
  });

  it("lays every panel out inside the workspace, with exactly the active ones visible", () => {
    fc.assert(
      fc.property(
        fc.array(operation, { maxLength: 30 }),
        fc.integer({ min: 200, max: 2400 }),
        fc.integer({ min: 200, max: 1400 }),
        (operations, width, height) => {
          const state = run(operations);
          for (const options of [{}, { compactBelow: 680 }, { overview: true }]) {
            const layout = computeLayout(state, { width, height }, options);
            expect(layout.panels.map(({ id }) => id).sort()).toEqual(Object.keys(state.panels).sort());
            for (const stack of layout.stacks) {
              expect(stack.rect.width).toBeGreaterThanOrEqual(0);
              expect(stack.rect.height).toBeGreaterThanOrEqual(0);
              if (layout.mode === "canvas" && !stack.pinned) {
                // A pane on the canvas is in plane pixels and may be anywhere.
                continue;
              }
              expect(stack.rect.x).toBeGreaterThanOrEqual(0);
              expect(stack.rect.x + stack.rect.width).toBeLessThanOrEqual(layout.contentWidth + 0.5);
              expect(stack.rect.y + stack.rect.height).toBeLessThanOrEqual(height + 0.5);
            }
            if (layout.mode === "overview") {
              continue;
            }
            const visible = layout.panels.filter((item) => item.visible).map(({ id }) => id);
            const shown = new Set(layout.stacks.map(({ id }) => id));
            const expected = allStacks(state).flatMap((stack) =>
              shown.has(stack.id) && stack.active ? [stack.active] : [],
            );
            expect(visible.sort()).toEqual(expected.sort());
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
