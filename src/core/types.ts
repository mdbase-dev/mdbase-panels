/**
 * The layout document. Everything here is plain JSON: a workspace can be saved, diffed,
 * replayed and (later) synced without knowing anything about the DOM.
 */

export type PanelId = string;
export type NodeId = string;
export type EdgeSide = "left" | "right" | "top" | "bottom";
export type SplitSide = "left" | "right" | "top" | "bottom";
export type Direction = "row" | "column";
/**
 * How the main area is shown on a wide screen. Narrow screens always show one panel.
 * `tiling` fills the area, `columns` is a strip that scrolls sideways, and `canvas` is an
 * unbounded plane where every stack has a position and size of its own.
 */
export type ViewMode = "tiling" | "columns" | "canvas";

export const viewModes = ["tiling", "columns", "canvas"] as const;

export const edgeSides = ["left", "right", "top", "bottom"] as const;

/** JSON the owning app understands; the library stores it and never reads it. */
export type PanelData =
  | null
  | boolean
  | number
  | string
  | readonly PanelData[]
  | { readonly [key: string]: PanelData };

export interface PanelDescriptor {
  /** Stable for the panel's whole life; independent of where it is placed. */
  readonly id: PanelId;
  /** Which renderer shows this panel (an app-defined name). */
  readonly kind: string;
  /** Which application owns the panel. Lets one workspace hold panels from several apps. */
  readonly app?: string;
  readonly title?: string;
  readonly data?: PanelData;
  /** Smallest useful size in CSS pixels. */
  readonly minWidth?: number;
  readonly minHeight?: number;
  /**
   * Whether focusing this panel makes it the workspace's leader (see `WorkspaceState.leader`).
   * Defaults to true. Set it to false on panels that show something about another panel, such
   * as an outline or an inspector, so that using them does not change what they are about.
   */
  readonly leads?: boolean;
}

export interface StackNode {
  readonly type: "stack";
  readonly id: NodeId;
  /** Tab order. */
  readonly panels: readonly PanelId[];
  readonly active: PanelId | null;
}

export interface SplitNode {
  readonly type: "split";
  readonly id: NodeId;
  readonly direction: Direction;
  readonly children: readonly LayoutNode[];
  /** Relative weights, one per child, summing to 1. */
  readonly sizes: readonly number[];
}

export type LayoutNode = StackNode | SplitNode;

/**
 * A region docked to one side of the workspace. It is an ordinary stack that keeps its size
 * when the main area changes: any panel can live there, and a region with no panels takes no
 * room.
 */
export interface EdgeRegion {
  readonly stack: StackNode;
  /** Width (left/right) or height (top/bottom) in CSS pixels. */
  readonly size: number;
  /**
   * Whether the user wants this region shown. Only `configureEdge` and putting a panel into the
   * region change it. Whether it is on screen right now also depends on things that are never
   * saved: room (`minMainWidth`), `LayoutOptions.hiddenEdges`, maximize and narrow screens.
   */
  readonly visible: boolean;
  readonly min?: number;
  readonly max?: number;
  /**
   * Which region gives way first when the workspace is too narrow: lower yields sooner.
   * Regions with equal priority yield right, bottom, top, then left.
   */
  readonly priority?: number;
}

/** Which part of the canvas is on screen: the plane point at the main area's top-left corner. */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Where a stack sits on the canvas, in plane pixels. A higher `z` is drawn in front. */
export interface CanvasFrame extends Rect {
  readonly z: number;
}

export interface CanvasState {
  /**
   * One frame per main-area stack while the view is `canvas`. Frames are kept when the view
   * changes, so going back to the canvas finds things where they were left.
   */
  readonly frames: { readonly [stack: NodeId]: CanvasFrame };
  readonly camera: Camera;
}

export interface WorkspaceState {
  readonly version: 1;
  readonly panels: { readonly [id: PanelId]: PanelDescriptor };
  /** The main area; null when nothing is open there. */
  readonly root: LayoutNode | null;
  readonly edges: { readonly [side in EdgeSide]?: EdgeRegion };
  /** The stack that has focus (main area or an edge). */
  readonly focus: NodeId | null;
  /** A main-area stack shown alone, hiding the others and the edges. */
  readonly maximized: NodeId | null;
  readonly view: ViewMode;
  /**
   * Column widths for the `columns` view, as a fraction of the main area's width, keyed by the
   * id of a top-level child of the root row.
   */
  readonly columns: { readonly [id: NodeId]: number };
  /** Positions for the `canvas` view. */
  readonly canvas: CanvasState;
  /**
   * The panel that follower panels are about: the panel that last had focus, not counting
   * panels with `leads: false`. Null when no panel can lead. What a follower shows is up to
   * the app; the workspace only keeps track of whom to follow.
   */
  readonly leader: PanelId | null;
  /** Source of deterministic ids for nodes created by operations. */
  readonly seq: number;
}

/** Where a panel should go. */
export type Target =
  /** The focused main-area stack (or a new one if the main area is empty). */
  | { readonly at: "focus"; readonly index?: number }
  /** A tab in an existing stack. */
  | { readonly at: "stack"; readonly stack: NodeId; readonly index?: number }
  /** A new stack beside an existing one. */
  | { readonly at: "split"; readonly stack: NodeId; readonly side: SplitSide }
  /** A new stack beside the stack that holds another panel: "show X beside Y". */
  | { readonly at: "beside"; readonly panel: PanelId; readonly side: SplitSide }
  /**
   * A new top-level column next to the column that holds a stack (the focused one by default).
   * In the `columns` view this is "open beside": the new panel gets a column of its own.
   */
  | { readonly at: "column"; readonly stack?: NodeId; readonly side: "left" | "right" }
  /** A new stack along one side of the whole main area. */
  | { readonly at: "root"; readonly side: SplitSide }
  /** A tab in an edge region. Putting a panel there shows the region. */
  | { readonly at: "edge"; readonly side: EdgeSide; readonly index?: number }
  /**
   * A new stack at a point on the canvas (plane pixels, the new frame's top-left corner). A
   * panel that is alone in its stack takes the stack with it. In other views it is a new stack
   * at the right.
   */
  | {
      readonly at: "canvas";
      readonly x: number;
      readonly y: number;
      readonly width?: number;
      readonly height?: number;
    };

export interface EdgeOptions {
  readonly size?: number;
  readonly visible?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly priority?: number;
}

/** Every change to a workspace is one of these. They are data, so they can be logged or replayed. */
export type Operation =
  | {
      readonly type: "add";
      readonly panel: PanelDescriptor;
      readonly target?: Target;
      /** Defaults to true. */
      readonly activate?: boolean;
    }
  | { readonly type: "remove"; readonly panel: PanelId }
  | {
      readonly type: "move";
      readonly panel: PanelId;
      readonly target: Target;
      readonly activate?: boolean;
    }
  | { readonly type: "moveStack"; readonly stack: NodeId; readonly target: Target }
  | { readonly type: "activate"; readonly panel: PanelId }
  | { readonly type: "focus"; readonly stack: NodeId }
  /**
   * Name the leader, for when the focused panel does not lead: a panel that has just become a
   * follower says which panel it follows. Ignored for a panel that cannot lead.
   */
  | { readonly type: "lead"; readonly panel: PanelId }
  | {
      readonly type: "update";
      readonly panel: PanelId;
      readonly changes: Partial<Omit<PanelDescriptor, "id">>;
    }
  | { readonly type: "resize"; readonly split: NodeId; readonly sizes: readonly number[] }
  | { readonly type: "configureEdge"; readonly side: EdgeSide; readonly options: EdgeOptions }
  | { readonly type: "maximize"; readonly stack: NodeId | null }
  | {
      readonly type: "setView";
      readonly view: ViewMode;
      /**
       * Going to the canvas for the first time: where each main-area stack is on screen now
       * (relative to the main area), so that the switch does not move anything. Ignored when
       * any stack already has a frame.
       */
      readonly frames?: { readonly [stack: NodeId]: Rect };
    }
  /** Move or resize a stack on the canvas. */
  | { readonly type: "setFrame"; readonly stack: NodeId; readonly frame: Partial<Rect> }
  /** Pan or zoom the canvas. Not an undo step. */
  | { readonly type: "setCamera"; readonly camera: Partial<Camera> }
  | { readonly type: "setColumnWidth"; readonly node: NodeId; readonly fraction: number }
  /** Gather every main-area panel into one stack, keeping the panels themselves. */
  | { readonly type: "flatten" }
  | { readonly type: "batch"; readonly operations: readonly Operation[] }
  | { readonly type: "load"; readonly state: WorkspaceState };

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}
