import { type StackLayout, type WorkspaceLayout } from "./layout.js";
import { stackOfPanel } from "./tree.js";
import {
  type NodeId,
  type PanelId,
  type Rect,
  type SplitSide,
  type Target,
  type WorkspaceState,
} from "./types.js";

export interface DropTarget {
  readonly target: Target;
  /** Where the panel would land, in the workspace's own coordinates. */
  readonly indicator: Rect;
}

export interface DropOptions {
  /**
   * Tab boxes for a stack, measured by the view, in the workspace's coordinates and without the
   * panel being dragged. Without it a drop on a tab strip appends.
   */
  readonly tabs?: (stack: NodeId) => readonly Rect[];
  /** Fraction of a stack's body, from each side, that splits rather than joins. */
  readonly splitZone?: number;
  /** Band along the main area's outer sides that splits the whole area. */
  readonly rootZone?: number;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Where a dragged panel would go if released at a point in the workspace. Returns null when
 * the point is not over anything that accepts it.
 */
export function dropTargetAt(
  state: WorkspaceState,
  layout: WorkspaceLayout,
  panel: PanelId,
  point: { readonly x: number; readonly y: number },
  options: DropOptions = {},
): DropTarget | null {
  if (layout.mode !== "tiling") {
    return null;
  }
  const source = stackOfPanel(state, panel);
  for (const stack of layout.stacks) {
    if (!contains(stack.rect, point.x, point.y)) {
      continue;
    }
    if (contains(stack.header, point.x, point.y)) {
      return tabTarget(stack, point.x, options.tabs?.(stack.id) ?? []);
    }
    const lone = source?.id === stack.id && source.panels.length === 1;
    const side = stack.edge || lone ? null : splitSide(stack, layout, point.x, point.y, options);
    if (side?.root) {
      return { target: { at: "root", side: side.side }, indicator: half(layout.main, side.side, 0.3) };
    }
    if (side) {
      return {
        target: { at: "split", stack: stack.id, side: side.side },
        indicator: half(stack.rect, side.side, 0.5),
      };
    }
    return {
      target: stack.edge ? { at: "edge", side: stack.edge } : { at: "stack", stack: stack.id },
      indicator: stack.body,
    };
  }
  if (!state.root && contains(layout.main, point.x, point.y)) {
    return { target: { at: "focus" }, indicator: layout.main };
  }
  return null;
}

function tabTarget(stack: StackLayout, x: number, tabs: readonly Rect[]): DropTarget {
  let index = tabs.findIndex((tab) => x < tab.x + tab.width / 2);
  if (index < 0) {
    index = tabs.length;
  }
  const before = tabs[index];
  const after = tabs[index - 1];
  const at = before ? before.x : after ? after.x + after.width : stack.header.x;
  return {
    target: stack.edge
      ? { at: "edge", side: stack.edge, index }
      : { at: "stack", stack: stack.id, index },
    indicator: { x: at - 1, y: stack.header.y, width: 2, height: stack.header.height },
  };
}

function splitSide(
  stack: StackLayout,
  layout: WorkspaceLayout,
  x: number,
  y: number,
  options: DropOptions,
): { side: SplitSide; root: boolean } | null {
  const zone = options.splitZone ?? 0.25;
  const band = options.rootZone ?? 14;
  const { body } = stack;
  const fromLeft = (x - body.x) / Math.max(1, body.width);
  const fromTop = (y - body.y) / Math.max(1, body.height);
  const distances: [SplitSide, number][] = [
    ["left", fromLeft],
    ["right", 1 - fromLeft],
    ["top", fromTop],
    ["bottom", 1 - fromTop],
  ];
  const [side, distance] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
  if (distance > zone) {
    return null;
  }
  // The outermost band of the main area splits the whole area, not just this stack.
  const content = layout.main;
  const outer =
    (side === "left" && x - content.x < band && body.x - content.x < 1) ||
    (side === "right" &&
      content.x + content.width - x < band &&
      content.x + content.width - (body.x + body.width) < 1) ||
    (side === "top" && y - content.y < band && stack.rect.y - content.y < 1) ||
    (side === "bottom" &&
      content.y + content.height - y < band &&
      content.y + content.height - (body.y + body.height) < 1);
  return { side, root: outer && layout.stacks.filter((item) => !item.edge).length > 1 };
}

function half(rect: Rect, side: SplitSide, fraction: number): Rect {
  const width = rect.width * fraction;
  const height = rect.height * fraction;
  switch (side) {
    case "left":
      return { ...rect, width };
    case "right":
      return { ...rect, x: rect.x + rect.width - width, width };
    case "top":
      return { ...rect, height };
    case "bottom":
      return { ...rect, y: rect.y + rect.height - height, height };
  }
}
