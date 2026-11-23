import { mainStacks } from "./tree.js";
import {
  type Camera,
  type CanvasFrame,
  type NodeId,
  type Rect,
  type Size,
  type SplitSide,
  type WorkspaceState,
} from "./types.js";

export const canvasDefaults = {
  /** A frame nobody has sized yet. */
  frame: { width: 640, height: 720 },
  minFrame: { width: 240, height: 160 },
  /** Space left between frames that are placed automatically. */
  gap: 32,
  zoom: { min: 0.1, max: 2 },
  /** Frames moved or resized by hand land on multiples of this. */
  grid: 8,
} as const;

export type FrameHandle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export function clampZoom(zoom: number): number {
  const { min, max } = canvasDefaults.zoom;
  return Number.isFinite(zoom) ? Math.min(max, Math.max(min, zoom)) : 1;
}

/**
 * A zoom step that settles on actual size when it reaches it: one that crosses 100%, or lands
 * within a few percent of it on the way there, stops at exactly 100%. Steps away are untouched,
 * so the view never sticks.
 */
export function towardsActualSize(from: number, to: number, within = 0.04): number {
  const approaching = Math.abs(to - 1) < Math.abs(from - 1);
  const crossed = (from - 1) * (to - 1) < 0;
  return crossed || (approaching && Math.abs(to - 1) < within) ? 1 : to;
}

export function clampCamera(camera: Camera): Camera {
  // Adding zero turns a negative zero into zero: a camera has to survive being written as JSON.
  const x = Number.isFinite(camera.x) ? camera.x + 0 : 0;
  const y = Number.isFinite(camera.y) ? camera.y + 0 : 0;
  const zoom = clampZoom(camera.zoom);
  return Object.is(x, camera.x) && Object.is(y, camera.y) && zoom === camera.zoom
    ? camera
    : { x, y, zoom };
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.zoom - b.zoom) < 1e-4;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * A free place for a new frame on one side of `reference`. If something is already there the
 * frame goes further out in the same direction, so nothing is ever covered.
 */
export function frameBeside(
  frames: readonly Rect[],
  reference: Rect,
  side: SplitSide,
  size: Size,
): Rect {
  const { gap } = canvasDefaults;
  let rect: Rect =
    side === "right"
      ? { x: reference.x + reference.width + gap, y: reference.y, ...size }
      : side === "left"
        ? { x: reference.x - gap - size.width, y: reference.y, ...size }
        : side === "bottom"
          ? { x: reference.x, y: reference.y + reference.height + gap, ...size }
          : { x: reference.x, y: reference.y - gap - size.height, ...size };
  // Each pass moves past one frame, and never back over it, so this ends.
  for (let pass = 0; pass <= frames.length; pass += 1) {
    const current = rect;
    const hit = frames.find((frame) => overlaps(frame, current));
    if (!hit) {
      break;
    }
    rect =
      side === "right"
        ? { ...rect, x: hit.x + hit.width + gap }
        : side === "left"
          ? { ...rect, x: hit.x - gap - rect.width }
          : side === "bottom"
            ? { ...rect, y: hit.y + hit.height + gap }
            : { ...rect, y: hit.y - gap - rect.height };
  }
  return rect;
}

/** The frames of the stacks that are in the main area, in tab order of the tree. */
export function canvasFrames(state: WorkspaceState): { id: NodeId; frame: CanvasFrame }[] {
  return mainStacks(state).flatMap(({ id }) => {
    const frame = state.canvas.frames[id];
    return frame ? [{ id, frame }] : [];
  });
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) {
    return null;
  }
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** The camera that shows all of `bounds`, centred, without zooming in past `maxZoom`. */
export function cameraToFit(bounds: Rect, viewport: Size, padding = 32, maxZoom = 1): Camera {
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (viewport.width - padding * 2) / Math.max(1, bounds.width),
      (viewport.height - padding * 2) / Math.max(1, bounds.height),
    ),
  );
  return {
    x: bounds.x + bounds.width / 2 - viewport.width / zoom / 2,
    y: bounds.y + bounds.height / 2 - viewport.height / zoom / 2,
    zoom,
  };
}

/**
 * The smallest pan that brings a frame into view; none at all if every part of it already is.
 * A frame larger than the viewport is shown from its top-left corner. The zoom is left alone.
 */
export function cameraToReveal(camera: Camera, frame: Rect, viewport: Size, margin = 24): Camera {
  const pad = margin / camera.zoom;
  const along = (at: number, start: number, length: number, room: number): number => {
    const end = start + length;
    if (start >= at && end <= at + room) {
      return at;
    }
    if (length + pad * 2 <= room) {
      return start < at ? start - pad : end + pad - room;
    }
    if (length <= room) {
      return start - (room - length) / 2;
    }
    return start <= at && end >= at + room ? at : start - pad;
  };
  const x = along(camera.x, frame.x, frame.width, viewport.width / camera.zoom);
  const y = along(camera.y, frame.y, frame.height, viewport.height / camera.zoom);
  return x === camera.x && y === camera.y ? camera : { ...camera, x, y };
}

/** Zoom so that the plane point under `point` (measured from the main area's corner) stays put. */
export function zoomCameraAt(
  camera: Camera,
  point: { readonly x: number; readonly y: number },
  zoom: number,
): Camera {
  const next = clampZoom(zoom);
  return {
    x: camera.x + point.x / camera.zoom - point.x / next,
    y: camera.y + point.y / camera.zoom - point.y / next,
    zoom: next,
  };
}

/** A frame after dragging one of its handles by a distance in plane pixels. */
export function dragFrame(
  start: Rect,
  handle: FrameHandle,
  dx: number,
  dy: number,
  options: { readonly grid?: number; readonly min?: Size } = {},
): Rect {
  const grid = options.grid ?? canvasDefaults.grid;
  const min = options.min ?? canvasDefaults.minFrame;
  const snap = (value: number): number => (grid > 0 ? Math.round(value / grid) * grid : value);
  if (handle === "move") {
    return { ...start, x: snap(start.x + dx), y: snap(start.y + dy) };
  }
  let { x, y, width, height } = start;
  if (handle.includes("e")) {
    width = Math.max(min.width, snap(start.x + start.width + dx) - start.x);
  }
  if (handle.includes("w")) {
    x = Math.min(snap(start.x + dx), start.x + start.width - min.width);
    width = start.x + start.width - x;
  }
  if (handle.includes("s")) {
    height = Math.max(min.height, snap(start.y + start.height + dy) - start.y);
  }
  if (handle.includes("n")) {
    y = Math.min(snap(start.y + dy), start.y + start.height - min.height);
    height = start.y + start.height - y;
  }
  return { x, y, width, height };
}

/**
 * Frames for going to the canvas without anything moving: where each main-area stack is now,
 * measured from the main area's corner, pulled in a little so that neighbours do not touch.
 */
export function seedFrames(
  stacks: readonly { readonly id: NodeId; readonly edge: unknown; readonly rect: Rect }[],
  main: Rect,
  inset = 6,
): { [stack: NodeId]: Rect } {
  const frames: { [stack: NodeId]: Rect } = {};
  for (const stack of stacks) {
    if (stack.edge) {
      continue;
    }
    frames[stack.id] = {
      x: stack.rect.x - main.x + inset,
      y: stack.rect.y - main.y + inset,
      width: Math.max(canvasDefaults.minFrame.width, stack.rect.width - inset * 2),
      height: Math.max(canvasDefaults.minFrame.height, stack.rect.height - inset * 2),
    };
  }
  return frames;
}
