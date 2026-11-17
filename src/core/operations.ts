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
  updateStack,
} from "./tree.js";
import {
  type Direction,
  type EdgeRegion,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type Operation,
  type PanelId,
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
      return { ...detach(state, operation.panel), panels };
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
    case "setView":
      return state.view === operation.view ? state : { ...state, view: operation.view };
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
  const side = edgeOfStack(state, id);
  if (side) {
    // Focusing a panel in an edge means showing it: reveal the region and leave maximize.
    const edge = state.edges[side];
    const edges =
      edge && !edge.visible ? { ...state.edges, [side]: { ...edge, visible: true } } : state.edges;
    return state.focus === id && edges === state.edges && state.maximized === null
      ? state
      : { ...state, focus: id, edges, maximized: null };
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
  const detached = detach(state, panel);
  const inserted = insert(detached, panel, resolved, activate);
  return activate ? activatePanel(inserted, panel) : inserted;
}

type Resolved =
  | { readonly at: "stack"; readonly stack: NodeId; readonly index?: number }
  | { readonly at: "split"; readonly stack: NodeId; readonly side: SplitSide }
  | { readonly at: "root"; readonly side: SplitSide }
  | { readonly at: "edge"; readonly side: EdgeSide; readonly index?: number };

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
  }
}

function insert(
  state: WorkspaceState,
  panel: PanelId,
  target: Resolved,
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
    const withEdge = created
      ? { ...state, seq, edges: { ...state.edges, [target.side]: edge } }
      : state;
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
