import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  boundsOf,
  cameraToFit,
  cameraToReveal,
  canvasDefaults,
  clampCamera,
  computeLayout,
  dragFrame,
  dropTargetAt,
  edgeOfStack,
  findStack,
  resizeSplitter,
  sameCamera,
  zoomCameraAt,
  type Camera,
  type DropTarget,
  type EdgeSide,
  type FrameHandle,
  type LayoutMode,
  type LayoutOptions,
  type NodeId,
  type PanelDescriptor,
  type PanelId,
  type PanelLayout,
  type Rect,
  type Size,
  type SplitterLayout,
  type StackLayout,
  type StackNode,
  type WorkspaceChange,
  type WorkspaceLayout,
  type WorkspaceState,
  type WorkspaceStore,
} from "../core/index.js";
import { defaultFlip, flip, prefersReducedMotion, type FlipOptions, type Visual } from "./flip.js";
import { Menu, type MenuItem, type MenuState } from "./Menu.js";

export interface PanelInfo {
  /** Whether the panel is on screen. Hidden panels stay mounted. */
  readonly visible: boolean;
  /** Whether it is the active panel of the focused stack. */
  readonly focused: boolean;
  readonly stack: NodeId;
  readonly edge: EdgeSide | null;
  readonly mode: LayoutMode;
}

export interface TabInfo {
  readonly active: boolean;
  /** Whether the tab's stack has focus. */
  readonly focused: boolean;
  readonly stack: NodeId;
  readonly edge: EdgeSide | null;
  readonly index: number;
  /** Ask the workspace to close this panel (through `onRequestClose`). */
  readonly close: () => void;
}

export interface StackInfo {
  readonly stack: StackNode;
  readonly edge: EdgeSide | null;
  readonly focused: boolean;
  readonly maximized: boolean;
  readonly mode: LayoutMode;
  readonly active: PanelDescriptor | null;
}

export interface WorkspaceLabels {
  readonly workspace: string;
  readonly tabs: string;
  readonly resize: string;
  readonly closeTab: string;
  readonly overview: string;
  readonly show: (title: string) => string;
  readonly columns: string;
  /** The canvas view: its zoom controls, and the handle that moves a pane. */
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly zoomReset: string;
  readonly zoomFit: string;
  readonly movePane: string;
}

const defaultLabels: WorkspaceLabels = {
  workspace: "Workspace",
  tabs: "Open panels",
  resize: "Resize",
  closeTab: "Close",
  overview: "All open panels",
  show: (title) => `Show ${title}`,
  columns: "Scroll between columns",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Actual size",
  zoomFit: "Show every pane",
  movePane: "Move pane (arrow keys move it, Shift and arrow keys resize it)",
};

export interface WorkspaceProps {
  readonly store: WorkspaceStore;
  readonly layout?: LayoutOptions;
  readonly renderPanel: (panel: PanelDescriptor, info: PanelInfo) => ReactNode;
  /** The contents of a tab. Defaults to the panel's title and a close button. */
  readonly renderTab?: (panel: PanelDescriptor, info: TabInfo) => ReactNode;
  /** Controls at the end of a stack's tab strip. */
  readonly renderStackActions?: (info: StackInfo) => ReactNode;
  /** Shown in the main area when nothing is open there. */
  readonly renderEmpty?: () => ReactNode;
  readonly tabMenu?: (panel: PanelDescriptor, info: TabInfo) => readonly MenuItem[];
  /** A tab's accessible name and tooltip. Defaults to its title. */
  readonly tabTitle?: (panel: PanelDescriptor) => string;
  /**
   * Called when the user asks to close panels (Delete, middle click, the default close button).
   * Defaults to removing them; an app with unsaved work confirms first.
   */
  readonly onRequestClose?: (panels: readonly PanelId[]) => void;
  /** Whether the user may close this panel from its tab. Defaults to yes. */
  readonly canClose?: (panel: PanelDescriptor) => boolean;
  /** Show every panel at once, scaled down. */
  readonly overview?: boolean;
  readonly onOverviewChange?: (open: boolean) => void;
  readonly onLayout?: (layout: WorkspaceLayout) => void;
  /** Text for screen readers when something changes. */
  readonly announce?: (change: WorkspaceChange) => string | undefined;
  /** Animation settings, or false to turn animation off. */
  readonly motion?: Partial<FlipOptions> | false;
  readonly labels?: Partial<WorkspaceLabels>;
  readonly className?: string;
}

interface DragState {
  readonly panel: PanelId;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly target: DropTarget | null;
}

const quietResize = new Set(["resize", "setColumnWidth", "setFrame", "setCamera"]);
const frameHandles = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

function rectStyle(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** One workspace: tab strips, splitters and every panel, kept mounted wherever it moves. */
export function Workspace(props: WorkspaceProps): JSX.Element {
  const { store } = props;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const labels = useMemo(() => ({ ...defaultLabels, ...props.labels }), [props.labels]);
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const overview = props.overview ?? false;

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) {
      return;
    }
    const measure = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize((current) =>
        current?.width === next.width && current.height === next.height ? current : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  const layoutOptions = props.layout;
  const layout = useMemo(
    () => (size ? computeLayout(state, size, { ...layoutOptions, overview }) : null),
    [state, size, layoutOptions, overview],
  );

  // Panels keep one DOM position for life: reordering keyed children would move (and so
  // reload) their content, so new panels are only ever appended.
  const order = useRef<PanelId[]>([]);
  const ordinals = useRef(new Map<PanelId, number>());
  const nextOrdinal = useRef(0);
  order.current = [
    ...order.current.filter((id) => Object.hasOwn(state.panels, id)),
    ...Object.keys(state.panels).filter((id) => !order.current.includes(id)),
  ];
  for (const id of order.current) {
    if (!ordinals.current.has(id)) {
      ordinals.current.set(id, (nextOrdinal.current += 1));
    }
  }
  const tabId = (panel: PanelId): string => `${uid}-tab-${String(ordinals.current.get(panel) ?? 0)}`;
  const panelDomId = (panel: PanelId): string =>
    `${uid}-panel-${String(ordinals.current.get(panel) ?? 0)}`;

  const elements = useRef(new Map<string, HTMLElement>());
  const register = useCallback(
    (key: string) =>
      (element: HTMLElement | null): void => {
        if (element) {
          elements.current.set(key, element);
        } else {
          elements.current.delete(key);
        }
      },
    [],
  );
  const registrars = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const registrar = (key: string): ((element: HTMLElement | null) => void) => {
    let known = registrars.current.get(key);
    if (!known) {
      known = register(key);
      registrars.current.set(key, known);
    }
    return known;
  };

  const animate = useRef(false);
  const reveal = useRef(true);
  /** When the pointer last went down on something that lives on the canvas. */
  const canvasPress = useRef(-1e9);
  const focusTab = useRef<PanelId | null>(null);
  const announce = props.announce;
  useLayoutEffect(
    () =>
      store.subscribe((change) => {
        animate.current = change.animate;
        // Something picked with the pointer on the canvas is already in view where the user
        // wants it; only changes made some other way bring their pane into view.
        const picked = performance.now() - canvasPress.current < 400;
        if (!quietResize.has(change.operation.type) && !picked) {
          reveal.current = true;
        }
        const text = announce?.(change);
        if (text) {
          setAnnouncement(text);
        }
      }),
    [store, announce],
  );
  // An announcement is read when it changes; left in place it is stale text a screen reader can
  // still walk into, so it is cleared once it has had time to be read.
  useEffect(() => {
    if (!announcement) {
      return undefined;
    }
    const timer = setTimeout(() => setAnnouncement(""), 5000);
    return () => clearTimeout(timer);
  }, [announcement]);
  const lastOverview = useRef(overview);
  if (lastOverview.current !== overview) {
    lastOverview.current = overview;
    animate.current = true;
    reveal.current = true;
  }

  // The canvas camera. `live` is what is drawn; it runs ahead of the state while the user pans
  // or zooms, and is written back when the gesture settles. `goal` is where it is heading.
  const live = useRef<Camera>(state.canvas.camera);
  const goal = useRef<Camera>(state.canvas.camera);
  const synced = useRef<Camera>(state.canvas.camera);
  const cameraFrame = useRef(0);
  const cameraTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const motion = props.motion;
  const paint = useCallback((): void => {
    const element = content.current;
    const main = layoutRef.current?.main;
    if (!element || !main) {
      return;
    }
    const { x, y, zoom } = live.current;
    let grid = 24 * zoom;
    while (grid < 14) {
      grid *= 2;
    }
    element.style.setProperty("--mp-zoom", String(zoom));
    element.style.setProperty("--mp-cam-x", `${String(main.x - x * zoom)}px`);
    element.style.setProperty("--mp-cam-y", `${String(main.y - y * zoom)}px`);
    element.style.setProperty("--mp-pan-x", `${String(-x * zoom)}px`);
    element.style.setProperty("--mp-pan-y", `${String(-y * zoom)}px`);
    element.style.setProperty("--mp-grid", `${String(grid)}px`);
    if (zoomLabel.current) {
      zoomLabel.current.textContent = `${String(Math.round(zoom * 100))}%`;
    }
  }, []);
  const commitCamera = useCallback((): void => {
    clearTimeout(cameraTimer.current);
    cameraTimer.current = undefined;
    store.dispatch({ type: "setCamera", camera: goal.current }, { history: "skip", animate: false });
  }, [store]);
  /** Point the camera somewhere, gliding there unless told to jump. */
  const lookAt = useCallback(
    (camera: Camera, options: { glide?: boolean; commit?: "now" | "soon" | "no" } = {}): void => {
      const target = clampCamera(camera);
      cancelAnimationFrame(cameraFrame.current);
      goal.current = target;
      const from = live.current;
      const glide = (options.glide ?? true) && motion !== false && !prefersReducedMotion();
      if (!glide || sameCamera(from, target)) {
        live.current = target;
        paint();
      } else {
        const started = performance.now();
        const duration = (motion ? motion.duration : undefined) ?? defaultFlip.duration;
        const step = (now: number): void => {
          const t = Math.min(1, (now - started) / duration);
          const eased = 1 - (1 - t) ** 3;
          // Zoom is interpolated by ratio, so the pace looks even at every scale.
          const zoom = from.zoom * (target.zoom / from.zoom) ** eased;
          live.current =
            t >= 1
              ? target
              : { x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased, zoom };
          paint();
          if (t < 1) {
            cameraFrame.current = requestAnimationFrame(step);
          }
        };
        cameraFrame.current = requestAnimationFrame(step);
      }
      const commit = options.commit ?? "now";
      if (commit === "now") {
        commitCamera();
      } else if (commit === "soon") {
        clearTimeout(cameraTimer.current);
        cameraTimer.current = setTimeout(commitCamera, 160);
      }
    },
    [commitCamera, motion, paint],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(cameraFrame.current);
      if (cameraTimer.current !== undefined) {
        commitCamera();
      }
    },
    [commitCamera],
  );

  const visuals = useRef(new Map<string, Visual & { pinned: boolean; plane: boolean }>());
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!layout || !view) {
      return;
    }
    // A camera set from outside (a command, a loaded workspace) is followed; one this view
    // wrote itself is already where `goal` points.
    if (state.canvas.camera !== synced.current) {
      synced.current = state.canvas.camera;
      if (!sameCamera(state.canvas.camera, goal.current)) {
        lookAt(state.canvas.camera, { glide: layout.mode === "canvas", commit: "no" });
      }
    }
    if (layout.mode === "canvas" && reveal.current) {
      const focused = layout.stacks.find(({ focused: has, pinned }) => has && !pinned);
      const shown = focused ? cameraToReveal(goal.current, focused.rect, layout.main) : goal.current;
      if (shown !== goal.current) {
        lookAt(shown, { commit: "soon" });
      }
    }
    paint();
    const before = view.scrollLeft;
    if (layout.mode === "columns" && reveal.current) {
      const focused = layout.stacks.find(({ focused: has, pinned }) => has && !pinned);
      if (focused) {
        const left = focused.rect.x - layout.main.x;
        const right = focused.rect.x + focused.rect.width - layout.main.x - layout.main.width;
        if (before > left) {
          view.scrollLeft = left;
        } else if (before < right) {
          view.scrollLeft = right;
        }
      }
    }
    reveal.current = false;
    const after = view.scrollLeft;
    // Boxes on the canvas are recorded in plane pixels, so panning never makes them stale.
    const canvas = layout.mode === "canvas";
    const next = new Map<string, Visual & { pinned: boolean; plane: boolean }>();
    for (const stack of layout.stacks) {
      next.set(`s:${stack.id}`, {
        ...stack.rect,
        scale: 1,
        visible: true,
        pinned: stack.pinned,
        plane: canvas && !stack.pinned,
      });
    }
    for (const panel of layout.panels) {
      next.set(`p:${panel.id}`, {
        ...panel.rect,
        scale: panel.scale,
        visible: panel.visible,
        pinned: panel.pinned,
        plane: canvas && !panel.pinned,
      });
    }
    if (animate.current && motion !== false && !prefersReducedMotion()) {
      const options = { ...defaultFlip, ...motion };
      const { x: camX, y: camY, zoom } = live.current;
      const originX = layout.main.x - camX * zoom;
      const originY = layout.main.y - camY * zoom;
      for (const [key, to] of next) {
        const element = elements.current.get(key);
        const was = visuals.current.get(key);
        if (!element) {
          continue;
        }
        // The animation plays in the element's own space, so where it was is restated there:
        // through the camera when it is moving onto or off the canvas.
        let from: Visual | undefined = was && { ...was, x: was.pinned || was.plane ? was.x : was.x - before };
        if (from && was && was.plane !== to.plane) {
          from = to.plane
            ? {
                ...from,
                x: (from.x - originX) / zoom,
                y: (from.y - originY) / zoom,
                scale: from.scale / zoom,
              }
            : {
                ...from,
                x: from.x * zoom + originX,
                y: from.y * zoom + originY,
                scale: from.scale * zoom,
              };
        }
        flip(element, from, { ...to, x: to.pinned || to.plane ? to.x : to.x - after }, options);
      }
    }
    animate.current = false;
    visuals.current = next;
    if (focusTab.current) {
      const id = focusTab.current;
      focusTab.current = null;
      document.getElementById(tabId(id))?.focus();
    }
  });

  const onLayout = props.onLayout;
  useEffect(() => {
    if (layout) {
      onLayout?.(layout);
    }
  }, [layout, onLayout]);

  const requestClose = props.onRequestClose;
  const close = useCallback(
    (panels: readonly PanelId[]): void => {
      if (requestClose) {
        requestClose(panels);
      } else {
        store.dispatch({
          type: "batch",
          operations: panels.map((panel) => ({ type: "remove" as const, panel })),
        });
      }
    },
    [requestClose, store],
  );

  // Focus follows the pointer and the keyboard into a panel, including into an iframe, whose
  // own events never reach this document.
  useEffect(() => {
    const view = root.current;
    if (!view) {
      return;
    }
    const focusFrom = (target: EventTarget | null): void => {
      const holder =
        target instanceof Element ? target.closest<HTMLElement>("[data-mp-stack-of]") : null;
      const stack = holder?.dataset["mpStackOf"];
      if (stack && store.state.focus !== stack && findStack(store.state, stack)) {
        store.dispatch({ type: "focus", stack }, { animate: false });
      }
    };
    const pointer = (event: PointerEvent): void => {
      if (
        layoutRef.current?.mode === "canvas" &&
        event.target instanceof Element &&
        event.target.closest(".mp-pin:not([data-mp-pinned])")
      ) {
        canvasPress.current = performance.now();
      }
      focusFrom(event.target);
    };
    const focusIn = (event: FocusEvent): void => focusFrom(event.target);
    const blur = (): void => {
      // Focus moving into an iframe shows up here as the window losing focus.
      queueMicrotask(() => focusFrom(document.activeElement));
    };
    view.addEventListener("pointerdown", pointer, true);
    view.addEventListener("focusin", focusIn);
    globalThis.addEventListener("blur", blur);
    return () => {
      view.removeEventListener("pointerdown", pointer, true);
      view.removeEventListener("focusin", focusIn);
      globalThis.removeEventListener("blur", blur);
    };
  }, [store]);

  const tabTitle = props.tabTitle;
  const titleOf = useCallback(
    (panel: PanelDescriptor): string => tabTitle?.(panel) ?? panel.title ?? panel.kind,
    [tabTitle],
  );

  const beginDrag = useTabDrag({ store, root, scroller, layoutRef, setDrag, titleOf, camera: live });

  // Wheel pans the canvas and Ctrl or Cmd with the wheel (a pinch on a trackpad) zooms about
  // the pointer. The focused pane keeps its own scrolling: a wheel over its content is left
  // alone, and over an embedded frame it never arrives here at all.
  useEffect(() => {
    const view = root.current;
    if (!view) {
      return;
    }
    const wheel = (event: WheelEvent): void => {
      const current = layoutRef.current;
      const target = event.target;
      if (current?.mode !== "canvas" || !(target instanceof Element)) {
        return;
      }
      const zooming = event.ctrlKey || event.metaKey;
      if (event.defaultPrevented || target.closest(".mp-menu, .mp-zoom")) {
        return;
      }
      // Zooming works everywhere on the canvas (a pinch must never zoom the whole page);
      // plain scrolling belongs to whatever panel the pointer is over.
      if (target.closest("[data-mp-edge]") || (!zooming && target.closest(".mp-panel"))) {
        return;
      }
      const bounds = view.getBoundingClientRect();
      const point = {
        x: event.clientX - bounds.left - current.main.x,
        y: event.clientY - bounds.top - current.main.y,
      };
      if (point.x < 0 || point.y < 0 || point.x > current.main.width || point.y > current.main.height) {
        return;
      }
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? current.main.height : 1;
      const camera = goal.current;
      if (zooming) {
        const factor = Math.exp(-event.deltaY * unit * 0.01);
        lookAt(zoomCameraAt(camera, point, camera.zoom * factor), { glide: false, commit: "soon" });
      } else {
        lookAt(
          {
            ...camera,
            x: camera.x + (event.deltaX * unit) / camera.zoom,
            y: camera.y + (event.deltaY * unit) / camera.zoom,
          },
          { glide: false, commit: "soon" },
        );
      }
    };
    view.addEventListener("wheel", wheel, { passive: false });
    return () => view.removeEventListener("wheel", wheel);
  }, [lookAt]);

  /** Drag open ground (or a covered pane) to pan. A press that does not move is a click. */
  const beginPan = useCallback(
    (event: ReactPointerEvent, click?: () => void): void => {
      if (event.button !== 0 && event.button !== 1) {
        return;
      }
      event.preventDefault();
      const pointerId = event.pointerId;
      const origin = { x: event.clientX, y: event.clientY };
      const start = goal.current;
      const button = event.button;
      let panning = false;
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== pointerId) {
          return;
        }
        const dx = next.clientX - origin.x;
        const dy = next.clientY - origin.y;
        if (!panning && Math.hypot(dx, dy) < 4) {
          return;
        }
        if (!panning) {
          panning = true;
          root.current?.setAttribute("data-mp-panning", "");
        }
        lookAt({ ...start, x: start.x - dx / start.zoom, y: start.y - dy / start.zoom }, { glide: false, commit: "no" });
      };
      const finish = (next: PointerEvent): void => {
        if (next.pointerId !== pointerId) {
          return;
        }
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        root.current?.removeAttribute("data-mp-panning");
        if (panning) {
          commitCamera();
        } else if (next.type === "pointerup" && button === 0) {
          click?.();
        }
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    },
    [commitCamera, lookAt],
  );

  /** Move a pane on the canvas, or resize it from one of its sides or corners. */
  const beginFrame = useCallback(
    (event: ReactPointerEvent, stack: StackLayout, handle: FrameHandle): void => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      canvasPress.current = performance.now();
      store.dispatch({ type: "focus", stack: stack.id }, { animate: false });
      const pointerId = event.pointerId;
      const origin = { x: event.clientX, y: event.clientY };
      const start = stack.rect;
      root.current?.setAttribute("data-mp-resizing", handle === "move" ? "move" : `frame-${handle}`);
      const move = (next: PointerEvent): void => {
        if (next.pointerId !== pointerId) {
          return;
        }
        const zoom = live.current.zoom;
        const frame = dragFrame(start, handle, (next.clientX - origin.x) / zoom, (next.clientY - origin.y) / zoom);
        store.dispatch({ type: "setFrame", stack: stack.id, frame }, { history: "merge", animate: false });
      };
      const finish = (next: PointerEvent): void => {
        if (next.pointerId !== pointerId) {
          return;
        }
        document.removeEventListener("pointermove", move, true);
        document.removeEventListener("pointerup", finish, true);
        document.removeEventListener("pointercancel", finish, true);
        store.endMerge();
        root.current?.removeAttribute("data-mp-resizing");
      };
      document.addEventListener("pointermove", move, true);
      document.addEventListener("pointerup", finish, true);
      document.addEventListener("pointercancel", finish, true);
    },
    [store],
  );

  const zoomBy = (factor: number): void => {
    const main = layoutRef.current?.main;
    if (main) {
      const camera = goal.current;
      // Steps land on round percentages.
      const zoom = Math.round(camera.zoom * factor * 20) / 20;
      lookAt(zoomCameraAt(camera, { x: main.width / 2, y: main.height / 2 }, zoom));
    }
  };
  const zoomReset = (): void => {
    const main = layoutRef.current?.main;
    if (main) {
      lookAt(zoomCameraAt(goal.current, { x: main.width / 2, y: main.height / 2 }, 1));
    }
  };
  const zoomFit = (): void => {
    const current = layoutRef.current;
    const bounds = current ? boundsOf(current.stacks.filter(({ pinned }) => !pinned).map(({ rect }) => rect)) : null;
    if (current && bounds) {
      lookAt(cameraToFit(bounds, current.main));
    }
  };
  const zoomTo = (stack: StackLayout): void => {
    const current = layoutRef.current;
    if (current) {
      lookAt(cameraToFit(stack.rect, current.main, 24));
    }
  };

  const overviewChange = props.onOverviewChange;
  useEffect(() => {
    if (!overview) {
      return;
    }
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        overviewChange?.(false);
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [overview, overviewChange]);

  const mode = layout?.mode ?? "tiling";
  const stackLayouts = new Map(layout?.stacks.map((stack) => [stack.id, stack]));
  const panelLayouts = new Map(layout?.panels.map((panel) => [panel.id, panel]));
  const tabbed = new Set(
    (layout?.stacks ?? []).flatMap(({ id }) => findStack(state, id)?.panels ?? []),
  );
  const empty = layout && mode !== "overview" && !layout.stacks.some(({ edge }) => !edge) && !state.root;

  return (
    <div
      ref={root}
      className={`mp-workspace${props.className ? ` ${props.className}` : ""}`}
      data-mp-mode={mode}
      data-mp-view={state.view}
      data-mp-dragging={drag ? "" : undefined}
      role="group"
      aria-label={labels.workspace}
    >
      <div ref={scroller} className="mp-scroller" data-mp-scrolls={mode === "columns" || undefined}>
        <div
          ref={content}
          className="mp-content"
          style={{ width: layout ? Math.max(layout.contentWidth, layout.size.width) : "100%" }}
        >
          {layout && mode === "canvas" ? (
            <Pin pinned layer={0}>
              <div
                className="mp-canvas"
                style={rectStyle(layout.main)}
                onPointerDown={(event) => beginPan(event)}
              />
            </Pin>
          ) : null}
          {layout?.stacks.map((stack) => (
            <Pin key={stack.id} pinned={stack.pinned} layer={stack.pinned ? undefined : stack.layer}>
              <StackFrame
                elementRef={registrar(`s:${stack.id}`)}
                layout={stack}
                state={state}
                mode={mode}
                labels={labels}
                tabId={tabId}
                panelDomId={panelDomId}
                titleOf={titleOf}
                renderTab={props.renderTab}
                renderStackActions={props.renderStackActions}
                tabMenu={props.tabMenu}
                canClose={props.canClose}
                close={close}
                store={store}
                beginDrag={beginDrag}
                beginFrame={beginFrame}
                zoomTo={zoomTo}
                dragging={drag?.panel ?? null}
                setMenu={setMenu}
                focusTab={focusTab}
              />
            </Pin>
          ))}
          {layout
            ? order.current.map((id) => {
                const panel = state.panels[id];
                const placed = panelLayouts.get(id);
                if (!panel || !placed) {
                  return null;
                }
                const stack = stackLayouts.get(placed.stack);
                return (
                  <Pin key={id} pinned={placed.pinned} layer={placed.pinned ? undefined : placed.layer}>
                    <PanelHost
                      elementRef={registrar(`p:${id}`)}
                      panel={panel}
                      layout={placed}
                      mode={mode}
                      focused={placed.visible && state.focus === placed.stack}
                      edge={stack?.edge ?? edgeOfStack(state, placed.stack)}
                      domId={panelDomId(id)}
                      labelledBy={tabbed.has(id) ? tabId(id) : undefined}
                      label={titleOf(panel)}
                      renderPanel={props.renderPanel}
                    />
                  </Pin>
                );
              })
            : null}
          {layout?.splitters.map((splitter) => (
            <Pin key={splitter.id} pinned={splitter.pinned}>
              <Splitter splitter={splitter} store={store} root={root} label={labels.resize} />
            </Pin>
          ))}
          {mode === "canvas"
            ? layout?.stacks
                .filter(({ pinned }) => !pinned)
                .map((stack) => (
                  <Pin key={`frame:${stack.id}`} pinned={false} layer={stack.layer}>
                    {stack.focused ? null : (
                      // A pane that is not in use is covered: a click picks it, a drag or the
                      // wheel moves the canvas, and nothing inside it can swallow either.
                      <div
                        className="mp-cover"
                        style={rectStyle(stack.body)}
                        onPointerDown={(event) =>
                          beginPan(event, () => {
                            canvasPress.current = performance.now();
                            store.dispatch({ type: "focus", stack: stack.id }, { animate: false });
                          })
                        }
                        onDoubleClick={() => zoomTo(stack)}
                      />
                    )}
                    <div className="mp-frame-handles" style={rectStyle(stack.rect)} aria-hidden="true">
                      {frameHandles.map((handle) => (
                        <div
                          key={handle}
                          className="mp-handle"
                          data-mp-handle={handle}
                          onPointerDown={(event) => beginFrame(event, stack, handle)}
                        />
                      ))}
                    </div>
                  </Pin>
                ))
            : null}
          {empty && layout ? (
            <Pin pinned>
              <div className="mp-empty" style={rectStyle(layout.main)}>
                {props.renderEmpty?.()}
              </div>
            </Pin>
          ) : null}
          {mode === "overview" && layout ? (
            <Pin pinned>
              <div className="mp-overview" role="list" aria-label={labels.overview}>
                {layout.cards.map((card) => {
                  const panel = state.panels[card.panel];
                  if (!panel) {
                    return null;
                  }
                  const title = titleOf(panel);
                  return (
                    <div key={card.panel} role="listitem" className="mp-card" style={rectStyle(card.rect)}>
                      <button
                        type="button"
                        className="mp-card-target"
                        aria-label={labels.show(title)}
                        onClick={() => {
                          store.dispatch({ type: "activate", panel: card.panel });
                          props.onOverviewChange?.(false);
                        }}
                      >
                        <span className="mp-card-label" style={{ height: card.label.height }}>
                          {title}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </Pin>
          ) : null}
          {drag?.target ? (
            <Pin pinned={drag.target.pinned} layer={mode === "canvas" && !drag.target.pinned ? 9000 : undefined}>
              <div className="mp-drop" style={rectStyle(drag.target.indicator)} />
            </Pin>
          ) : null}
        </div>
      </div>
      {layout && mode === "columns" && layout.contentWidth > layout.size.width + 1 ? (
        <ColumnsBar layout={layout} scroller={scroller} label={labels.columns} />
      ) : null}
      {layout && mode === "canvas" ? (
        <div className="mp-zoom" style={{ right: layout.size.width - layout.main.x - layout.main.width + 10 }}>
          <button type="button" aria-label={labels.zoomOut} title={labels.zoomOut} onClick={() => zoomBy(1 / 1.25)}>
            −
          </button>
          <button type="button" aria-label={labels.zoomReset} title={labels.zoomReset} onClick={zoomReset}>
            <span ref={zoomLabel}>{`${String(Math.round(state.canvas.camera.zoom * 100))}%`}</span>
          </button>
          <button type="button" aria-label={labels.zoomIn} title={labels.zoomIn} onClick={() => zoomBy(1.25)}>
            +
          </button>
          <button type="button" aria-label={labels.zoomFit} title={labels.zoomFit} onClick={zoomFit}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      ) : null}
      {/* Shown while dragging or resizing, so that no embedded frame swallows the pointer. */}
      <div className="mp-shield" />
      {drag ? (
        <div className="mp-ghost" style={{ left: drag.x, top: drag.y }}>
          {drag.title}
        </div>
      ) : null}
      {menu ? <Menu menu={menu} onClose={() => setMenu(null)} /> : null}
      <div className="mp-live" aria-live="polite" role="status">
        {announcement}
      </div>
    </div>
  );
}

/**
 * A zero-size anchor. Pinned anchors stick to the viewport while the main area scrolls beneath
 * them; switching between the two is a style change, so the content inside is never moved.
 */
function Pin({
  pinned,
  layer,
  children,
}: {
  readonly pinned: boolean;
  /** Drawing order among anchors, for the canvas, where panes overlap. */
  readonly layer?: number | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="mp-pin"
      data-mp-pinned={pinned || undefined}
      style={layer === undefined || (layer === 0 && !pinned) ? undefined : { zIndex: layer }}
    >
      {children}
    </div>
  );
}

interface PanelHostProps {
  readonly elementRef: (element: HTMLElement | null) => void;
  readonly panel: PanelDescriptor;
  readonly layout: PanelLayout;
  readonly mode: LayoutMode;
  readonly focused: boolean;
  readonly edge: EdgeSide | null;
  readonly domId: string;
  readonly labelledBy: string | undefined;
  readonly label: string;
  readonly renderPanel: WorkspaceProps["renderPanel"];
}

const PanelHost = memo(function PanelHost(props: PanelHostProps): JSX.Element {
  const { layout, panel, mode } = props;
  const interactive = layout.visible && mode !== "overview";
  return (
    <div
      ref={props.elementRef}
      id={props.domId}
      className="mp-panel"
      role={mode === "overview" ? undefined : "tabpanel"}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.label}
      data-mp-panel={panel.id}
      data-mp-kind={panel.kind}
      data-mp-stack-of={layout.stack}
      data-mp-visible={layout.visible || undefined}
      data-mp-focused={props.focused || undefined}
      data-mp-edge={props.edge ?? undefined}
      inert={!interactive}
      style={{
        ...rectStyle(layout.rect),
        transform: layout.scale === 1 ? undefined : `scale(${String(layout.scale)})`,
      }}
    >
      <PanelContent
        panel={panel}
        visible={layout.visible}
        focused={props.focused}
        stack={layout.stack}
        edge={props.edge}
        mode={mode}
        renderPanel={props.renderPanel}
      />
    </div>
  );
});

/** Content re-renders only when what it is told changes, not when its box moves. */
const PanelContent = memo(function PanelContent({
  panel,
  renderPanel,
  ...info
}: PanelInfo & {
  readonly panel: PanelDescriptor;
  readonly renderPanel: WorkspaceProps["renderPanel"];
}): ReactNode {
  return renderPanel(panel, info);
});

interface StackFrameProps {
  readonly elementRef: (element: HTMLElement | null) => void;
  readonly layout: StackLayout;
  readonly state: WorkspaceState;
  readonly mode: LayoutMode;
  readonly labels: WorkspaceLabels;
  readonly tabId: (panel: PanelId) => string;
  readonly panelDomId: (panel: PanelId) => string;
  readonly titleOf: (panel: PanelDescriptor) => string;
  readonly renderTab: WorkspaceProps["renderTab"];
  readonly renderStackActions: WorkspaceProps["renderStackActions"];
  readonly tabMenu: WorkspaceProps["tabMenu"];
  readonly canClose: WorkspaceProps["canClose"];
  readonly close: (panels: readonly PanelId[]) => void;
  readonly store: WorkspaceStore;
  readonly beginDrag: (event: ReactPointerEvent, panel: PanelDescriptor) => void;
  readonly beginFrame: (event: ReactPointerEvent, stack: StackLayout, handle: FrameHandle) => void;
  readonly zoomTo: (stack: StackLayout) => void;
  readonly dragging: PanelId | null;
  readonly setMenu: (menu: MenuState | null) => void;
  readonly focusTab: { current: PanelId | null };
}

function StackFrame(props: StackFrameProps): JSX.Element | null {
  const { layout, state, store } = props;
  const stack = findStack(state, layout.id);
  const strip = useRef<HTMLDivElement>(null);
  const active = stack?.active ?? null;
  useEffect(() => {
    // Keep the active tab in view when the strip overflows.
    const tab = active ? document.getElementById(props.tabId(active)) : null;
    const view = strip.current;
    if (!tab || !view) {
      return;
    }
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < view.scrollLeft) {
      view.scrollLeft = left;
    } else if (right > view.scrollLeft + view.clientWidth) {
      view.scrollLeft = right - view.clientWidth;
    }
  }, [active, props, layout.rect.width]);
  if (!stack) {
    return null;
  }
  const info = (panel: PanelDescriptor, index: number): TabInfo => ({
    active: stack.active === panel.id,
    focused: layout.focused,
    stack: stack.id,
    edge: layout.edge,
    index,
    close: () => props.close([panel.id]),
  });
  const closable = (panel: PanelDescriptor): boolean => props.canClose?.(panel) ?? true;
  const openMenu = (panel: PanelDescriptor, index: number, x: number, y: number, origin: HTMLElement): void => {
    const items = props.tabMenu?.(panel, info(panel, index));
    if (items?.length) {
      props.setMenu({ items, x, y, origin });
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, panel: PanelDescriptor, index: number): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const go = (to: number): void => {
      const id = stack.panels[(to + stack.panels.length) % stack.panels.length];
      if (id) {
        event.preventDefault();
        props.focusTab.current = id;
        store.dispatch({ type: "activate", panel: id });
        document.getElementById(props.tabId(id))?.focus();
      }
    };
    const reorder = (to: number): void => {
      if (to < 0 || to >= stack.panels.length) {
        return;
      }
      event.preventDefault();
      props.focusTab.current = panel.id;
      store.dispatch({
        type: "move",
        panel: panel.id,
        target: layout.edge
          ? { at: "edge", side: layout.edge, index: to }
          : { at: "stack", stack: stack.id, index: to },
      });
    };
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const step = event.key === "ArrowRight" ? 1 : -1;
      if (mod && event.shiftKey) {
        reorder(index + step);
      } else if (!mod && !event.altKey) {
        go(index + step);
      }
    } else if (event.key === "Home") {
      go(0);
    } else if (event.key === "End") {
      go(stack.panels.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      store.dispatch({ type: "activate", panel: panel.id });
    } else if ((event.key === "Delete" || event.key === "Backspace") && closable(panel)) {
      event.preventDefault();
      event.stopPropagation();
      props.focusTab.current = stack.panels[index + 1] ?? stack.panels[index - 1] ?? null;
      props.close([panel.id]);
    } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openMenu(panel, index, bounds.left, bounds.bottom, event.currentTarget);
    }
  };
  const activePanel = stack.active ? (state.panels[stack.active] ?? null) : null;
  const floating = props.mode === "canvas" && !layout.pinned;
  const nudge = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = canvasDefaults.grid * 4;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    if (dx || dy) {
      event.preventDefault();
      store.dispatch({
        type: "setFrame",
        stack: stack.id,
        frame: dragFrame(layout.rect, event.shiftKey ? "se" : "move", dx, dy),
      });
    }
  };
  return (
    <div
      ref={props.elementRef}
      className="mp-stack"
      data-mp-stack={stack.id}
      data-mp-stack-of={stack.id}
      data-mp-edge={layout.edge ?? undefined}
      data-mp-focused={layout.focused || undefined}
      data-mp-maximized={state.maximized === stack.id || undefined}
      style={rectStyle(layout.rect)}
    >
      <div
        className="mp-header"
        style={{ height: layout.header.height }}
        hidden={layout.header.height === 0}
        onPointerDown={(event) => {
          // On the canvas the bare part of a tab strip is the pane's handle.
          const target = event.target as Element;
          if (floating && (target === event.currentTarget || target === strip.current)) {
            props.beginFrame(event, layout, "move");
          }
        }}
        onDoubleClick={(event) => {
          const target = event.target as Element;
          if (floating && (target === event.currentTarget || target === strip.current)) {
            props.zoomTo(layout);
          }
        }}
      >
        {floating ? (
          <div
            className="mp-grip"
            role="button"
            tabIndex={0}
            aria-label={props.labels.movePane}
            title={props.labels.movePane}
            onPointerDown={(event) => props.beginFrame(event, layout, "move")}
            onKeyDown={nudge}
          />
        ) : null}
        <div
          ref={strip}
          className="mp-tabs"
          role="tablist"
          aria-label={props.labels.tabs}
          onWheel={(event) => {
            if (floating) {
              return;
            }
            if (event.deltaY && !event.deltaX) {
              event.currentTarget.scrollLeft += event.deltaY;
            }
          }}
        >
          {stack.panels.map((id, index) => {
            const panel = state.panels[id];
            if (!panel) {
              return null;
            }
            const selected = stack.active === id;
            const title = props.titleOf(panel);
            return (
              <div
                key={id}
                id={props.tabId(id)}
                className="mp-tab"
                role="tab"
                aria-selected={selected}
                aria-controls={props.panelDomId(id)}
                tabIndex={selected ? 0 : -1}
                title={title}
                data-mp-tab={id}
                data-mp-active={selected || undefined}
                data-mp-dragged={props.dragging === id || undefined}
                onPointerDown={(event) => {
                  if (event.button === 0) {
                    store.dispatch({ type: "activate", panel: id });
                    props.beginDrag(event, panel);
                  }
                }}
                onAuxClick={(event) => {
                  if (event.button === 1 && closable(panel)) {
                    event.preventDefault();
                    props.close([id]);
                  }
                }}
                onContextMenu={(event) => {
                  if (props.tabMenu) {
                    event.preventDefault();
                    openMenu(panel, index, event.clientX, event.clientY, event.currentTarget);
                  }
                }}
                onKeyDown={(event) => keyDown(event, panel, index)}
              >
                {props.renderTab ? (
                  props.renderTab(panel, info(panel, index))
                ) : (
                  <>
                    <span className="mp-tab-label">{title}</span>
                    {closable(panel) ? (
                      <span
                        className="mp-tab-close"
                        aria-hidden="true"
                        title={props.labels.closeTab}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          props.close([id]);
                        }}
                      >
                        ×
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </div>
        {props.renderStackActions ? (
          <div className="mp-actions">
            {props.renderStackActions({
              stack,
              edge: layout.edge,
              focused: layout.focused,
              maximized: state.maximized === stack.id,
              mode: props.mode,
              active: activePanel,
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Splitter({
  splitter,
  store,
  root,
  label,
}: {
  readonly splitter: SplitterLayout;
  readonly store: WorkspaceStore;
  readonly root: { readonly current: HTMLElement | null };
  readonly label: string;
}): JSX.Element {
  const start = useRef<{ at: number; splitter: SplitterLayout } | null>(null);
  const horizontal = splitter.direction === "row";
  const move = (delta: number, history: "merge" | "record"): void => {
    const from = start.current?.splitter ?? splitter;
    const result = resizeSplitter(from, delta);
    if (result) {
      store.dispatch(result.operation, { history, animate: false });
    }
  };
  const finish = (): void => {
    if (start.current) {
      start.current = null;
      store.endMerge();
      root.current?.removeAttribute("data-mp-resizing");
    }
  };
  return (
    <div
      className="mp-splitter"
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={label}
      tabIndex={0}
      data-mp-direction={splitter.direction}
      data-mp-kind={splitter.kind}
      style={rectStyle(splitter.rect)}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { at: horizontal ? event.clientX : event.clientY, splitter };
        root.current?.setAttribute("data-mp-resizing", splitter.direction);
      }}
      onPointerMove={(event) => {
        if (start.current) {
          move((horizontal ? event.clientX : event.clientY) - start.current.at, "merge");
        }
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const delta =
          (horizontal && event.key === "ArrowLeft") || (!horizontal && event.key === "ArrowUp")
            ? -step
            : (horizontal && event.key === "ArrowRight") || (!horizontal && event.key === "ArrowDown")
              ? step
              : 0;
        if (delta) {
          event.preventDefault();
          move(delta, "record");
        }
      }}
    />
  );
}

/** A strip showing the columns and which of them are on screen. Drag or click it to scroll. */
function ColumnsBar({
  layout,
  scroller,
  label,
}: {
  readonly layout: WorkspaceLayout;
  readonly scroller: { readonly current: HTMLDivElement | null };
  readonly label: string;
}): JSX.Element {
  const thumb = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const scrollable = layout.contentWidth - layout.size.width;
  const total = layout.main.width + scrollable;
  useLayoutEffect(() => {
    const view = scroller.current;
    const update = (): void => {
      if (thumb.current && view) {
        thumb.current.style.left = `${String((view.scrollLeft / total) * 100)}%`;
        thumb.current.style.width = `${String((layout.main.width / total) * 100)}%`;
      }
    };
    update();
    view?.addEventListener("scroll", update, { passive: true });
    return () => view?.removeEventListener("scroll", update);
  }, [layout.main.width, scroller, total]);
  const scrollTo = (clientX: number): void => {
    const bounds = track.current?.getBoundingClientRect();
    const view = scroller.current;
    if (bounds && view) {
      const centre = ((clientX - bounds.left) / bounds.width) * total;
      view.scrollLeft = centre - layout.main.width / 2;
    }
  };
  const columns = layout.stacks.filter(({ pinned }) => !pinned);
  return (
    <div
      className="mp-columns-bar"
      style={{ left: layout.main.x, width: layout.main.width }}
      role="scrollbar"
      aria-label={label}
      aria-orientation="horizontal"
      aria-controls={undefined}
      aria-valuemin={0}
      aria-valuemax={Math.round(scrollable)}
      aria-valuenow={Math.round(scroller.current?.scrollLeft ?? 0)}
    >
      <div
        ref={track}
        className="mp-columns-track"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          scrollTo(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            scrollTo(event.clientX);
          }
        }}
      >
        {columns.map((stack) => (
          <span
            key={stack.id}
            className="mp-columns-mark"
            data-mp-focused={stack.focused || undefined}
            style={{
              left: `${String(((stack.rect.x - layout.main.x) / total) * 100)}%`,
              width: `${String((stack.rect.width / total) * 100)}%`,
              top: `${String(((stack.rect.y - layout.main.y) / Math.max(1, layout.main.height)) * 100)}%`,
              height: `${String((stack.rect.height / Math.max(1, layout.main.height)) * 100)}%`,
            }}
          />
        ))}
        <div ref={thumb} className="mp-columns-thumb" />
      </div>
    </div>
  );
}

interface DragDeps {
  readonly store: WorkspaceStore;
  readonly root: { readonly current: HTMLDivElement | null };
  readonly scroller: { readonly current: HTMLDivElement | null };
  readonly layoutRef: { readonly current: WorkspaceLayout | null };
  readonly setDrag: (drag: DragState | null) => void;
  readonly titleOf: (panel: PanelDescriptor) => string;
  /** The canvas camera as drawn. */
  readonly camera: { readonly current: Camera };
}

/** Dragging a tab: a short move starts it with a mouse, a long press with a finger. */
function useTabDrag(deps: DragDeps): (event: ReactPointerEvent, panel: PanelDescriptor) => void {
  const latest = useRef(deps);
  latest.current = deps;
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return useCallback((event: ReactPointerEvent, panel: PanelDescriptor) => {
    const layout = latest.current.layoutRef.current;
    if (!layout || layout.mode === "stack" || layout.mode === "overview") {
      return;
    }
    stop.current?.();
    const pointerId = event.pointerId;
    const touch = event.pointerType === "touch";
    const origin = { x: event.clientX, y: event.clientY };
    let last = origin;
    let started = false;
    let armed = !touch;
    let target: DropTarget | null = null;
    let frame = 0;
    const press = touch
      ? setTimeout(() => {
          armed = true;
        }, 350)
      : undefined;

    const update = (): void => {
      const { root, scroller, store, layoutRef, setDrag, titleOf } = latest.current;
      const bounds = root.current?.getBoundingClientRect();
      const current = layoutRef.current;
      if (!bounds || !current) {
        return;
      }
      const scrollLeft = scroller.current?.scrollLeft ?? 0;
      target = dropTargetAt(
        store.state,
        current,
        panel.id,
        { x: last.x - bounds.left, y: last.y - bounds.top },
        {
          scrollLeft,
          camera: latest.current.camera.current,
          tabs: (stack) =>
            [
              ...(root.current?.querySelectorAll<HTMLElement>(
                `[data-mp-stack="${CSS.escape(stack)}"] [role="tab"]`,
              ) ?? []),
            ]
              .filter((tab) => tab.dataset["mpTab"] !== panel.id)
              .map((tab) => {
                const box = tab.getBoundingClientRect();
                return { x: box.left - bounds.left, y: box.top - bounds.top, width: box.width, height: box.height };
              }),
        },
      );
      setDrag({ panel: panel.id, title: titleOf(panel), x: last.x, y: last.y, target });
    };
    // Near the sides of a scrolling main area, keep scrolling while the pointer rests there.
    const autoScroll = (): void => {
      const { root, scroller, layoutRef } = latest.current;
      const bounds = root.current?.getBoundingClientRect();
      const current = layoutRef.current;
      const view = scroller.current;
      if (started && bounds && current?.mode === "columns" && view) {
        const x = last.x - bounds.left;
        const left = current.main.x;
        const right = current.main.x + current.main.width;
        const speed = x < left + 48 && x >= left ? -14 : x > right - 48 && x <= right ? 14 : 0;
        if (speed) {
          const before = view.scrollLeft;
          view.scrollLeft += speed;
          if (view.scrollLeft !== before) {
            update();
          }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointerId) {
        return;
      }
      last = { x: next.clientX, y: next.clientY };
      const distance = Math.hypot(last.x - origin.x, last.y - origin.y);
      if (!started) {
        if (!armed) {
          if (distance > 8) {
            finish(false);
          }
          return;
        }
        if (distance < 5) {
          return;
        }
        started = true;
        frame = requestAnimationFrame(autoScroll);
      }
      next.preventDefault();
      update();
    };
    const finish = (commit: boolean): void => {
      clearTimeout(press);
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("touchmove", block, true);
      stop.current = null;
      if (started) {
        latest.current.setDrag(null);
        if (commit && target) {
          latest.current.store.dispatch({ type: "move", panel: panel.id, target: target.target });
        }
      }
    };
    const up = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) {
        finish(true);
      }
    };
    const cancel = (next: PointerEvent): void => {
      if (next.pointerId === pointerId) {
        finish(false);
      }
    };
    const key = (next: globalThis.KeyboardEvent): void => {
      if (next.key === "Escape" && started) {
        next.preventDefault();
        next.stopPropagation();
        finish(false);
      }
    };
    const block = (next: TouchEvent): void => {
      if (started) {
        next.preventDefault();
      }
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("touchmove", block, { capture: true, passive: false });
    stop.current = () => finish(false);
  }, []);
}
