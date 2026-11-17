# @mdbase-dev/panels

A workspace of panels for web apps: tabs, splits, fixed side regions, and several ways of looking
at the same arrangement. The core is plain TypeScript with no dependencies; a React binding draws
it.

It was written for the mdbase apps (reader, editor, writer) but knows nothing about them.

## What is different from a docking library

- **A panel is not where it is drawn.** Each panel's content is mounted once and never moved in
  the DOM, whatever happens to the layout. An iframe, a PDF or an editor keeps its state when its
  panel is dragged, split, maximized, shown in the overview, or hidden behind another tab.
  While a tab is dragged or a divider is moved, a transparent shield covers the window, so a
  frame under the pointer cannot take the gesture.
- **The layout is a document.** The whole workspace is one immutable JSON value. Every change is
  an operation, which is also plain data. That gives undo and redo, and a snapshot format that
  can be stored anywhere.
- **One model, several views.** The same arrangement can be shown as tiles that fill the
  window (`tiling`), as columns that keep their width and scroll sideways (`columns`), as a single
  panel on a narrow screen (`stack`), or all at once, scaled down (`overview`).
- **Regions give way by priority.** Side regions have a size, limits and a priority. When the
  main area would get too narrow, the lowest-priority region hides first. There are no
  breakpoints to maintain apart from the one width below which a single panel is shown.

## Model

```ts
interface WorkspaceState {
  version: 1;
  panels: Record<PanelId, PanelDescriptor>; // what is open
  root: LayoutNode | null;                  // the main area: stacks and splits
  edges: Partial<Record<"left" | "right" | "top" | "bottom", EdgeRegion>>;
  focus: NodeId | null;                     // the stack that has focus
  maximized: NodeId | null;                 // a stack filling the workspace, edges hidden
  view: "tiling" | "columns";
  columns: Record<NodeId, number>;          // column widths, as fractions of the main width
  seq: number;                              // source of node ids
}

interface PanelDescriptor {
  id: string;
  kind: string;      // which renderer draws it
  app?: string;      // which app owns it (for workspaces shared between apps, later)
  title?: string;
  data?: PanelData;  // JSON, opaque to the library; the app's own state for this panel
  minWidth?: number;
  minHeight?: number;
}
```

A `stack` holds panels as tabs, one active. A `split` holds children in a `row` or a `column`
with sizes that sum to 1. The state is kept canonical after every operation: no empty stacks in
the main area, no split with one child, no split nested in a split of the same direction.

`violations(state)` lists anything wrong with a state; the tests run it after random sequences of
operations.

## Operations

```ts
store.dispatch({ type: "add", panel: { id: "p1", kind: "doc", title: "Notes" } });
store.dispatch({ type: "add", panel, target: { at: "beside", panel: "p1", side: "right" } });
store.dispatch({ type: "move", panel: "p1", target: { at: "edge", side: "left" } });
store.dispatch({ type: "setView", view: "columns" });
```

| Operation | Effect |
| --- | --- |
| `add`, `remove`, `update` | Open, close or change a panel |
| `move`, `moveStack` | Put a panel, or a whole stack of them, somewhere else |
| `activate`, `focus` | Show a panel; give a stack focus |
| `resize`, `setColumnWidth`, `configureEdge` | Sizes of splits, columns and side regions |
| `maximize` | One stack fills the workspace (pass `null` to restore) |
| `setView` | `tiling` or `columns` |
| `flatten` | Gather every main-area panel into one stack |
| `batch`, `load` | Several operations as one step; replace the whole state |

Targets say where a panel goes: `focus` (a tab in the focused stack), `stack`, `split` (a new
stack on one side of an existing one), `beside` (next to the stack that holds another panel),
`column` (a new top-level column), `root` (along one side of the whole main area), `edge`.

`apply(state, operation)` is pure, so operations can be logged, replayed or sent elsewhere.

## Store, undo and storage

```ts
import { WorkspaceStore, webStorage } from "@mdbase-dev/panels";

const store = new WorkspaceStore({ storage: webStorage("my-app:workspace") });
store.subscribe((change) => { /* change.state, change.previous, change.operation */ });
store.undo();
store.redo();
```

Storage is optional and has levels; each is a `{ load(), save(snapshot) }` pair.

| Level | How |
| --- | --- |
| None | Omit `storage`. The workspace lasts as long as the page. |
| This browser | `webStorage(key)` |
| Anything else | Write the two functions: an mdbase record, a file, a synced document |

Only the first two exist today. The snapshot is `{ format: "mdbase-panels", version: 1,
workspace }`. `fromSnapshot` validates and repairs what it reads and throws on anything it does
not recognise, so a saved layout can never stop an app from starting.

## React

```tsx
import { Workspace } from "@mdbase-dev/panels/react";
import "@mdbase-dev/panels/styles.css";

<Workspace
  store={store}
  layout={{ compactBelow: 681 }}
  renderPanel={(panel, info) => <MyPanel panel={panel} visible={info.visible} />}
  renderTab={(panel, info) => <MyTab panel={panel} onClose={info.close} />}
  renderStackActions={(info) => <MyButtons stack={info.stack} />}
  tabMenu={(panel, info) => [{ label: "Close", action: info.close }]}
  onRequestClose={(panels) => confirmThenClose(panels)}
  overview={overviewOpen}
  onOverviewChange={setOverviewOpen}
/>
```

The component fills its parent, which must have a size. It handles tab dragging (mouse, pen and
long-press touch), splitters, keyboard use (arrow keys between tabs, Delete to close,
Ctrl/Cmd+Shift+arrows to reorder, arrow keys on a focused splitter), context menus, announcements
for screen readers, and animation between layouts (off when the system asks for reduced motion).

Colours and sizes come from custom properties (`--mp-bg`, `--mp-surface`, `--mp-header-bg`,
`--mp-border`, `--mp-text`, `--mp-muted`, `--mp-accent`, `--mp-drop`, and so on) set on
`.mp-workspace` or any ancestor.

The core can be used without React: `computeLayout(state, size, options)` returns rectangles for
every stack, panel and splitter, `dropTargetAt` says where a dragged panel would land, and
`resizeSplitter` turns a drag into an operation.

## Not built

- Free-form canvas with pan and zoom. The overview is a grid of scaled panels.
- A general constraint solver. Sizes use minimums, maximums and priorities.
- Storage in mdbase records, and sync between devices or people.
- Workspaces shared between apps. `PanelDescriptor.app` and the opaque `data` are there so a
  workspace can hold panels of several apps; nothing reads them yet.
- Pop-out windows.

## Development

```sh
pnpm install
pnpm test        # unit and property tests
pnpm typecheck
pnpm demo        # http://127.0.0.1:5179
pnpm build       # dist/
```
