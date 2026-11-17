import {
  edgeSides,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type PanelId,
  type SplitNode,
  type StackNode,
  type WorkspaceState,
} from "./types.js";

export function emptyWorkspace(): WorkspaceState {
  return {
    version: 1,
    panels: {},
    root: null,
    edges: {},
    focus: null,
    maximized: null,
    view: "tiling",
    columns: {},
    canvas: { frames: {}, camera: { x: 0, y: 0, zoom: 1 } },
    leader: null,
    seq: 1,
  };
}

/** Main-area stacks in reading order (left to right, top to bottom). */
export function mainStacks(state: WorkspaceState): StackNode[] {
  return state.root ? stacksOf(state.root) : [];
}

export function stacksOf(node: LayoutNode): StackNode[] {
  return node.type === "stack" ? [node] : node.children.flatMap(stacksOf);
}

export function edgeStacks(state: WorkspaceState): { side: EdgeSide; stack: StackNode }[] {
  return edgeSides.flatMap((side) => {
    const edge = state.edges[side];
    return edge ? [{ side, stack: edge.stack }] : [];
  });
}

export function allStacks(state: WorkspaceState): StackNode[] {
  return [...mainStacks(state), ...edgeStacks(state).map(({ stack }) => stack)];
}

export function findStack(state: WorkspaceState, id: NodeId | null): StackNode | undefined {
  return id === null ? undefined : allStacks(state).find((stack) => stack.id === id);
}

export function stackOfPanel(state: WorkspaceState, panel: PanelId): StackNode | undefined {
  return allStacks(state).find((stack) => stack.panels.includes(panel));
}

/** The edge a stack belongs to, or null for a main-area stack. */
export function edgeOfStack(state: WorkspaceState, id: NodeId): EdgeSide | null {
  return edgeStacks(state).find(({ stack }) => stack.id === id)?.side ?? null;
}

export function isMainStack(state: WorkspaceState, id: NodeId | null): boolean {
  return id !== null && mainStacks(state).some((stack) => stack.id === id);
}

export function findNode(node: LayoutNode | null, id: NodeId): LayoutNode | undefined {
  if (!node) {
    return undefined;
  }
  if (node.id === id) {
    return node;
  }
  if (node.type === "split") {
    for (const child of node.children) {
      const found = findNode(child, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function parentOf(node: LayoutNode | null, id: NodeId): SplitNode | undefined {
  if (!node || node.type === "stack") {
    return undefined;
  }
  for (const child of node.children) {
    if (child.id === id) {
      return node;
    }
    const found = parentOf(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Replace (or, with null, remove) the node with this id. Sizes follow their children. */
export function replaceNode(
  node: LayoutNode,
  id: NodeId,
  replacement: LayoutNode | null,
): LayoutNode | null {
  if (node.id === id) {
    return replacement;
  }
  if (node.type === "stack") {
    return node;
  }
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  let changed = false;
  node.children.forEach((child, index) => {
    const next = replaceNode(child, id, replacement);
    if (next !== child) {
      changed = true;
    }
    if (next) {
      children.push(next);
      sizes.push(node.sizes[index] ?? 0);
    }
  });
  return changed ? { ...node, children, sizes } : node;
}

export function mapStacks(node: LayoutNode, map: (stack: StackNode) => StackNode): LayoutNode {
  if (node.type === "stack") {
    return map(node);
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = mapStacks(child, map);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Apply `map` to whichever stack has this id, in the main area or an edge. */
export function updateStack(
  state: WorkspaceState,
  id: NodeId,
  map: (stack: StackNode) => StackNode,
): WorkspaceState {
  const only = (stack: StackNode): StackNode => (stack.id === id ? map(stack) : stack);
  const root = state.root ? mapStacks(state.root, only) : null;
  let edges = state.edges;
  for (const side of edgeSides) {
    const edge = edges[side];
    if (edge?.stack.id === id) {
      edges = { ...edges, [side]: { ...edge, stack: map(edge.stack) } };
    }
  }
  return root === state.root && edges === state.edges ? state : { ...state, root, edges };
}

export function normalizeSizes(sizes: readonly number[], count: number): number[] {
  const usable = Array.from({ length: count }, (_, index) => {
    const value = sizes[index];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = usable.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return usable.map(() => 1 / count);
  }
  const missing = usable.filter((value) => value === 0).length;
  // A child without a usable size gets an even share of the whole.
  const share = missing ? 1 / count : 0;
  const scale = (1 - share * missing) / total;
  return usable.map((value) => (value === 0 ? share : value * scale));
}
