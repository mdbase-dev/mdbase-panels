import { normalize } from "./normalize.js";
import { emptyWorkspace } from "./tree.js";
import {
  edgeSides,
  type Camera,
  type CanvasFrame,
  type EdgeRegion,
  type LayoutNode,
  type PanelData,
  type PanelDescriptor,
  type StackNode,
  viewModes,
  type WorkspaceState,
} from "./types.js";

/** The documented, versioned snapshot format. */
export interface WorkspaceSnapshot {
  readonly format: "mdbase-panels";
  readonly version: 1;
  readonly workspace: WorkspaceState;
}

export function toSnapshot(state: WorkspaceState): WorkspaceSnapshot {
  return { format: "mdbase-panels", version: 1, workspace: state };
}

/** A workspace from untrusted JSON. Throws on anything that is not a workspace snapshot. */
export function fromSnapshot(value: unknown): WorkspaceState {
  if (!isRecord(value) || value["format"] !== "mdbase-panels" || value["version"] !== 1) {
    throw new Error("Not a workspace snapshot");
  }
  const input = value["workspace"];
  if (!isRecord(input) || input["version"] !== 1 || !isRecord(input["panels"])) {
    throw new Error("Invalid workspace");
  }
  const panels: Record<string, PanelDescriptor> = {};
  for (const [id, panel] of Object.entries(input["panels"])) {
    panels[id] = parsePanel(panel, id);
  }
  const edges: { [side in (typeof edgeSides)[number]]?: EdgeRegion } = {};
  if (isRecord(input["edges"])) {
    for (const side of edgeSides) {
      const edge = input["edges"][side];
      if (edge !== undefined) {
        edges[side] = parseEdge(edge);
      }
    }
  }
  const columns: Record<string, number> = {};
  if (isRecord(input["columns"])) {
    for (const [id, fraction] of Object.entries(input["columns"])) {
      if (typeof fraction === "number" && Number.isFinite(fraction)) {
        columns[id] = fraction;
      }
    }
  }
  const seq = input["seq"];
  return normalize({
    ...emptyWorkspace(),
    panels,
    root: input["root"] === null || input["root"] === undefined ? null : parseNode(input["root"], 0),
    edges,
    focus: typeof input["focus"] === "string" ? input["focus"] : null,
    maximized: typeof input["maximized"] === "string" ? input["maximized"] : null,
    view: viewModes.find((view) => view === input["view"]) ?? "tiling",
    columns,
    canvas: parseCanvas(input["canvas"]),
    leader: typeof input["leader"] === "string" ? input["leader"] : null,
    seq: typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : 1,
  });
}

function parsePanel(value: unknown, id: string): PanelDescriptor {
  if (!isRecord(value) || value["id"] !== id || typeof value["kind"] !== "string") {
    throw new Error("Invalid panel");
  }
  return {
    id,
    kind: value["kind"],
    ...(typeof value["app"] === "string" ? { app: value["app"] } : {}),
    ...(typeof value["title"] === "string" ? { title: value["title"] } : {}),
    ...(value["data"] === undefined ? {} : { data: parseData(value["data"], 0) }),
    ...(isSize(value["minWidth"]) ? { minWidth: value["minWidth"] } : {}),
    ...(isSize(value["minHeight"]) ? { minHeight: value["minHeight"] } : {}),
    ...(typeof value["leads"] === "boolean" ? { leads: value["leads"] } : {}),
    ...parseFollows(value["follows"]),
  };
}

function parseFollows(value: unknown): Pick<PanelDescriptor, "follows"> {
  if (value === "leader") {
    return { follows: "leader" };
  }
  return isRecord(value) && typeof value["pane"] === "string" ? { follows: { pane: value["pane"] } } : {};
}

function parseData(value: unknown, depth: number): PanelData {
  if (depth > 32) {
    throw new Error("Panel data is nested too deeply");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Invalid panel data");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => parseData(item, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, PanelData> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        result[key] = parseData(item, depth + 1);
      }
    }
    return result;
  }
  throw new Error("Invalid panel data");
}

function parseStack(value: unknown): StackNode {
  if (
    !isRecord(value) ||
    value["type"] !== "stack" ||
    typeof value["id"] !== "string" ||
    !Array.isArray(value["panels"]) ||
    !value["panels"].every((id): id is string => typeof id === "string")
  ) {
    throw new Error("Invalid stack");
  }
  return {
    type: "stack",
    id: value["id"],
    panels: value["panels"],
    active: typeof value["active"] === "string" ? value["active"] : null,
    ...(typeof value["lead"] === "string" ? { lead: value["lead"] } : {}),
  };
}

function parseNode(value: unknown, depth: number): LayoutNode {
  if (depth > 64) {
    throw new Error("Layout is nested too deeply");
  }
  if (isRecord(value) && value["type"] === "split") {
    if (
      typeof value["id"] !== "string" ||
      (value["direction"] !== "row" && value["direction"] !== "column") ||
      !Array.isArray(value["children"])
    ) {
      throw new Error("Invalid split");
    }
    const sizes = Array.isArray(value["sizes"])
      ? value["sizes"].map((size) => (typeof size === "number" ? size : 0))
      : [];
    return {
      type: "split",
      id: value["id"],
      direction: value["direction"],
      children: value["children"].map((child) => parseNode(child, depth + 1)),
      sizes,
    };
  }
  return parseStack(value);
}

function parseEdge(value: unknown): EdgeRegion {
  if (!isRecord(value) || typeof value["size"] !== "number") {
    throw new Error("Invalid edge region");
  }
  return {
    stack: parseStack(value["stack"]),
    size: value["size"],
    visible: value["visible"] !== false,
    ...(isSize(value["min"]) ? { min: value["min"] } : {}),
    ...(isSize(value["max"]) ? { max: value["max"] } : {}),
    ...(typeof value["priority"] === "number" && Number.isFinite(value["priority"])
      ? { priority: value["priority"] }
      : {}),
  };
}

/** Anything unreadable is dropped; normalization gives stacks without a frame a new one. */
function parseCanvas(value: unknown): { frames: { [stack: string]: CanvasFrame }; camera: Camera } {
  const number = (input: unknown, fallback: number): number =>
    typeof input === "number" && Number.isFinite(input) ? input : fallback;
  const frames: { [stack: string]: CanvasFrame } = {};
  const given = isRecord(value) ? value["frames"] : undefined;
  if (isRecord(given)) {
    for (const [id, frame] of Object.entries(given)) {
      if (
        isRecord(frame) &&
        ["x", "y", "width", "height"].every((key) => typeof frame[key] === "number")
      ) {
        frames[id] = {
          x: number(frame["x"], 0),
          y: number(frame["y"], 0),
          width: number(frame["width"], 0),
          height: number(frame["height"], 0),
          z: number(frame["z"], 0),
        };
      }
    }
  }
  const camera = isRecord(value) && isRecord(value["camera"]) ? value["camera"] : {};
  return {
    frames,
    camera: { x: number(camera["x"], 0), y: number(camera["y"], 0), zoom: number(camera["zoom"], 1) },
  };
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
