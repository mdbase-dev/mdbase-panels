import { boundsOf, canvasDefaults, clampCamera, frameBeside } from "./canvas.js";
import { columnFractionRange, normalize } from "./normalize.js";
import {
  edgeOfStack,
  findNode,
  findStack,
  isMainStack,
  mainStacks,
  normalizeSizes,
  parentOf,
  replaceNode,
  stackOfPanel,
  stacksOf,
  updateStack,
} from "./tree.js";
import {
  type CanvasFrame,
  type Direction,
  type EdgeRegion,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type Operation,
  type PanelId,
  type Rect,
  type Size,
  type SplitSide,
  type StackNode,
  type Target,
  type WorkspaceState,
} from "./types.js";

export const defaultEdgeSize = 280;

/** Apply one operation. Pure: the same state and operation always give the same result. */
export function apply(state: WorkspaceState, operation: Operation): WorkspaceState {
  return normalize(reduce(state, operation));
}

function reduce(state: WorkspaceState, operation: Operation): WorkspaceState {
  switch (operation.type) {
    case "add": {
      const { panel } = operation;
      const existing = Object.hasOwn(state.panels, panel.id);
      const next = { ...state, panels: { ...state.panels, [panel.id]: panel } };
      const activate = operation.activate ?? true;
      if (existing && !operation.target) {
        return activate ? activatePanel(next, panel.id) : next;
      }
      return place(next, panel.id, operation.target ?? { at: "focus" }, activate);
    }
    case "remove": {
      if (!Object.hasOwn(state.panels, operation.panel)) {
        return state;
      }
      const panels = { ...state.panels };
      delete panels[operation.panel];
      const detached = detach(state, operation.panel);
      if (state.leader !== operation.panel) {
        return { ...detached, panels };
      }
      // Closing the leader hands over to the tab that takes its place, if that one can lead.
      const stack = stackOfPanel(state, operation.panel);
      const heir = stack ? (findStack(detached, stack.id)?.active ?? null) : null;
      return { ...detached, panels, leader: heir };
    }
    case "move":
      return Object.hasOwn(state.panels, operation.panel)
        ? place(state, operation.panel, operation.target, operation.activate ?? true)
        : state;
    case "moveStack": {
      const stack = findStack(state, operation.stack);
      if (!stack?.panels.length) {
        return state;
      }
      const [first, ...rest] = stack.panels;
      if (first === undefined) {
        return state;
      }
      let next = place(state, first, operation.target, false);
      const destination = stackOfPanel(next, first);
      if (!destination) {
        return state;
      }
      for (const panel of rest) {
        next = place(next, panel, { at: "stack", stack: destination.id }, false);
      }
      const active = stack.active ?? first;
      return activatePanel(next, active);
    }
    case "activate":
      return activatePanel(state, operation.panel);
    case "focus":
      return focusStack(state, operation.stack);
    case "lead": {
      const panel = state.panels[operation.panel];
      return panel && panel.leads !== false && state.leader !== panel.id
        ? { ...state, leader: panel.id }
        : state;
    }
    case "update": {
      const panel = state.panels[operation.panel];
      return panel
        ? {
            ...state,
            panels: {
              ...state.panels,
              [operation.panel]: { ...panel, ...operation.changes, id: panel.id },
            },
          }
        : state;
    }
    case "resize": {
      if (!state.root) {
        return state;
      }
      const sizes = operation.sizes;
      const resize = (node: LayoutNode): LayoutNode => {
        if (node.type === "stack") {
          return node;
        }
        if (node.id === operation.split) {
          return sizes.length === node.children.length
            ? { ...node, sizes: normalizeSizes(sizes, sizes.length) }
            : node;
        }
        const children = node.children.map(resize);
        return children.every((child, index) => child === node.children[index])
          ? node
          : { ...node, children };
      };
      const root = resize(state.root);
      return root === state.root ? state : { ...state, root };
    }
    case "configureEdge": {
      const current = state.edges[operation.side];
      const { options } = operation;
      const [id, seq] = current ? [current.stack.id, state.seq] : nextId(state);
      const base: EdgeRegion = current ?? {
        stack: { type: "stack", id, panels: [], active: null },
        size: defaultEdgeSize,
        visible: true,
      };
      const edge: EdgeRegion = {
        ...base,
        ...(options.size === undefined ? {} : { size: options.size }),
        ...(options.visible === undefined ? {} : { visible: options.visible }),
        ...(options.min === undefined ? {} : { min: options.min }),
        ...(options.max === undefined ? {} : { max: options.max }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      };
      const next = { ...state, seq, edges: { ...state.edges, [operation.side]: edge } };
      // Hiding the focused edge sends focus back to the main area.
      return !edge.visible && state.focus === edge.stack.id
        ? { ...next, focus: mainStacks(next)[0]?.id ?? null }
        : next;
    }
    case "maximize": {
      if (operation.stack === null) {
        return state.maximized === null ? state : { ...state, maximized: null };
      }
      return isMainStack(state, operation.stack)
        ? { ...state, maximized: operation.stack, focus: operation.stack }
        : state;
    }
    case "setView": {
      const next = state.view === operation.view ? state : { ...state, view: operation.view };
      const main = mainStacks(state);
      if (
        operation.view !== "canvas" ||
        !operation.frames ||
        main.some(({ id }) => state.canvas.frames[id])
      ) {
        return next;
      }
      const frames: { [stack: NodeId]: CanvasFrame } = {};
      main.forEach(({ id }, index) => {
        const rect = operation.frames?.[id];
        if (rect && validRect(rect)) {
          frames[id] = { ...sized(rect), z: index + 1 };
        }
      });
      // The frames are measured from the main area's corner, so the camera starts there.
      return { ...next, canvas: { frames, camera: { x: 0, y: 0, zoom: 1 } } };
    }
    case "setFrame": {
      const current = state.canvas.frames[operation.stack];
      if (!current || !isMainStack(state, operation.stack)) {
        return state;
      }
      const frame = { ...current, ...definedNumbers(operation.frame) };
      const next = { ...sized(frame), z: current.z };
      return sameRect(next, current) ? state : withFrame(state, operation.stack, next);
    }
    case "setCamera": {
      const camera = clampCamera({ ...state.canvas.camera, ...definedNumbers(operation.camera) });
      const current = state.canvas.camera;
      return camera.x === current.x && camera.y === current.y && camera.zoom === current.zoom
        ? state
        : { ...state, canvas: { ...state.canvas, camera } };
    }
    case "setColumnWidth": {
      const fraction = Math.min(
        columnFractionRange.max,
        Math.max(columnFractionRange.min, operation.fraction),
      );
      return Number.isFinite(fraction)
        ? { ...state, columns: { ...state.columns, [operation.node]: fraction } }
        : state;
    }
    case "flatten": {
      const stacks = mainStacks(state);
      const keep = stacks.find(({ id }) => id === state.focus) ?? stacks[0];
      if (!keep || stacks.length < 2) {
        return state;
      }
      const root: StackNode = { ...keep, panels: stacks.flatMap(({ panels }) => panels) };
      return { ...state, root, focus: keep.id, maximized: null };
    }
    case "batch":
      return operation.operations.reduce((next, child) => normalize(reduce(next, child)), state);
    case "load":
      return operation.state;
  }
}

/**
 * The arrangement of `target` holding exactly the panels of `current`: panels closed since are
 * left out, panels opened since join the focused stack (or their edge), and every panel keeps
 * its current description. Pass it to `store.undo` so undo rewinds where things are without
 * closing or reopening anything.
 */
export function keepPanels(target: WorkspaceState, current: WorkspaceState): WorkspaceState {
  let next = target;
  for (const id of Object.keys(target.panels)) {
    if (!Object.hasOwn(current.panels, id)) {
      next = apply(next, { type: "remove", panel: id });
    }
  }
  for (const [id, panel] of Object.entries(current.panels)) {
    if (!Object.hasOwn(next.panels, id)) {
      const stack = stackOfPanel(current, id);
      const side = stack ? edgeOfStack(current, stack.id) : null;
      next = apply(next, {
        type: "add",
        panel,
        target: side ? { at: "edge", side } : { at: "focus" },
        activate: false,
      });
    } else if (next.panels[id] !== panel) {
      next = { ...next, panels: { ...next.panels, [id]: panel } };
    }
  }
  return next;
}

function validRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value));
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** A rect that is at least as big as the smallest frame. */
function sized(rect: Rect): Rect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(canvasDefaults.minFrame.width, rect.width),
    height: Math.max(canvasDefaults.minFrame.height, rect.height),
  };
}

function definedNumbers<T extends object>(values: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
  ) as Partial<T>;
}

function withFrame(state: WorkspaceState, stack: NodeId, frame: CanvasFrame): WorkspaceState {
  return {
    ...state,
    canvas: { ...state.canvas, frames: { ...state.canvas.frames, [stack]: frame } },
  };
}

function topZ(state: WorkspaceState): number {
  return Math.max(0, ...Object.values(state.canvas.frames).map(({ z }) => z));
}

function nextId(state: WorkspaceState): [NodeId, number] {
  return [`n${String(state.seq)}`, state.seq + 1];
}

function activatePanel(state: WorkspaceState, panel: PanelId): WorkspaceState {
  const stack = stackOfPanel(state, panel);
  if (!stack) {
    return state;
  }
  const next =
    stack.active === panel
      ? state
      : updateStack(state, stack.id, (current) => ({ ...current, active: panel }));
  return focusStack(next, stack.id);
}

function focusStack(state: WorkspaceState, id: NodeId): WorkspaceState {
  const stack = findStack(state, id);
  if (!stack) {
    return state;
  }
  if (edgeOfStack(state, id)) {
    // An edge region is not part of a maximized workspace, so focusing one leaves maximize.
    // Whether the region is wanted is the user's to say (`configureEdge`), not focus's.
    return state.focus === id && state.maximized === null
      ? state
      : { ...state, focus: id, maximized: null };
  }
  // A maximized workspace keeps showing one stack, so maximize follows focus.
  const maximized = state.maximized === null ? null : id;
  return state.focus === id && maximized === state.maximized
    ? state
    : { ...state, focus: id, maximized };
}

/** Take a panel out of its stack, leaving its descriptor. Focus leaves a stack this empties. */
function detach(state: WorkspaceState, panel: PanelId): WorkspaceState {
  const stack = stackOfPanel(state, panel);
  if (!stack) {
    return state;
  }
  const index = stack.panels.indexOf(panel);
  const panels = stack.panels.filter((id) => id !== panel);
  const active =
    stack.active === panel ? (panels[index] ?? panels[index - 1] ?? null) : stack.active;
  let next = updateStack(state, stack.id, (current) => ({ ...current, panels, active }));
  if (!panels.length && state.focus === stack.id) {
    const main = mainStacks(state);
    const at = main.findIndex(({ id }) => id === stack.id);
    const neighbour = at >= 0 ? (main[at - 1] ?? main[at + 1]) : main[0];
    next = { ...next, focus: neighbour?.id ?? null };
    if (state.maximized === stack.id) {
      next = { ...next, maximized: neighbour?.id ?? null };
    }
  }
  return next;
}

function place(
  state: WorkspaceState,
  panel: PanelId,
  target: Target,
  activate: boolean,
): WorkspaceState {
  const source = stackOfPanel(state, panel);
  const resolved = resolve(state, target);
  if (
    source &&
    source.panels.length === 1 &&
    (resolved.at === "split" || resolved.at === "root") &&
    (resolved.at === "root" ? mainStacks(state).length === 1 && isMainStack(state, source.id) : resolved.stack === source.id)
  ) {
    // Splitting a panel away from itself would only recreate the stack it is already in.
    return activate ? activatePanel(state, panel) : state;
  }
  if (source && resolved.at === "stack" && resolved.stack === source.id) {
    // Reordering within a stack must not disturb focus.
    const rest = source.panels.filter((id) => id !== panel);
    const at = Math.min(rest.length, Math.max(0, resolved.index ?? rest.length));
    const panels = [...rest.slice(0, at), panel, ...rest.slice(at)];
    const reordered = updateStack(state, source.id, (stack) => ({ ...stack, panels }));
    return activate ? activatePanel(reordered, panel) : reordered;
  }
  if (resolved.at === "canvas") {
    const given: Partial<Size> = {
      ...(resolved.width === undefined ? {} : { width: resolved.width }),
      ...(resolved.height === undefined ? {} : { height: resolved.height }),
    };
    const from = source ? state.canvas.frames[source.id] : undefined;
    if (source && from && source.panels.length === 1 && isMainStack(state, source.id)) {
      // A panel that is alone in its pane takes the pane with it.
      const moved = withFrame(state, source.id, {
        ...sized({ ...from, ...given, x: resolved.x, y: resolved.y }),
        z: topZ(state) + 1,
      });
      return activate ? activatePanel(moved, panel) : moved;
    }
    const added = insert(detach(state, panel), panel, { at: "root", side: "right" }, activate);
    const created = stackOfPanel(added, panel);
    if (!created) {
      return added;
    }
    const size = { ...canvasDefaults.frame, ...(from ? { width: from.width, height: from.height } : {}), ...given };
    const framed = withFrame(added, created.id, {
      ...sized({ x: resolved.x, y: resolved.y, ...size }),
      z: topZ(added) + 1,
    });
    return activate ? activatePanel(framed, panel) : framed;
  }
  const detached = detach(state, panel);
  const inserted = placeFrame(insert(detached, panel, resolved, activate), panel, resolved);
  return activate ? activatePanel(inserted, panel) : inserted;
}

/**
 * On the canvas, a stack made by splitting goes beside what it was split from, on the side
 * that was asked for. (Stacks that get no frame here are placed by normalization.)
 */
function placeFrame(state: WorkspaceState, panel: PanelId, target: Resolved): WorkspaceState {
  if (state.view !== "canvas" || (target.at !== "split" && target.at !== "root")) {
    return state;
  }
  const created = stackOfPanel(state, panel);
  if (!created || state.canvas.frames[created.id]) {
    return state;
  }
  const live = mainStacks(state).flatMap(({ id, panels }) => {
    const frame = state.canvas.frames[id];
    return frame && panels.length ? [{ id, frame }] : [];
  });
  const node = target.at === "split" ? findNode(state.root, target.stack) : state.root;
  const beside = node ? new Set(stacksOf(node).map(({ id }) => id)) : new Set<NodeId>();
  const near = live.filter(({ id }) => beside.has(id)).map(({ frame }) => frame);
  const reference = boundsOf(near);
  if (!reference) {
    return state;
  }
  const top = live.reduce<CanvasFrame | undefined>(
    (best, { frame }) => (!best || frame.z > best.z ? frame : best),
    undefined,
  );
  const like = near.length === 1 ? near[0] : top;
  const size = like ? { width: like.width, height: like.height } : canvasDefaults.frame;
  const rect = frameBeside(
    live.map(({ frame }) => frame),
    reference,
    target.side,
    size,
  );
  return withFrame(state, created.id, { ...rect, z: topZ(state) + 1 });
}

type Resolved =
  | { readonly at: "stack"; readonly stack: NodeId; readonly index?: number }
  | { readonly at: "split"; readonly stack: NodeId; readonly side: SplitSide }
  | { readonly at: "root"; readonly side: SplitSide }
  | { readonly at: "edge"; readonly side: EdgeSide; readonly index?: number }
  | {
      readonly at: "canvas";
      readonly x: number;
      readonly y: number;
      readonly width?: number;
      readonly height?: number;
    };

function resolve(state: WorkspaceState, target: Target): Resolved {
  const index = "index" in target && target.index !== undefined ? { index: target.index } : {};
  switch (target.at) {
    case "focus": {
      const main = mainStacks(state);
      const stack = main.find(({ id }) => id === state.focus) ?? main[0];
      return stack ? { at: "stack", stack: stack.id, ...index } : { at: "root", side: "right" };
    }
    case "stack":
      return findStack(state, target.stack)
        ? { at: "stack", stack: target.stack, ...index }
        : resolve(state, { at: "focus", ...index });
    case "split":
      return isMainStack(state, target.stack)
        ? { at: "split", stack: target.stack, side: target.side }
        : { at: "root", side: target.side };
    case "beside": {
      const stack = stackOfPanel(state, target.panel);
      return stack && isMainStack(state, stack.id)
        ? { at: "split", stack: stack.id, side: target.side }
        : { at: "root", side: target.side };
    }
    case "column": {
      const main = mainStacks(state);
      const stack =
        main.find(({ id }) => id === (target.stack ?? state.focus)) ??
        main.find(({ id }) => id === state.focus) ??
        main[0];
      const root = state.root;
      if (!stack || root?.type !== "split" || root.direction !== "row") {
        return { at: "root", side: target.side };
      }
      const column = root.children.find((child) => findNode(child, stack.id));
      return column
        ? { at: "split", stack: column.id, side: target.side }
        : { at: "root", side: target.side };
    }
    case "root":
      return { at: "root", side: target.side };
    case "edge":
      return { at: "edge", side: target.side, ...index };
    case "canvas":
      return state.view === "canvas" && Number.isFinite(target.x) && Number.isFinite(target.y)
        ? target
        : { at: "root", side: "right" };
  }
}

function insert(
  state: WorkspaceState,
  panel: PanelId,
  target: Exclude<Resolved, { at: "canvas" }>,
  activate: boolean,
): WorkspaceState {
  if (target.at === "stack") {
    return updateStack(state, target.stack, (stack) => {
      const at = Math.min(stack.panels.length, Math.max(0, target.index ?? stack.panels.length));
      const panels = [...stack.panels.slice(0, at), panel, ...stack.panels.slice(at)];
      return { ...stack, panels, active: activate || stack.active === null ? panel : stack.active };
    });
  }
  if (target.at === "edge") {
    const [id, seq] = nextId(state);
    const edge: EdgeRegion = state.edges[target.side] ?? {
      stack: { type: "stack", id, panels: [], active: null },
      size: defaultEdgeSize,
      visible: true,
    };
    const created = !state.edges[target.side];
    // Putting a panel into a region is asking to see it there.
    const withEdge = created
      ? { ...state, seq, edges: { ...state.edges, [target.side]: edge } }
      : edge.visible
        ? state
        : { ...state, edges: { ...state.edges, [target.side]: { ...edge, visible: true } } };
    return insert(
      withEdge,
      panel,
      { at: "stack", stack: edge.stack.id, ...(target.index === undefined ? {} : { index: target.index }) },
      activate,
    );
  }
  const [id, seq] = nextId(state);
  const created: StackNode = { type: "stack", id, panels: [panel], active: panel };
  const direction: Direction = target.side === "left" || target.side === "right" ? "row" : "column";
  const before = target.side === "left" || target.side === "top";
  if (!state.root) {
    return { ...state, seq, root: created };
  }
  if (target.at === "root") {
    const root = state.root;
    if (root.type === "split" && root.direction === direction) {
      const share = 1 / (root.children.length + 1);
      const scaled = root.sizes.map((size) => size * (1 - share));
      return {
        ...state,
        seq,
        root: {
          ...root,
          children: before ? [created, ...root.children] : [...root.children, created],
          sizes: before ? [share, ...scaled] : [...scaled, share],
        },
      };
    }
    const [splitId, nextSeq] = nextId({ ...state, seq });
    return {
      ...state,
      seq: nextSeq,
      root: {
        type: "split",
        id: splitId,
        direction,
        children: before ? [created, root] : [root, created],
        sizes: [0.5, 0.5],
      },
    };
  }
  const parent = parentOf(state.root, target.stack);
  if (parent && parent.direction === direction) {
    const at = parent.children.findIndex(({ id: child }) => child === target.stack);
    const children = [...parent.children];
    children.splice(before ? at : at + 1, 0, created);
    // Siblings nobody has resized stay equal; otherwise the new one takes half of its neighbour
    // and the rest keep the sizes they were given.
    const first = parent.sizes[0] ?? 0;
    const even = parent.sizes.every((size) => Math.abs(size - first) < 1e-6);
    const half = (parent.sizes[at] ?? 0) / 2;
    const sizes = even ? children.map(() => 1 / children.length) : [...parent.sizes];
    if (!even) {
      sizes[at] = half;
      sizes.splice(before ? at : at + 1, 0, half);
    }
    const root = replaceNode(state.root, parent.id, { ...parent, children, sizes });
    return { ...state, seq, root };
  }
  const existing = findNode(state.root, target.stack);
  if (!existing) {
    return state;
  }
  const [splitId, nextSeq] = nextId({ ...state, seq });
  const split: LayoutNode = {
    type: "split",
    id: splitId,
    direction,
    children: before ? [created, existing] : [existing, created],
    sizes: [0.5, 0.5],
  };
  // In the columns view a stack that becomes a split keeps its column width.
  const width = state.columns[existing.id];
  const columns =
    width === undefined || direction === "row"
      ? state.columns
      : { ...state.columns, [splitId]: width };
  return { ...state, seq: nextSeq, columns, root: replaceNode(state.root, existing.id, split) };
}
