import { canvasDefaults } from "./canvas.js";
import { type StackLayout, type WorkspaceLayout } from "./layout.js";
import { isMainStack, stackOfPanel } from "./tree.js";
import {
  type Camera,
  type NodeId,
  type PanelId,
  type Rect,
  type SplitSide,
  type Target,
  type WorkspaceState,
} from "./types.js";

export interface DropTarget {
  readonly target: Target;
  /**
   * Where the panel would land, in the coordinates of the stack it is over: the viewport when
   * `pinned`, else the scrolling main area or the canvas plane.
   */
  readonly indicator: Rect;
  readonly pinned: boolean;
}

export interface DropOptions {
  /** How far the main area has scrolled sideways (the `columns` view). */
  readonly scrollLeft?: number;
  /**
   * Tab boxes for a stack, measured by the view, in viewport coordinates and without the panel
   * being dragged. Without it a drop on a tab strip appends.
   */
  readonly tabs?: (stack: NodeId) => readonly Rect[];
  /** Fraction of a stack's body, from each side, that splits rather than joins. */
  readonly splitZone?: number;
  /** Band along the main area's outer sides that splits the whole area. */
  readonly rootZone?: number;
  /** The camera as drawn right now, when a view pans without waiting for the state. */
  readonly camera?: Camera;
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Where a dragged panel would go if released at a viewport point. Returns null when the point
 * is not over anything that accepts it.
 */
export function dropTargetAt(
  state: WorkspaceState,
  layout: WorkspaceLayout,
  panel: PanelId,
  point: { readonly x: number; readonly y: number },
  options: DropOptions = {},
): DropTarget | null {
  if (layout.mode === "stack" || layout.mode === "overview") {
    return null;
  }
  const source = stackOfPanel(state, panel);
  if (layout.mode === "canvas") {
    return canvasTarget(state, layout, source?.id ?? null, source?.panels.length === 1, point, options);
  }
  const scroll = options.scrollLeft ?? 0;
  // Pinned stacks sit above the scrolling main area, so they are tested first.
  const ordered = [...layout.stacks].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  for (const stack of ordered) {
    const x = stack.pinned ? point.x : point.x + scroll;
    if (!contains(stack.rect, x, point.y)) {
      continue;
    }
    if (!stack.pinned && !contains(layout.main, point.x, point.y)) {
      continue;
    }
    if (contains(stack.header, x, point.y)) {
      return tabTarget(stack, x, scroll, options.tabs?.(stack.id) ?? []);
    }
    const lone = source?.id === stack.id && source.panels.length === 1;
    const side = stack.edge || lone ? null : splitSide(stack, layout, x, point.y, options);
    if (side?.root) {
      return {
        target: { at: "root", side: side.side },
        indicator: half(shift(layout.main, stack.pinned ? 0 : scroll), side.side, 0.3),
        pinned: stack.pinned,
      };
    }
    if (side) {
      return {
        target: { at: "split", stack: stack.id, side: side.side },
        indicator: half(stack.rect, side.side, 0.5),
        pinned: stack.pinned,
      };
    }
    return {
      target: stack.edge
        ? { at: "edge", side: stack.edge }
        : { at: "stack", stack: stack.id },
      indicator: stack.body,
      pinned: stack.pinned,
    };
  }
  if (!state.root && contains(layout.main, point.x, point.y)) {
    return { target: { at: "focus" }, indicator: layout.main, pinned: true };
  }
  return null;
}

/** On the canvas a panel joins a pane it is dropped on, or gets a pane of its own on open ground. */
function canvasTarget(
  state: WorkspaceState,
  layout: WorkspaceLayout,
  source: NodeId | null,
  lone: boolean,
  point: { readonly x: number; readonly y: number },
  options: DropOptions,
): DropTarget | null {
  for (const stack of layout.stacks.filter(({ pinned }) => pinned)) {
    if (!contains(stack.rect, point.x, point.y)) {
      continue;
    }
    if (contains(stack.header, point.x, point.y)) {
      return tabTarget(stack, point.x, 0, options.tabs?.(stack.id) ?? []);
    }
    return {
      target: stack.edge ? { at: "edge", side: stack.edge } : { at: "stack", stack: stack.id },
      indicator: stack.body,
      pinned: true,
    };
  }
  if (!contains(layout.main, point.x, point.y)) {
    return null;
  }
  const camera = options.camera ?? layout.camera ?? { x: 0, y: 0, zoom: 1 };
  const toPlane = (rect: Rect): Rect => ({
    x: (rect.x - layout.main.x) / camera.zoom + camera.x,
    y: (rect.y - layout.main.y) / camera.zoom + camera.y,
    width: rect.width / camera.zoom,
    height: rect.height / camera.zoom,
  });
  const at = toPlane({ ...point, width: 0, height: 0 });
  const front = layout.stacks.filter(({ pinned }) => !pinned).sort((a, b) => b.layer - a.layer);
  for (const stack of front) {
    if (!contains(stack.rect, at.x, at.y)) {
      continue;
    }
    if (contains(stack.header, at.x, at.y)) {
      return tabTarget(stack, at.x, 0, (options.tabs?.(stack.id) ?? []).map(toPlane));
    }
    if (lone && stack.id === source) {
      break;
    }
    return { target: { at: "stack", stack: stack.id }, indicator: stack.body, pinned: false };
  }
  // Open ground: a pane of its own, held by the middle of its tab strip.
  const from = source !== null && isMainStack(state, source) ? state.canvas.frames[source] : undefined;
  const size = from ? { width: from.width, height: from.height } : canvasDefaults.frame;
  const grid = canvasDefaults.grid;
  const x = Math.round((at.x - size.width / 2) / grid) * grid;
  const y = Math.round((at.y - 18) / grid) * grid;
  return {
    target: { at: "canvas", x, y, ...size },
    indicator: { x, y, ...size },
    pinned: false,
  };
}

function shift(rect: Rect, x: number): Rect {
  return { ...rect, x: rect.x + x };
}

function tabTarget(
  stack: StackLayout,
  x: number,
  scroll: number,
  tabs: readonly Rect[],
): DropTarget {
  // Tab boxes arrive in viewport coordinates; compare in the stack's own.
  const offset = stack.pinned ? 0 : scroll;
  const boxes = tabs.map((tab) => shift(tab, offset));
  let index = boxes.findIndex((tab) => x < tab.x + tab.width / 2);
  if (index < 0) {
    index = boxes.length;
  }
  const before = boxes[index];
  const after = boxes[index - 1];
  const at = before ? before.x : after ? after.x + after.width : stack.header.x;
  return {
    target: stack.edge
      ? { at: "edge", side: stack.edge, index }
      : { at: "stack", stack: stack.id, index },
    indicator: { x: at - 1, y: stack.header.y, width: 2, height: stack.header.height },
    pinned: stack.pinned,
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
  const content = layout.mode === "columns" ? null : layout.main;
  const outer =
    content !== null &&
    ((side === "left" && x - content.x < band && body.x - content.x < 1) ||
      (side === "right" &&
        content.x + content.width - x < band &&
        content.x + content.width - (body.x + body.width) < 1) ||
      (side === "top" && y - content.y < band && stack.rect.y - content.y < 1) ||
      (side === "bottom" &&
        content.y + content.height - y < band &&
        content.y + content.height - (body.y + body.height) < 1));
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
