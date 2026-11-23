import { canvasDefaults, clampCamera, frameBeside } from "./canvas.js";
import { allStacks, canLead, findStack, mainStacks, normalizeSizes } from "./tree.js";
import {
  edgeSides,
  type CanvasFrame,
  type CanvasState,
  type EdgeRegion,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type PanelDescriptor,
  type PanelId,
  type StackNode,
  type WorkspaceState,
} from "./types.js";

export const columnFractionRange = { min: 0.15, max: 1 } as const;

/**
 * Bring any state into canonical form. After this:
 * - every panel descriptor is placed in exactly one stack, and every placed id has a descriptor;
 * - the main area has no empty stacks, no single-child splits and no nested same-direction splits;
 * - split sizes are positive and sum to 1;
 * - `active`, `focus` and `maximized` refer to things that exist;
 * - `leader` is a panel that can lead, and is the focused panel whenever that one can lead;
 * - every stack's `lead` is a panel in it that can lead: the active one whenever that one can;
 * - a panel follows the leader or a pane that exists;
 * - canvas frames belong to main-area stacks, and in the `canvas` view every main-area stack
 *   has one, with the focused stack in front.
 * Normalizing a canonical state returns the same object.
 */
export function normalize(state: WorkspaceState): WorkspaceState {
  const seenPanels = new Set<PanelId>();
  const seenNodes = new Set<string>();
  const cleanStack = (stack: StackNode): StackNode => {
    const panels = stack.panels.filter((id) => {
      if (seenPanels.has(id) || !Object.hasOwn(state.panels, id)) {
        return false;
      }
      seenPanels.add(id);
      return true;
    });
    const active =
      stack.active !== null && panels.includes(stack.active) ? stack.active : (panels[0] ?? null);
    const leading = (id: PanelId | null | undefined): id is PanelId =>
      typeof id === "string" && panels.includes(id) && canLead(state.panels[id]);
    const lead = leading(active)
      ? active
      : leading(stack.lead)
        ? stack.lead
        : panels.find((id) => leading(id));
    if (panels.length === stack.panels.length && active === stack.active && lead === stack.lead) {
      return stack;
    }
    const { lead: _was, ...rest } = stack;
    return { ...rest, panels, active, ...(lead === undefined ? {} : { lead }) };
  };
  const cleanNode = (node: LayoutNode): LayoutNode | null => {
    if (seenNodes.has(node.id)) {
      return null;
    }
    seenNodes.add(node.id);
    if (node.type === "stack") {
      const stack = cleanStack(node);
      return stack.panels.length ? stack : null;
    }
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    const given = normalizeSizes(node.sizes, node.children.length);
    node.children.forEach((child, index) => {
      const next = cleanNode(child);
      const size = given[index] ?? 0;
      if (!next) {
        return;
      }
      if (next.type === "split" && next.direction === node.direction) {
        // A row inside a row is the same row.
        next.children.forEach((grandchild, at) => {
          children.push(grandchild);
          sizes.push(size * (next.sizes[at] ?? 0));
        });
      } else {
        children.push(next);
        sizes.push(size);
      }
    });
    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0] ?? null;
    }
    const normalized = normalizeSizes(sizes, children.length);
    // Sizes that are already right are kept as they are: scaling them again would drift.
    const sized =
      children.length === node.children.length &&
      normalized.every((value, index) => Math.abs(value - (node.sizes[index] ?? -1)) < 1e-12);
    const same = sized && children.every((child, index) => child === node.children[index]);
    return same ? node : { ...node, children, sizes: sized ? node.sizes : normalized };
  };

  const root = state.root ? cleanNode(state.root) : null;
  let edges = state.edges;
  for (const side of edgeSides) {
    const edge = edges[side];
    if (!edge) {
      continue;
    }
    const next = cleanEdge(edge, seenNodes, cleanStack);
    if (next !== edge) {
      edges = { ...edges, [side]: next };
    }
  }

  let panels = state.panels;
  const ids = Object.keys(panels);
  if (ids.some((id) => !seenPanels.has(id))) {
    const kept: Record<PanelId, PanelDescriptor> = {};
    for (const id of ids) {
      const panel = panels[id];
      if (panel && seenPanels.has(id)) {
        kept[id] = panel;
      }
    }
    panels = kept;
  }

  const everything = allStacks({ ...state, root, edges });
  panels = cleanFollows(panels, new Set(everything.map(({ id }) => id)));
  const draft: WorkspaceState = { ...state, root, edges, panels };
  const main = mainStacks(draft);
  const focusValid = everything.some(({ id, panels: held }) => id === state.focus && held.length);
  const focus = focusValid
    ? state.focus
    : (main[0]?.id ?? visibleEdgeStack(draft)?.id ?? everything.find((s) => s.panels.length)?.id ?? null);
  const maximized = main.some(({ id }) => id === state.maximized) ? state.maximized : null;
  const columns = cleanColumns(state, root);
  const placed: WorkspaceState = { ...draft, focus };
  const canvas = cleanCanvas(placed);
  const leader = cleanLeader(placed);

  if (
    root === state.root &&
    edges === state.edges &&
    panels === state.panels &&
    focus === state.focus &&
    maximized === state.maximized &&
    columns === state.columns &&
    canvas === state.canvas &&
    leader === state.leader
  ) {
    return state;
  }
  return { ...state, root, edges, panels, focus, maximized, columns, canvas, leader };
}

function cleanEdge(
  edge: EdgeRegion,
  seenNodes: Set<string>,
  cleanStack: (stack: StackNode) => StackNode,
): EdgeRegion {
  // An edge's stack id that collides with a main-area node keeps its panels under a derived id.
  const id = seenNodes.has(edge.stack.id) ? `${edge.stack.id}:edge` : edge.stack.id;
  seenNodes.add(id);
  const stack = cleanStack(id === edge.stack.id ? edge.stack : { ...edge.stack, id });
  const size = Number.isFinite(edge.size) && edge.size > 0 ? edge.size : 280;
  return stack === edge.stack && size === edge.size ? edge : { ...edge, stack, size };
}

function visibleEdgeStack(state: WorkspaceState): StackNode | undefined {
  for (const side of edgeSides) {
    const edge = state.edges[side as EdgeSide];
    if (edge?.visible && edge.stack.panels.length) {
      return edge.stack;
    }
  }
  return undefined;
}

function cleanColumns(state: WorkspaceState, root: LayoutNode | null): WorkspaceState["columns"] {
  const entries = Object.entries(state.columns);
  if (!entries.length) {
    return state.columns;
  }
  const live = new Set(root ? nodeIds(root) : []);
  let changed = false;
  const next: Record<string, number> = {};
  for (const [id, value] of entries) {
    if (!live.has(id) || !Number.isFinite(value)) {
      changed = true;
      continue;
    }
    const fraction = Math.min(columnFractionRange.max, Math.max(columnFractionRange.min, value));
    changed ||= fraction !== value;
    next[id] = fraction;
  }
  return changed ? next : state.columns;
}

function nodeIds(node: LayoutNode): string[] {
  return node.type === "stack" ? [node.id] : [node.id, ...node.children.flatMap(nodeIds)];
}

/** A follower of a pane that has gone follows the leader. */
function cleanFollows(
  panels: WorkspaceState["panels"],
  nodes: ReadonlySet<string>,
): WorkspaceState["panels"] {
  let next = panels;
  for (const panel of Object.values(panels)) {
    const follows = panel.follows;
    if (follows !== undefined && follows !== "leader" && !nodes.has(follows.pane)) {
      next = { ...next, [panel.id]: { ...panel, follows: "leader" } };
    }
  }
  return next;
}

function leads(state: WorkspaceState, id: PanelId | null | undefined): id is PanelId {
  return typeof id === "string" && Object.hasOwn(state.panels, id) && canLead(state.panels[id]);
}

/** The focused panel if it can lead, else whoever led before, else the first panel that can. */
function cleanLeader(state: WorkspaceState): PanelId | null {
  const focused = findStack(state, state.focus)?.active;
  if (leads(state, focused)) {
    return focused;
  }
  if (leads(state, state.leader)) {
    return state.leader;
  }
  const stacks = allStacks(state);
  return (
    stacks.map(({ active }) => active).find((id) => leads(state, id)) ??
    stacks.flatMap(({ panels }) => panels).find((id) => leads(state, id)) ??
    null
  );
}

function cleanCanvas(state: WorkspaceState): CanvasState {
  const current = state.canvas;
  const main = mainStacks(state);
  const live = new Set(main.map(({ id }) => id));
  let changed = false;
  const frames: { [stack: NodeId]: CanvasFrame } = {};
  for (const [id, frame] of Object.entries(current.frames)) {
    const usable =
      live.has(id) &&
      [frame.x, frame.y, frame.width, frame.height, frame.z].every((value) => Number.isFinite(value)) &&
      frame.width > 0 &&
      frame.height > 0;
    if (usable) {
      frames[id] = frame;
    } else {
      changed = true;
    }
  }
  if (state.view === "canvas") {
    let top = Object.values(frames).reduce<CanvasFrame | undefined>(
      (best, frame) => (!best || frame.z > best.z ? frame : best),
      undefined,
    );
    for (const { id } of main) {
      if (frames[id]) {
        continue;
      }
      // A stack with no place yet goes beside whatever was used last, the same size.
      const size = top ? { width: top.width, height: top.height } : canvasDefaults.frame;
      const rect = top
        ? frameBeside(Object.values(frames), top, "right", size)
        : { x: canvasDefaults.gap, y: canvasDefaults.gap, ...size };
      top = { ...rect, z: (top?.z ?? 0) + 1 };
      frames[id] = top;
      changed = true;
    }
    const focused = state.focus === null ? undefined : frames[state.focus];
    if (focused && state.focus !== null) {
      const others = Object.entries(frames)
        .filter(([id]) => id !== state.focus)
        .map(([, frame]) => frame.z);
      const highest = Math.max(0, ...others);
      if (focused.z <= highest) {
        frames[state.focus] = { ...focused, z: highest + 1 };
        changed = true;
      }
    }
  }
  const camera = clampCamera(current.camera);
  return changed || camera !== current.camera ? { frames: changed ? frames : current.frames, camera } : current;
}
