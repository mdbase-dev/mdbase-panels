import { normalize } from "./normalize.js";
import { fromSnapshot, toSnapshot } from "./serialize.js";
import { allStacks, emptyWorkspace, mainStacks, mapStacks } from "./tree.js";
import {
  edgeSides,
  type Camera,
  type CanvasFrame,
  type EdgeRegion,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type PanelId,
  type Rect,
  type StackNode,
  type WorkspaceState,
} from "./types.js";

/**
 * A workspace is two things. The arrangement is what is open and where it sits: worth keeping,
 * and the same for every window that shows the workspace. The window state is how one window
 * is looking at it: what has focus, which tab is in front, which side regions are open, where
 * the canvas is panned to. It changes with nearly every click and belongs to that window alone.
 *
 * `WorkspaceState` holds both, because operations need both. These functions take a state
 * apart and put one back together, so each half can be kept where it belongs.
 */
export interface Arrangement {
  readonly format: "mdbase-panels/arrangement";
  readonly version: 1;
  readonly panels: WorkspaceState["panels"];
  readonly root: LayoutNode | null;
  readonly edges: { readonly [side in EdgeSide]?: Omit<EdgeRegion, "visible"> };
  readonly view: WorkspaceState["view"];
  readonly columns: WorkspaceState["columns"];
  /** Where each stack sits on the canvas. */
  readonly frames: { readonly [stack: NodeId]: Rect };
  readonly seq: number;
}

export interface WindowState {
  readonly format: "mdbase-panels/window";
  readonly version: 1;
  readonly focus: NodeId | null;
  /** The tab in front in each stack. */
  readonly active: { readonly [stack: NodeId]: PanelId };
  /** The panel leading each stack, where that is not its active tab. */
  readonly lead: { readonly [stack: NodeId]: PanelId };
  readonly leader: PanelId | null;
  readonly maximized: NodeId | null;
  /** Which side regions this window has open. */
  readonly shown: { readonly [side in EdgeSide]?: boolean };
  readonly camera: Camera;
  /** Canvas stacks from back to front. */
  readonly order: readonly NodeId[];
}

const bare = (stack: StackNode): StackNode => ({
  type: "stack",
  id: stack.id,
  panels: stack.panels,
  active: null,
});

/** The arrangement half of a state: nothing in it changes when the user only looks around. */
export function arrangementOf(state: WorkspaceState): Arrangement {
  const edges: { [side in EdgeSide]?: Omit<EdgeRegion, "visible"> } = {};
  for (const side of edgeSides) {
    const edge = state.edges[side];
    if (edge) {
      const { visible: _visible, stack, ...rest } = edge;
      edges[side] = { ...rest, stack: bare(stack) };
    }
  }
  const frames: { [stack: NodeId]: Rect } = {};
  for (const [id, { x, y, width, height }] of Object.entries(state.canvas.frames)) {
    frames[id] = { x, y, width, height };
  }
  return {
    format: "mdbase-panels/arrangement",
    version: 1,
    panels: state.panels,
    root: state.root ? mapStacks(state.root, bare) : null,
    edges,
    view: state.view,
    columns: state.columns,
    frames,
    seq: state.seq,
  };
}

/** The window half of a state. */
export function windowOf(state: WorkspaceState): WindowState {
  const active: { [stack: NodeId]: PanelId } = {};
  const lead: { [stack: NodeId]: PanelId } = {};
  for (const stack of allStacks(state)) {
    if (stack.active !== null) {
      active[stack.id] = stack.active;
    }
    if (stack.lead !== undefined && stack.lead !== stack.active) {
      lead[stack.id] = stack.lead;
    }
  }
  const shown: { [side in EdgeSide]?: boolean } = {};
  for (const side of edgeSides) {
    const edge = state.edges[side];
    if (edge) {
      shown[side] = edge.visible;
    }
  }
  const order = Object.entries(state.canvas.frames)
    .sort(([, a], [, b]) => a.z - b.z)
    .map(([id]) => id);
  return {
    format: "mdbase-panels/window",
    version: 1,
    focus: state.focus,
    active,
    lead,
    leader: state.leader,
    maximized: state.maximized,
    shown,
    camera: state.canvas.camera,
    order,
  };
}

/**
 * A state from an arrangement and the window looking at it. The window may be stale or absent:
 * whatever it says about things that are no longer there is dropped, and a side region it has
 * never seen is shown.
 */
export function compose(arrangement: Arrangement, window?: WindowState | null): WorkspaceState {
  const dress = (stack: StackNode): StackNode => {
    const lead = window?.lead[stack.id];
    return {
      ...stack,
      active: window?.active[stack.id] ?? null,
      ...(lead === undefined ? {} : { lead }),
    };
  };
  const edges: { [side in EdgeSide]?: EdgeRegion } = {};
  for (const side of edgeSides) {
    const edge = arrangement.edges[side];
    if (edge) {
      edges[side] = { ...edge, stack: dress(edge.stack), visible: window?.shown[side] ?? true };
    }
  }
  const root = arrangement.root ? mapStacks(arrangement.root, dress) : null;
  const order = window?.order ?? [];
  const behind = root ? mainStackIds(root).filter((id) => !order.includes(id)) : [];
  const layers = [...behind, ...order];
  const frames: { [stack: NodeId]: CanvasFrame } = {};
  for (const [id, rect] of Object.entries(arrangement.frames)) {
    frames[id] = { ...rect, z: layers.indexOf(id) + 1 };
  }
  return normalize({
    ...emptyWorkspace(),
    panels: arrangement.panels,
    root,
    edges,
    focus: window?.focus ?? null,
    maximized: window?.maximized ?? null,
    view: arrangement.view,
    columns: arrangement.columns,
    canvas: { frames, camera: window?.camera ?? { x: 0, y: 0, zoom: 1 } },
    leader: window?.leader ?? null,
    seq: arrangement.seq,
  });
}

function mainStackIds(root: LayoutNode): NodeId[] {
  return mainStacks({ ...emptyWorkspace(), root }).map(({ id }) => id);
}

/** Whether two states are the same arrangement, however differently they are being looked at. */
export function sameArrangement(a: WorkspaceState, b: WorkspaceState): boolean {
  return a === b || JSON.stringify(arrangementOf(a)) === JSON.stringify(arrangementOf(b));
}

/** An arrangement from untrusted JSON. Throws on anything that is not one. */
export function parseArrangement(value: unknown): Arrangement {
  if (!isRecord(value) || value["format"] !== "mdbase-panels/arrangement" || value["version"] !== 1) {
    throw new Error("Not a workspace arrangement");
  }
  // An arrangement is a workspace with the window left out, so it is checked as one.
  const frames = isRecord(value["frames"]) ? value["frames"] : {};
  const state = fromSnapshot({
    ...toSnapshot(emptyWorkspace()),
    workspace: {
      version: 1,
      panels: value["panels"],
      root: value["root"],
      edges: value["edges"],
      view: value["view"],
      columns: value["columns"],
      canvas: { frames },
      seq: value["seq"],
    },
  });
  return arrangementOf(state);
}

/** A window state from untrusted JSON. Anything unreadable in it is left out. */
export function parseWindowState(value: unknown): WindowState {
  if (!isRecord(value) || value["format"] !== "mdbase-panels/window" || value["version"] !== 1) {
    throw new Error("Not a workspace window state");
  }
  const text = (input: unknown): string | null => (typeof input === "string" ? input : null);
  const ids = (input: unknown): { [stack: NodeId]: PanelId } => {
    const result: { [stack: NodeId]: PanelId } = {};
    for (const [key, id] of Object.entries(isRecord(input) ? input : {})) {
      if (typeof id === "string") {
        result[key] = id;
      }
    }
    return result;
  };
  const shown: { [side in EdgeSide]?: boolean } = {};
  for (const side of edgeSides) {
    const given = isRecord(value["shown"]) ? value["shown"][side] : undefined;
    if (typeof given === "boolean") {
      shown[side] = given;
    }
  }
  const camera = isRecord(value["camera"]) ? value["camera"] : {};
  const number = (input: unknown, fallback: number): number =>
    typeof input === "number" && Number.isFinite(input) ? input : fallback;
  return {
    format: "mdbase-panels/window",
    version: 1,
    focus: text(value["focus"]),
    active: ids(value["active"]),
    lead: ids(value["lead"]),
    leader: text(value["leader"]),
    maximized: text(value["maximized"]),
    shown,
    camera: { x: number(camera["x"], 0), y: number(camera["y"], 0), zoom: number(camera["zoom"], 1) },
    order: Array.isArray(value["order"])
      ? value["order"].filter((id): id is string => typeof id === "string")
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
