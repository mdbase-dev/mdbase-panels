# @mdbase-dev/panels

A workspace of panels for web apps: tabs, splits, side regions, an unbounded canvas, and several
ways of looking at the same arrangement. The core is plain TypeScript with no dependencies; a React binding draws
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
  window (`tiling`), as columns that keep their width and scroll sideways (`columns`), as panes
  placed freely on a plane that pans and zooms (`canvas`), as a single panel on a narrow screen
  (`stack`), or all at once, scaled down (`overview`).
- **Side regions are ordinary stacks.** A region docked to a side has a size, limits and a
  priority, and nothing else is special about it: any panel can be moved in or out, and a region
  with no panels takes no room. What is saved is only whether the user wants it shown. Whether
  it is on screen is worked out each time from that, from the room there is (the
  lowest-priority region gives way first) and from anything the app asks to hide for now. There
  are no breakpoints to maintain apart from the one width below which a single panel is shown.
- **Following is a property of a panel, not of a place.** The workspace keeps track of a
  *leader*: the panel that last had focus, not counting panels that say they do not lead. An
  outline, an inspector or a notes panel reads the leader and shows something about it, wherever
  it has been put.

## Model

```ts
interface WorkspaceState {
  version: 1;
  panels: Record<PanelId, PanelDescriptor>; // what is open
  root: LayoutNode | null;                  // the main area: stacks and splits
  edges: Partial<Record<"left" | "right" | "top" | "bottom", EdgeRegion>>;
  focus: NodeId | null;                     // the stack that has focus
  maximized: NodeId | null;                 // a stack filling the workspace, edges hidden
  view: "tiling" | "columns" | "canvas";
  columns: Record<NodeId, number>;          // column widths, as fractions of the main width
  canvas: {
    frames: Record<NodeId, Rect & { z: number }>; // where each stack is on the plane
    camera: { x: number; y: number; zoom: number };
  };
  leader: PanelId | null;                   // whom follower panels are about
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
  leads?: boolean;   // false for a panel that shows something about another panel
}
```

A `stack` holds panels as tabs, one active. A `split` holds children in a `row` or a `column`
with sizes that sum to 1. The state is kept canonical after every operation: no empty stacks in
the main area, no split with one child, no split nested in a split of the same direction.

`violations(state)` lists anything wrong with a state; the tests run it after random sequences of
operations.

### Side regions

```ts
store.dispatch({ type: "configureEdge", side: "left", options: { size: 260, priority: 1 } });
store.dispatch({ type: "configureEdge", side: "left", options: { visible: false } }); // the user's wish
computeLayout(state, size, { hiddenEdges: ["left"], preferEdge: "right" });           // for now
```

`visible` is written by `configureEdge` and by moving a panel into the region, and by nothing
else: focusing a panel in a hidden region (which a narrow screen shows anyway) does not change
it. `hiddenEdges` leaves regions out of one layout without touching the state, and `preferEdge`
names the region that should be the last to give way, which an app sets to the one the user
asked for most recently. `layout.yielded` lists the regions that gave way.

### The leader

`state.leader` is the active panel of the focused stack whenever that panel can lead, and
otherwise stays what it was. Closing the leader hands over to the tab that takes its place. Give
panels that are *about* another panel `leads: false`, and read the leader with `useLeader(store)`
(or from the state). What a follower shows, and whether a particular follower is following at
the moment, is the app's business: a pinned follower can simply keep the panel it was showing.

### The canvas

In the `canvas` view every main-area stack has a frame on an unbounded plane, and a camera says
which part of the plane is on screen. The stacks are still in the tree, so the other views keep
working, and frames are kept when the view changes.

```ts
store.dispatch({ type: "setView", view: "canvas", frames: seedFrames(layout.stacks, layout.main) });
store.dispatch({ type: "setFrame", stack, frame: { x: 400, y: 80 } });
store.dispatch({ type: "setCamera", camera: { zoom: 0.5 } });
store.dispatch({ type: "move", panel, target: { at: "canvas", x: 1200, y: 0 } });
```

`frames` on `setView` is used the first time only, so that going to the canvas does not move
anything. A stack made by splitting goes beside the stack it was split from, further out if
something is in the way; the focused stack is in front. Moving the camera is not an undo step,
and undo leaves the camera where it is. `cameraToFit`, `cameraToReveal` and `zoomCameraAt` work
out cameras, and `dragFrame` turns a drag on a frame's side or corner into a new frame.

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
| `setView` | `tiling`, `columns` or `canvas` |
| `setFrame`, `setCamera` | Move or resize a pane on the canvas; pan or zoom it |
| `flatten` | Gather every main-area panel into one stack |
| `batch`, `load` | Several operations as one step; replace the whole state |

Targets say where a panel goes: `focus` (a tab in the focused stack), `stack`, `split` (a new
stack on one side of an existing one), `beside` (next to the stack that holds another panel),
`column` (a new top-level column), `root` (along one side of the whole main area), `edge`, and
`canvas` (a new pane at a point on the plane).

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

On the canvas, the wheel pans and Ctrl or Cmd with the wheel (a trackpad pinch) zooms about the
pointer; dragging open ground pans. The focused pane works as usual. The others are covered, so
that a click picks one, a double click zooms to it, and a wheel or drag over one moves the canvas
instead of being swallowed by a frame inside it. A pane is moved by the grip at the start of its
tab strip (or any bare part of the strip; arrow keys on the grip move it, with Shift they resize
it) and resized from its sides and corners. Dragging a tab onto open ground gives it a pane of
its own. Panning and zooming change one transform per pane and lay nothing out again; the camera
is written to the state when the gesture settles.

Colours and sizes come from custom properties (`--mp-bg`, `--mp-surface`, `--mp-header-bg`,
`--mp-border`, `--mp-text`, `--mp-muted`, `--mp-accent`, `--mp-drop`, and so on) set on
`.mp-workspace` or any ancestor.

The core can be used without React: `computeLayout(state, size, options)` returns rectangles for
every stack, panel and splitter, `dropTargetAt` says where a dragged panel would land, and
`resizeSplitter` turns a drag into an operation.

## Not built

- On the canvas: pinch-zoom with two fingers on a touch screen (a trackpad pinch works), a
  minimap, lines or groups between panes, and export to a canvas file format.
- Dropping a tab on a side region that is empty or hidden. Use a `move` operation (a menu item).
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
