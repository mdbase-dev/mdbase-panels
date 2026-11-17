import { describe, expect, it } from "vitest";

import {
  cameraToFit,
  cameraToReveal,
  canvasDefaults,
  dragFrame,
  frameBeside,
  seedFrames,
  zoomCameraAt,
} from "./canvas.js";
import { dropTargetAt } from "./drop.js";
import { computeLayout } from "./layout.js";
import { apply } from "./operations.js";
import { memoryStorage, WorkspaceStore } from "./store.js";
import { emptyWorkspace, mainStacks, stackOfPanel } from "./tree.js";
import { type Operation, type PanelDescriptor, type Rect, type Target, type WorkspaceState } from "./types.js";

const panel = (id: string, leads = true): PanelDescriptor =>
  leads ? { id, kind: "doc" } : { id, kind: "tool", leads: false };
const run = (operations: readonly Operation[], from = emptyWorkspace()): WorkspaceState =>
  operations.reduce(apply, from);
const add = (id: string, target?: Target): Operation => ({
  type: "add",
  panel: panel(id),
  ...(target ? { target } : {}),
});
const frameOf = (state: WorkspaceState, id: string): Rect & { z: number } => {
  const frame = state.canvas.frames[stackOfPanel(state, id)?.id ?? ""];
  if (!frame) {
    throw new Error(`no frame for ${id}`);
  }
  return frame;
};
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("the leader", () => {
  it("is the panel that last had focus, not counting panels that do not lead", () => {
    const start = run([add("a"), add("b", { at: "root", side: "right" })]);
    expect(start.leader).toBe("b");
    const tool = apply(start, { type: "add", panel: panel("notes", false), target: { at: "edge", side: "right" } });
    expect(tool.focus).toBe(tool.edges.right?.stack.id);
    expect(tool.leader).toBe("b");
    expect(apply(tool, { type: "activate", panel: "a" }).leader).toBe("a");
  });

  it("stays put when a follower in the same stack becomes the active tab", () => {
    const state = run([add("a"), { type: "add", panel: panel("notes", false) }]);
    expect(stackOfPanel(state, "a")?.active).toBe("notes");
    expect(state.leader).toBe("a");
  });

  it("passes to the tab that replaces a closed leader, and to nobody when none can lead", () => {
    const start = run([
      add("a"),
      add("b"),
      { type: "add", panel: panel("notes", false), target: { at: "edge", side: "right" } },
    ]);
    expect(start.leader).toBe("b");
    const closed = apply(start, { type: "remove", panel: "b" });
    expect(closed.leader).toBe("a");
    expect(apply(closed, { type: "remove", panel: "a" }).leader).toBeNull();
  });

  it("follows a change to whether a panel leads", () => {
    const start = run([add("a"), add("b")]);
    const state = apply(start, { type: "update", panel: "b", changes: { leads: false } });
    expect(state.leader).toBe("a");
  });
});

describe("the canvas", () => {
  const seeded = (): WorkspaceState => {
    const tiled = run([add("a"), add("b", { at: "root", side: "right" })]);
    const layout = computeLayout(tiled, { width: 1200, height: 800 });
    return apply(tiled, { type: "setView", view: "canvas", frames: seedFrames(layout.stacks, layout.main) });
  };

  it("starts from where the panes already are", () => {
    const state = seeded();
    const layout = computeLayout(state, { width: 1200, height: 800 });
    expect(layout.mode).toBe("canvas");
    expect(layout.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(frameOf(state, "a")).toMatchObject({ x: 6, y: 6, height: 788 });
    expect(frameOf(state, "b").x).toBeGreaterThan(600);
    expect(layout.stacks.every(({ pinned }) => !pinned)).toBe(true);
    expect(layout.splitters).toEqual([]);
  });

  it("keeps saved frames when the view is left and entered again", () => {
    const moved = apply(seeded(), { type: "setFrame", stack: stackOfPanel(seeded(), "a")?.id ?? "", frame: { x: -500 } });
    const back = run([{ type: "setView", view: "tiling" }, { type: "setView", view: "canvas", frames: {} }], moved);
    expect(frameOf(back, "a").x).toBe(-500);
  });

  it("gives every new pane a free place of its own", () => {
    let state = seeded();
    state = apply(state, add("c", { at: "beside", panel: "a", side: "right" }));
    state = apply(state, add("d", { at: "root", side: "bottom" }));
    state = apply(state, add("e", { at: "column", side: "right" }));
    const frames = mainStacks(state).map(({ id }) => state.canvas.frames[id]);
    expect(frames.every(Boolean)).toBe(true);
    for (const [index, a] of frames.entries()) {
      for (const b of frames.slice(index + 1)) {
        expect(a && b && overlap(a, b)).toBe(false);
      }
    }
    // Splitting to the right of "a" lands past "b", which was already there.
    expect(frameOf(state, "c").x).toBeGreaterThanOrEqual(frameOf(state, "b").x + frameOf(state, "b").width);
    expect(frameOf(state, "d").y).toBeGreaterThan(frameOf(state, "a").y + frameOf(state, "a").height);
  });

  it("places panes opened while another view was showing", () => {
    const state = run([
      { type: "setView", view: "tiling" },
      add("c", { at: "root", side: "right" }),
      { type: "setView", view: "canvas" },
    ], seeded());
    expect(overlap(frameOf(state, "c"), frameOf(state, "a"))).toBe(false);
    expect(overlap(frameOf(state, "c"), frameOf(state, "b"))).toBe(false);
  });

  it("brings the focused pane to the front", () => {
    const start = seeded();
    expect(frameOf(start, "b").z).toBeGreaterThan(frameOf(start, "a").z);
    const state = apply(start, { type: "activate", panel: "a" });
    expect(frameOf(state, "a").z).toBeGreaterThan(frameOf(state, "b").z);
    const layout = computeLayout(state, { width: 1200, height: 800 });
    const layers = new Map(layout.stacks.map(({ id, layer }) => [id, layer]));
    expect(layers.get(stackOfPanel(state, "a")?.id ?? "")).toBe(2);
  });

  it("moves a lone panel's pane, and makes a pane for one of several tabs", () => {
    const start = apply(seeded(), add("c", { at: "stack", stack: stackOfPanel(seeded(), "b")?.id ?? "" }));
    const paneOfA = stackOfPanel(start, "a")?.id;
    const moved = apply(start, { type: "move", panel: "a", target: { at: "canvas", x: 2000, y: 40 } });
    expect(stackOfPanel(moved, "a")?.id).toBe(paneOfA);
    expect(frameOf(moved, "a")).toMatchObject({ x: 2000, y: 40, width: frameOf(start, "a").width });
    const split = apply(start, { type: "move", panel: "c", target: { at: "canvas", x: -900, y: 0, width: 400, height: 300 } });
    expect(stackOfPanel(split, "c")?.id).not.toBe(stackOfPanel(split, "b")?.id);
    expect(frameOf(split, "c")).toMatchObject({ x: -900, y: 0, width: 400, height: 300 });
    expect(mainStacks(split)).toHaveLength(3);
  });

  it("never lets a frame get smaller than the smallest pane", () => {
    const start = seeded();
    const id = stackOfPanel(start, "a")?.id ?? "";
    const state = apply(start, { type: "setFrame", stack: id, frame: { width: 10, height: 10 } });
    expect(state.canvas.frames[id]).toMatchObject(canvasDefaults.minFrame);
  });

  it("drops frames with their panes and keeps the zoom in range", () => {
    const start = seeded();
    const closed = apply(start, { type: "remove", panel: "b" });
    expect(Object.keys(closed.canvas.frames)).toEqual([stackOfPanel(closed, "a")?.id]);
    expect(apply(start, { type: "setCamera", camera: { zoom: 40 } }).canvas.camera.zoom).toBe(canvasDefaults.zoom.max);
    expect(apply(start, { type: "setCamera", camera: { zoom: 0 } }).canvas.camera.zoom).toBe(canvasDefaults.zoom.min);
  });

  it("shows one panel on a narrow screen, whatever the canvas says", () => {
    const layout = computeLayout(seeded(), { width: 400, height: 700 }, { compactBelow: 680 });
    expect(layout.mode).toBe("stack");
    expect(layout.camera).toBeNull();
    expect(layout.stacks).toHaveLength(1);
  });

  it("finds drop targets through the camera", () => {
    const start = apply(seeded(), { type: "setCamera", camera: { x: 100, y: 50, zoom: 0.5 } });
    const layout = computeLayout(start, { width: 1200, height: 800 });
    const b = frameOf(start, "b");
    // The middle of pane "b", on screen.
    const over = { x: (b.x + b.width / 2 - 100) * 0.5, y: (b.y + b.height / 2 - 50) * 0.5 };
    expect(dropTargetAt(start, layout, "a", over)?.target).toEqual({ at: "stack", stack: stackOfPanel(start, "b")?.id });
    const open = dropTargetAt(start, layout, "a", { x: 1100, y: 700 });
    expect(open?.target.at).toBe("canvas");
    expect(open?.pinned).toBe(false);
    // The plane point under the pointer is inside the pane that would be made.
    const plane = { x: 1100 / 0.5 + 100, y: 700 / 0.5 + 50 };
    expect(open && overlap(open.indicator, { ...plane, width: 1, height: 1 })).toBe(true);
  });

  it("does not undo where the camera is looking", () => {
    const store = new WorkspaceStore({ initial: seeded(), storage: memoryStorage() });
    const id = stackOfPanel(store.state, "a")?.id ?? "";
    store.dispatch({ type: "setFrame", stack: id, frame: { x: 800 } });
    store.dispatch({ type: "setCamera", camera: { x: 300, zoom: 0.5 } });
    expect(store.canUndo).toBe(true);
    store.undo();
    expect(store.state.canvas.frames[id]?.x).toBe(6);
    expect(store.state.canvas.camera).toEqual({ x: 300, y: 0, zoom: 0.5 });
    expect(store.canUndo).toBe(false);
  });
});

describe("canvas geometry", () => {
  const frame = { x: 0, y: 0, width: 400, height: 300 };

  it("puts a new frame past anything in the way", () => {
    const taken = [frame, { x: 432, y: 100, width: 400, height: 300 }];
    expect(frameBeside(taken, frame, "right", { width: 400, height: 300 })).toMatchObject({ x: 864, y: 0 });
    expect(frameBeside(taken, frame, "bottom", { width: 400, height: 300 })).toMatchObject({ x: 0, y: 332 });
    expect(frameBeside(taken, frame, "left", { width: 200, height: 300 })).toMatchObject({ x: -232, y: 0 });
  });

  it("fits everything without zooming in", () => {
    expect(cameraToFit({ x: 0, y: 0, width: 4000, height: 1000 }, { width: 1064, height: 800 }).zoom).toBe(0.25);
    const small = cameraToFit({ x: 100, y: 100, width: 200, height: 100 }, { width: 1000, height: 800 });
    expect(small).toEqual({ x: -300, y: -250, zoom: 1 });
  });

  it("pans just far enough to show a frame", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const view = { width: 1000, height: 800 };
    expect(cameraToReveal(camera, frame, view, 0)).toBe(camera);
    expect(cameraToReveal(camera, { ...frame, x: 900 }, view, 20)).toEqual({ x: 320, y: 0, zoom: 1 });
    // Fits, but not with the margin: centred.
    expect(cameraToReveal(camera, { ...frame, x: -10, width: 990 }, view, 20).x).toBe(-15);
    // Too tall to fit: show its top.
    expect(cameraToReveal(camera, { ...frame, y: 200, height: 2000 }, view, 20).y).toBe(180);
    // Half the zoom shows twice the plane.
    expect(cameraToReveal({ ...camera, zoom: 0.5 }, { ...frame, x: 900, y: 40 }, view, 20)).toEqual({ x: 0, y: 0, zoom: 0.5 });
  });

  it("zooms about a point", () => {
    const camera = zoomCameraAt({ x: 10, y: 20, zoom: 1 }, { x: 200, y: 100 }, 2);
    // The plane point under the pointer is the same before and after.
    expect(camera.x + 200 / camera.zoom).toBe(10 + 200);
    expect(camera.y + 100 / camera.zoom).toBe(20 + 100);
  });

  it("moves and resizes on the grid, down to the smallest pane", () => {
    expect(dragFrame(frame, "move", 13, -5)).toEqual({ x: 16, y: -8, width: 400, height: 300 });
    expect(dragFrame(frame, "se", 21, 43)).toEqual({ x: 0, y: 0, width: 424, height: 344 });
    expect(dragFrame(frame, "nw", 500, 500)).toEqual({ x: 160, y: 140, width: 240, height: 160 });
    expect(dragFrame(frame, "w", -100, 0)).toEqual({ x: -96, y: 0, width: 496, height: 300 });
  });
});

describe("edge regions", () => {
  const start = run([
    add("a"),
    { type: "add", panel: panel("nav"), target: { at: "edge", side: "left" }, activate: false },
    { type: "add", panel: panel("notes"), target: { at: "edge", side: "right" }, activate: false },
    { type: "configureEdge", side: "left", options: { size: 260, priority: 1 } },
    { type: "configureEdge", side: "right", options: { size: 340, priority: 0 } },
  ]);
  const shown = (width: number, options = {}): (string | null)[] =>
    computeLayout(start, { width, height: 800 }, { minMainWidth: 360, ...options })
      .stacks.map(({ edge }) => edge)
      .filter(Boolean);

  it("hides a region for now without changing what is saved", () => {
    expect(shown(1400)).toEqual(["left", "right"]);
    expect(shown(1400, { hiddenEdges: ["left"] })).toEqual(["right"]);
    expect(start.edges.left?.visible).toBe(true);
  });

  it("lets the preferred region stay when there is room for only one", () => {
    expect(shown(800)).toEqual(["left"]);
    expect(shown(800, { preferEdge: "right" })).toEqual(["right"]);
    expect(shown(800, { preferEdge: "left" })).toEqual(["left"]);
    const layout = computeLayout(start, { width: 800, height: 800 }, { minMainWidth: 360, preferEdge: "right" });
    expect(layout.yielded).toEqual(["left"]);
  });

  it("keeps a hidden region's panels at the region's width", () => {
    const layout = computeLayout(start, { width: 1400, height: 800 }, { hiddenEdges: ["right"] });
    const notes = layout.panels.find(({ id }) => id === "notes");
    expect(notes).toMatchObject({ visible: false, rect: { width: 340 } });
  });
});
