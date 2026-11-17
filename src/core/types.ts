/**
 * The layout document. Everything here is plain JSON: a workspace can be saved, diffed,
 * replayed and (later) synced without knowing anything about the DOM.
 */

export type PanelId = string;
export type NodeId = string;
export type EdgeSide = "left" | "right" | "top" | "bottom";
export type SplitSide = "left" | "right" | "top" | "bottom";
export type Direction = "row" | "column";
/** How the main area is shown on a wide screen. Narrow screens always show one panel. */
export type ViewMode = "tiling" | "columns";

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

/** A fixed region at one side of the workspace. It keeps its size when the main area changes. */
export interface EdgeRegion {
  readonly stack: StackNode;
  /** Width (left/right) or height (top/bottom) in CSS pixels. */
  readonly size: number;
  readonly visible: boolean;
  readonly min?: number;
  readonly max?: number;
  /**
   * Which region gives way first when the workspace is too narrow: lower yields sooner.
   * Regions with equal priority yield right, bottom, top, then left.
   */
  readonly priority?: number;
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
  /** A tab in an edge region. */
  | { readonly at: "edge"; readonly side: EdgeSide; readonly index?: number };

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
  | {
      readonly type: "update";
      readonly panel: PanelId;
      readonly changes: Partial<Omit<PanelDescriptor, "id">>;
    }
  | { readonly type: "resize"; readonly split: NodeId; readonly sizes: readonly number[] }
  | { readonly type: "configureEdge"; readonly side: EdgeSide; readonly options: EdgeOptions }
  | { readonly type: "maximize"; readonly stack: NodeId | null }
  | { readonly type: "setView"; readonly view: ViewMode }
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
