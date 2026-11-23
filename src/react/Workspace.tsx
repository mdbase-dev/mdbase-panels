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
  computeLayout,
  dropTargetAt,
  edgeOfStack,
  findStack,
  resizeSplitter,
  type DropTarget,
  type EdgeSide,
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
}

const defaultLabels: WorkspaceLabels = {
  workspace: "Workspace",
  tabs: "Open panels",
  resize: "Resize",
  closeTab: "Close",
  overview: "All open panels",
  show: (title) => `Show ${title}`,
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
  const focusTab = useRef<PanelId | null>(null);
  const announce = props.announce;
  useLayoutEffect(
    () =>
      store.subscribe((change) => {
        animate.current = change.animate;
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
  }

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const motion = props.motion;
  const visuals = useRef(new Map<string, Visual>());
  useLayoutEffect(() => {
    if (!layout) {
      return;
    }
    const next = new Map<string, Visual>();
    for (const stack of layout.stacks) {
      next.set(`s:${stack.id}`, { ...stack.rect, scale: 1, visible: true });
    }
    for (const panel of layout.panels) {
      next.set(`p:${panel.id}`, { ...panel.rect, scale: panel.scale, visible: panel.visible });
    }
    if (animate.current && motion !== false && !prefersReducedMotion()) {
      const options = { ...defaultFlip, ...motion };
      for (const [key, to] of next) {
        const element = elements.current.get(key);
        if (element) {
          flip(element, visuals.current.get(key), to, options);
        }
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

  // Reported before the browser paints or handles input, so an app that keeps the size (to know
  // it is in the phone layout, say) never acts on a key press with the size from before.
  const onLayout = props.onLayout;
  useLayoutEffect(() => {
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
    const pointer = (event: PointerEvent): void => focusFrom(event.target);
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

  const beginDrag = useTabDrag({ store, root, layoutRef, setDrag, titleOf });

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
      data-mp-dragging={drag ? "" : undefined}
      role="group"
      aria-label={labels.workspace}
    >
      {layout?.stacks.map((stack) => (
        <StackFrame
          key={stack.id}
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
          dragging={drag?.panel ?? null}
          setMenu={setMenu}
          focusTab={focusTab}
        />
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
              <PanelHost
                key={id}
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
            );
          })
        : null}
      {layout?.splitters.map((splitter) => (
        <Splitter key={splitter.id} splitter={splitter} store={store} root={root} label={labels.resize} />
      ))}
      {empty && layout ? (
        <div className="mp-empty" style={rectStyle(layout.main)}>
          {props.renderEmpty?.()}
        </div>
      ) : null}
      {mode === "overview" && layout ? (
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
      ) : null}
      {drag?.target ? <div className="mp-drop" style={rectStyle(drag.target.indicator)} /> : null}
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
      >
        <div
          ref={strip}
          className="mp-tabs"
          role="tablist"
          aria-label={props.labels.tabs}
          onWheel={(event) => {
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

interface DragDeps {
  readonly store: WorkspaceStore;
  readonly root: { readonly current: HTMLDivElement | null };
  readonly layoutRef: { readonly current: WorkspaceLayout | null };
  readonly setDrag: (drag: DragState | null) => void;
  readonly titleOf: (panel: PanelDescriptor) => string;
}

/** Dragging a tab: a short move starts it with a mouse, a long press with a finger. */
function useTabDrag(deps: DragDeps): (event: ReactPointerEvent, panel: PanelDescriptor) => void {
  const latest = useRef(deps);
  latest.current = deps;
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return useCallback((event: ReactPointerEvent, panel: PanelDescriptor) => {
    const layout = latest.current.layoutRef.current;
    if (layout?.mode !== "tiling") {
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
    const press = touch
      ? setTimeout(() => {
          armed = true;
        }, 350)
      : undefined;

    const update = (): void => {
      const { root, store, layoutRef, setDrag, titleOf } = latest.current;
      const bounds = root.current?.getBoundingClientRect();
      const current = layoutRef.current;
      if (!bounds || !current) {
        return;
      }
      target = dropTargetAt(
        store.state,
        current,
        panel.id,
        { x: last.x - bounds.left, y: last.y - bounds.top },
        {
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
      }
      next.preventDefault();
      update();
    };
    const finish = (commit: boolean): void => {
      clearTimeout(press);
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
