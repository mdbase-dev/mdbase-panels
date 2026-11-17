import { findStack, mainStacks } from "./tree.js";
import {
  type Camera,
  type EdgeSide,
  type LayoutNode,
  type NodeId,
  type PanelId,
  type Rect,
  type Size,
  type StackNode,
  type WorkspaceState,
} from "./types.js";

export type LayoutMode = "tiling" | "columns" | "canvas" | "stack" | "overview";

export interface LayoutOptions {
  /** Below this workspace width one panel is shown at a time. 0 disables it. */
  readonly compactBelow?: number;
  /** Height of a stack's tab strip. */
  readonly headerHeight?: number;
  /** Tab strip height while one panel is shown at a time; 0 leaves navigation to the app. */
  readonly compactHeaderHeight?: number;
  /** Thickness of the line between neighbouring stacks. */
  readonly gutter?: number;
  readonly minStackWidth?: number;
  readonly minStackHeight?: number;
  /** The main area never gets narrower than this; edge regions give way instead. */
  readonly minMainWidth?: number;
  readonly minMainHeight?: number;
  /** Default width of a column in the `columns` view, as a fraction of the main area. */
  readonly columnFraction?: number;
  readonly minColumnWidth?: number;
  /** Show every panel at once, scaled down. */
  readonly overview?: boolean;
  /** Space around and between overview cards, and the height of each card's label. */
  readonly overviewGap?: number;
  readonly overviewLabelHeight?: number;
  /**
   * Edge regions to leave out for now, whatever their `visible` says. This is how an app hides
   * a region for a passing reason (a reading mode, say) without forgetting what the user wants.
   */
  readonly hiddenEdges?: readonly EdgeSide[];
  /**
   * When there is not room for every region, this one is the last to give way, ahead of
   * priorities. An app sets it to the region the user asked for most recently.
   */
  readonly preferEdge?: EdgeSide | null;
}

const defaults = {
  compactBelow: 0,
  headerHeight: 36,
  compactHeaderHeight: 0,
  gutter: 1,
  minStackWidth: 180,
  minStackHeight: 120,
  minMainWidth: 240,
  minMainHeight: 160,
  columnFraction: 0.5,
  minColumnWidth: 320,
  overview: false,
  overviewGap: 24,
  overviewLabelHeight: 28,
  hiddenEdges: [] as readonly EdgeSide[],
  preferEdge: null as EdgeSide | null,
} satisfies Required<LayoutOptions>;

export interface StackLayout {
  readonly id: NodeId;
  /** Null for a main-area stack. */
  readonly edge: EdgeSide | null;
  readonly rect: Rect;
  readonly header: Rect;
  readonly body: Rect;
  /**
   * Pinned things are placed in the viewport and stay put. Everything else moves with the main
   * area: it scrolls sideways in the `columns` view, and in the `canvas` view its box is in
   * plane pixels, to be drawn through `WorkspaceLayout.camera`.
   */
  readonly pinned: boolean;
  readonly focused: boolean;
  /** Drawing order on the canvas, from 1 at the back. 0 everywhere else. */
  readonly layer: number;
}

export interface PanelLayout {
  readonly id: PanelId;
  readonly stack: NodeId;
  /** The panel's own box, before scaling. */
  readonly rect: Rect;
  readonly visible: boolean;
  /** 1 except in the overview. */
  readonly scale: number;
  readonly pinned: boolean;
  readonly layer: number;
}

export type SplitterLayout = {
  readonly id: string;
  readonly rect: Rect;
  /** `row` moves left and right; `column` moves up and down. */
  readonly direction: "row" | "column";
  readonly pinned: boolean;
} & (
  | {
      readonly kind: "split";
      readonly split: NodeId;
      /** The splitter sits between child `index` and `index + 1`. */
      readonly index: number;
      readonly sizes: readonly number[];
      readonly minimums: readonly number[];
    }
  | {
      readonly kind: "edge";
      readonly side: EdgeSide;
      readonly size: number;
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly kind: "column";
      readonly node: NodeId;
      readonly width: number;
      readonly min: number;
      /** The main area's width: a column's stored width is a fraction of it. */
      readonly basis: number;
    }
);

export interface OverviewCard {
  readonly panel: PanelId;
  readonly rect: Rect;
  readonly label: Rect;
}

export interface WorkspaceLayout {
  readonly mode: LayoutMode;
  readonly size: Size;
  /** The main area as it sits in the viewport, between the edge regions. */
  readonly main: Rect;
  /** Full scrollable width. Wider than `size.width` only in the `columns` view. */
  readonly contentWidth: number;
  readonly stacks: readonly StackLayout[];
  readonly panels: readonly PanelLayout[];
  readonly splitters: readonly SplitterLayout[];
  readonly cards: readonly OverviewCard[];
  /** Edge regions that gave way because the workspace is too small. */
  readonly yielded: readonly EdgeSide[];
  /** In the `canvas` mode, the camera that unpinned boxes are drawn through. Null otherwise. */
  readonly camera: Camera | null;
}

interface Context {
  readonly state: WorkspaceState;
  readonly options: Required<LayoutOptions>;
  readonly stacks: StackLayout[];
  readonly panels: PanelLayout[];
  readonly splitters: SplitterLayout[];
}

/** Where everything goes. Pure: the same state, size and options give the same layout. */
export function computeLayout(
  state: WorkspaceState,
  size: Size,
  layoutOptions: LayoutOptions = {},
): WorkspaceLayout {
  const options = { ...defaults, ...definedOnly(layoutOptions) };
  const context: Context = { state, options, stacks: [], panels: [], splitters: [] };
  const viewport: Rect = { x: 0, y: 0, width: Math.max(0, size.width), height: Math.max(0, size.height) };
  const compact = options.compactBelow > 0 && viewport.width < options.compactBelow;

  let mode: LayoutMode = compact ? "stack" : state.view;
  let main = viewport;
  let contentWidth = viewport.width;
  let yielded: EdgeSide[] = [];

  if (compact) {
    layoutCompact(context, viewport);
  } else if (state.maximized !== null && findStack(state, state.maximized)) {
    const stack = findStack(state, state.maximized);
    if (stack) {
      placeStack(context, stack, viewport, null, false);
    }
    mode = "tiling";
  } else {
    const edges = layoutEdges(context, viewport);
    main = edges.main;
    yielded = edges.yielded;
    if (state.root) {
      if (state.view === "columns") {
        contentWidth = layoutColumns(context, state.root, main, viewport);
      } else if (state.view === "canvas") {
        layoutCanvas(context);
      } else {
        layoutNode(context, state.root, main);
      }
    }
  }
  hideUnplaced(context, viewport);

  if (options.overview) {
    return overview(context, viewport, main, yielded);
  }
  return {
    mode,
    size: { width: viewport.width, height: viewport.height },
    main,
    contentWidth,
    stacks: context.stacks,
    panels: context.panels,
    splitters: context.splitters,
    cards: [],
    yielded,
    camera: mode === "canvas" ? state.canvas.camera : null,
  };
}

function definedOnly(options: LayoutOptions): LayoutOptions {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function placeStack(
  context: Context,
  stack: StackNode,
  rect: Rect,
  edge: EdgeSide | null,
  pinned: boolean,
  headerHeight = context.options.headerHeight,
  layer = 0,
): void {
  const head = Math.min(headerHeight, rect.height);
  const header: Rect = { x: rect.x, y: rect.y, width: rect.width, height: head };
  const body: Rect = { x: rect.x, y: rect.y + head, width: rect.width, height: rect.height - head };
  context.stacks.push({
    id: stack.id,
    edge,
    rect,
    header,
    body,
    pinned,
    focused: context.state.focus === stack.id,
    layer,
  });
  for (const id of stack.panels) {
    context.panels.push({
      id,
      stack: stack.id,
      rect: body,
      visible: stack.active === id,
      scale: 1,
      pinned,
      layer,
    });
  }
}

/**
 * Every main-area stack where its frame says, in plane pixels. Stacks keep their tree order
 * (so a view never has to reorder anything to raise a pane); `layer` says what is in front.
 */
function layoutCanvas(context: Context): void {
  const { state } = context;
  const stacks = mainStacks(state);
  const back = stacks
    .flatMap(({ id }) => (state.canvas.frames[id] ? [id] : []))
    .sort((a, b) => (state.canvas.frames[a]?.z ?? 0) - (state.canvas.frames[b]?.z ?? 0));
  for (const stack of stacks) {
    const frame = state.canvas.frames[stack.id];
    if (!frame) {
      continue;
    }
    const rect: Rect = {
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      width: Math.round(frame.width),
      height: Math.round(frame.height),
    };
    placeStack(context, stack, rect, null, false, context.options.headerHeight, back.indexOf(stack.id) + 1);
  }
}

/** One panel fills the workspace: the focused stack's active panel. */
function layoutCompact(context: Context, viewport: Rect): void {
  const { state } = context;
  const stack =
    findStack(state, state.focus) ??
    mainStacks(state)[0] ??
    Object.values(state.edges).find((edge) => edge.stack.panels.length)?.stack;
  if (stack) {
    placeStack(context, stack, viewport, null, true, context.options.compactHeaderHeight);
  }
}

/** Panels that are not on screen keep a sensible box, so their content never lays out at zero. */
function hideUnplaced(context: Context, viewport: Rect): void {
  const placed = new Set(context.panels.map(({ id }) => id));
  const { state, options } = context;
  const add = (stack: StackNode, rect: Rect): void => {
    for (const id of stack.panels) {
      if (!placed.has(id)) {
        context.panels.push({
          id,
          stack: stack.id,
          rect,
          visible: false,
          scale: 1,
          pinned: true,
          layer: 0,
        });
      }
    }
  };
  mainStacks(state).forEach((stack) => add(stack, viewport));
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const edge = state.edges[side];
    if (!edge) {
      continue;
    }
    // A hidden region's panels keep the region's size, so showing it again does not reflow them.
    const size = Math.max(1, Math.round(edge.size));
    const head = options.headerHeight;
    add(
      edge.stack,
      side === "left" || side === "right"
        ? { x: 0, y: head, width: Math.min(size, viewport.width), height: Math.max(0, viewport.height - head) }
        : { x: 0, y: head, width: viewport.width, height: Math.max(0, Math.min(size, viewport.height) - head) },
    );
  }
}

function layoutEdges(context: Context, viewport: Rect): { main: Rect; yielded: EdgeSide[] } {
  const { state, options } = context;
  const size = (side: EdgeSide, available: number): number => {
    const edge = state.edges[side];
    if (!edge?.visible || !edge.stack.panels.length || options.hiddenEdges.includes(side)) {
      return 0;
    }
    const min = edge.min ?? (side === "left" || side === "right" ? options.minStackWidth : options.minStackHeight);
    const max = Math.max(min, edge.max ?? Number.POSITIVE_INFINITY);
    return Math.round(Math.min(Math.min(max, available), Math.max(min, edge.size)));
  };
  const sizes: Record<EdgeSide, number> = {
    left: size("left", viewport.width),
    right: size("right", viewport.width),
    top: size("top", viewport.height),
    bottom: size("bottom", viewport.height),
  };
  const yielded: EdgeSide[] = [];
  // Regions give way until the main area has room: lowest priority first, and the preferred
  // region last of all.
  const rank = (side: EdgeSide): number =>
    side === options.preferEdge ? Number.POSITIVE_INFINITY : (state.edges[side]?.priority ?? 0);
  const giveWay = (sides: readonly EdgeSide[], room: () => number, minimum: number): void => {
    const order = [...sides]
      .filter((side) => sizes[side] > 0)
      .sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1));
    for (const side of order) {
      if (room() >= minimum) {
        break;
      }
      sizes[side] = 0;
      yielded.push(side);
    }
  };
  giveWay(["right", "left"], () => viewport.width - sizes.left - sizes.right, options.minMainWidth);
  giveWay(["bottom", "top"], () => viewport.height - sizes.top - sizes.bottom, options.minMainHeight);

  const gutter = options.gutter;
  const inner = {
    x: sizes.left ? sizes.left + gutter : 0,
    right: sizes.right ? sizes.right + gutter : 0,
    y: sizes.top ? sizes.top + gutter : 0,
    bottom: sizes.bottom ? sizes.bottom + gutter : 0,
  };
  const main: Rect = {
    x: inner.x,
    y: inner.y,
    width: Math.max(0, viewport.width - inner.x - inner.right),
    height: Math.max(0, viewport.height - inner.y - inner.bottom),
  };
  const regions: Record<EdgeSide, Rect> = {
    left: { x: 0, y: 0, width: sizes.left, height: viewport.height },
    right: { x: viewport.width - sizes.right, y: 0, width: sizes.right, height: viewport.height },
    top: { x: main.x, y: 0, width: main.width, height: sizes.top },
    bottom: { x: main.x, y: viewport.height - sizes.bottom, width: main.width, height: sizes.bottom },
  };
  const bars: Record<EdgeSide, Rect> = {
    left: { x: sizes.left, y: 0, width: gutter, height: viewport.height },
    right: { x: viewport.width - sizes.right - gutter, y: 0, width: gutter, height: viewport.height },
    top: { x: main.x, y: sizes.top, width: main.width, height: gutter },
    bottom: { x: main.x, y: viewport.height - sizes.bottom - gutter, width: main.width, height: gutter },
  };
  for (const side of ["left", "right", "top", "bottom"] as const) {
    const edge = state.edges[side];
    if (!edge || !sizes[side]) {
      continue;
    }
    placeStack(context, edge.stack, regions[side], side, true);
    const horizontal = side === "left" || side === "right";
    const min = edge.min ?? (horizontal ? options.minStackWidth : options.minStackHeight);
    const room = horizontal
      ? viewport.width - sizes.left - sizes.right + sizes[side] - options.minMainWidth
      : viewport.height - sizes.top - sizes.bottom + sizes[side] - options.minMainHeight;
    context.splitters.push({
      id: `edge:${side}`,
      kind: "edge",
      side,
      rect: bars[side],
      direction: horizontal ? "row" : "column",
      pinned: true,
      size: sizes[side],
      min,
      max: Math.max(min, Math.min(edge.max ?? Number.POSITIVE_INFINITY, room)),
    });
  }
  return { main, yielded };
}

function minimum(context: Context, node: LayoutNode, axis: "width" | "height"): number {
  const { options, state } = context;
  if (node.type === "stack") {
    const floor = axis === "width" ? options.minStackWidth : options.minStackHeight;
    const own = node.panels.map((id) => {
      const panel = state.panels[id];
      return (axis === "width" ? panel?.minWidth : panel?.minHeight) ?? 0;
    });
    const header = axis === "height" ? options.headerHeight : 0;
    return Math.max(floor, ...own.map((value) => value + header));
  }
  const along = (node.direction === "row") === (axis === "width");
  const each = node.children.map((child) => minimum(context, child, axis));
  return along
    ? each.reduce((sum, value) => sum + value, 0) + options.gutter * (node.children.length - 1)
    : Math.max(...each);
}

/** Share `available` pixels by weight, without letting any child go below its minimum. */
export function distribute(
  weights: readonly number[],
  minimums: readonly number[],
  available: number,
): number[] {
  const count = weights.length;
  const floor = minimums.reduce((sum, value) => sum + value, 0);
  if (available <= floor) {
    // Not enough room for the minimums: everything shrinks in proportion.
    return minimums.map((value) => (floor > 0 ? (value / floor) * available : available / count));
  }
  const sizes = new Array<number>(count).fill(0);
  const fixed = new Array<boolean>(count).fill(false);
  for (let pass = 0; pass < count; pass += 1) {
    const room = available - sizes.reduce((sum, value, index) => (fixed[index] ? sum + value : sum), 0);
    const weight = weights.reduce((sum, value, index) => (fixed[index] ? sum : sum + value), 0);
    let clamped = false;
    for (let index = 0; index < count; index += 1) {
      if (fixed[index]) {
        continue;
      }
      const share = weight > 0 ? ((weights[index] ?? 0) / weight) * room : room / count;
      const least = minimums[index] ?? 0;
      if (share < least) {
        sizes[index] = least;
        fixed[index] = true;
        clamped = true;
      } else {
        sizes[index] = share;
      }
    }
    if (!clamped) {
      break;
    }
  }
  return sizes;
}

function layoutNode(context: Context, node: LayoutNode, rect: Rect): void {
  if (node.type === "stack") {
    placeStack(context, node, rect, null, false);
    return;
  }
  const { gutter } = context.options;
  const row = node.direction === "row";
  const axis = row ? "width" : "height";
  const available = Math.max(0, rect[axis] - gutter * (node.children.length - 1));
  const minimums = node.children.map((child) => minimum(context, child, axis));
  const sizes = roundTo(distribute(node.sizes, minimums, available), available);
  let offset = row ? rect.x : rect.y;
  node.children.forEach((child, index) => {
    const length = sizes[index] ?? 0;
    const childRect: Rect = row
      ? { x: offset, y: rect.y, width: length, height: rect.height }
      : { x: rect.x, y: offset, width: rect.width, height: length };
    layoutNode(context, child, childRect);
    offset += length;
    if (index < node.children.length - 1) {
      context.splitters.push({
        id: `split:${node.id}:${String(index)}`,
        kind: "split",
        split: node.id,
        index,
        rect: row
          ? { x: offset, y: rect.y, width: gutter, height: rect.height }
          : { x: rect.x, y: offset, width: rect.width, height: gutter },
        direction: node.direction,
        pinned: false,
        sizes,
        minimums,
      });
      offset += gutter;
    }
  });
}

/** Whole pixels that still add up to the total. */
function roundTo(sizes: readonly number[], total: number): number[] {
  const rounded = sizes.map((value) => Math.floor(value));
  let spare = Math.round(total) - rounded.reduce((sum, value) => sum + value, 0);
  for (let index = 0; spare > 0 && index < rounded.length; index += 1, spare -= 1) {
    rounded[index] = (rounded[index] ?? 0) + 1;
  }
  return rounded;
}

/** The top-level children of the root row, or the root itself. */
export function columnNodes(root: LayoutNode): readonly LayoutNode[] {
  return root.type === "split" && root.direction === "row" ? root.children : [root];
}

/** A strip of columns that can be wider than the workspace. Returns the full content width. */
function layoutColumns(context: Context, root: LayoutNode, main: Rect, viewport: Rect): number {
  const { options, state } = context;
  const nodes = columnNodes(root);
  const gutter = options.gutter;
  const least = Math.min(options.minColumnWidth, main.width);
  let widths = nodes.map((node) =>
    Math.max(
      Math.min(minimum(context, node, "width"), main.width),
      least,
      Math.min(1, state.columns[node.id] ?? options.columnFraction) * main.width,
    ),
  );
  const gutters = gutter * (nodes.length - 1);
  const sum = widths.reduce((total, value) => total + value, 0);
  if (sum <= main.width + 0.5) {
    // Columns that fit share the main area exactly: they grow to fill a gap, and give up the
    // few pixels their dividers need (two half-width columns must not scroll by a pixel).
    const scale = (main.width - gutters) / sum;
    widths = widths.map((value) => value * scale);
  }
  widths = roundTo(
    widths,
    Math.round(widths.reduce((total, value) => total + value, 0)),
  );
  let x = main.x;
  nodes.forEach((node, index) => {
    const width = widths[index] ?? 0;
    layoutNode(context, node, { x, y: main.y, width, height: main.height });
    x += width;
    context.splitters.push({
      id: `column:${node.id}`,
      kind: "column",
      node: node.id,
      rect: { x: index === nodes.length - 1 ? x - gutter : x, y: main.y, width: gutter, height: main.height },
      direction: "row",
      pinned: false,
      width,
      min: least,
      basis: main.width,
    });
    if (index < nodes.length - 1) {
      x += gutter;
    }
  });
  return x + (viewport.width - main.x - main.width);
}

/** Every panel at once, each scaled to fit a card in a grid. */
function overview(
  context: Context,
  viewport: Rect,
  main: Rect,
  yielded: EdgeSide[],
): WorkspaceLayout {
  const { options, state } = context;
  const order = [
    ...mainStacks(state).flatMap(({ panels }) => panels),
    ...Object.values(state.edges).flatMap(({ stack }) => stack.panels),
  ];
  const natural = new Map(context.panels.map((panel) => [panel.id, panel]));
  const count = order.length;
  const gap = options.overviewGap;
  const label = options.overviewLabelHeight;
  let best = { columns: 1, rows: Math.max(1, count), cell: { width: 0, height: 0 }, area: -1 };
  for (let columns = 1; columns <= Math.max(1, count); columns += 1) {
    const rows = Math.ceil(count / columns);
    const width = (viewport.width - gap * (columns + 1)) / columns;
    const height = (viewport.height - gap * (rows + 1)) / rows - label;
    if (width <= 0 || height <= 0) {
      continue;
    }
    // Prefer the grid whose cells best match the shape of a typical panel.
    const fit = Math.min(width / Math.max(1, main.width), height / Math.max(1, main.height));
    if (fit > best.area) {
      best = { columns, rows, cell: { width, height }, area: fit };
    }
  }
  const cards: OverviewCard[] = [];
  const panels: PanelLayout[] = order.flatMap((id, index) => {
    const panel = natural.get(id);
    if (!panel) {
      return [];
    }
    const column = index % best.columns;
    const row = Math.floor(index / best.columns);
    const cellX = gap + column * (best.cell.width + gap);
    const cellY = gap + row * (best.cell.height + label + gap);
    const own = panel.rect.width > 0 && panel.rect.height > 0 ? panel.rect : main;
    const scale = Math.min(
      1,
      best.cell.width / Math.max(1, own.width),
      best.cell.height / Math.max(1, own.height),
    );
    const width = own.width * scale;
    const height = own.height * scale;
    const x = cellX + (best.cell.width - width) / 2;
    const y = cellY + label + (best.cell.height - height) / 2;
    cards.push({
      panel: id,
      rect: { x, y: y - label, width, height: height + label },
      label: { x, y: y - label, width, height: label },
    });
    return [
      {
        id,
        stack: panel.stack,
        rect: { x, y, width: own.width, height: own.height },
        visible: true,
        scale,
        pinned: true,
        layer: 0,
      },
    ];
  });
  return {
    mode: "overview",
    size: { width: viewport.width, height: viewport.height },
    main,
    contentWidth: viewport.width,
    stacks: [],
    panels,
    splitters: [],
    cards,
    yielded,
    camera: null,
  };
}
