# @mdbase-dev/panels

A workspace of panels for web apps: tabs, splits and side regions. The core is plain TypeScript
with no dependencies; a React binding draws it.

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
- **One model, three ways to show it.** The same arrangement is drawn as tiles that fill the
  window (`tiling`), as a single panel on a narrow screen (`stack`), or all at once, scaled down
  (`overview`).
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
  leads?: boolean;   // false for a panel that is about others without following one
  follows?: "leader" | { pane: NodeId }; // a follower: see "The leader and followers"
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

### The leader and followers

`state.leader` is the active panel of the focused stack whenever that panel can lead, and
otherwise stays what it was. Closing the leader hands over to the tab that takes its place.
Every stack also has a `lead` of its own: its active panel when that one can lead, else the
panel in it that last did.

A follower is a panel that is *about* another panel: an outline, an inspector, a list of
annotations. Give it `follows`:

```ts
{ id: "outline", kind: "outline", follows: "leader" }          // the panel used last, anywhere
{ id: "notes", kind: "notes", follows: { pane: "n4" } }        // the panel leading one pane
store.dispatch({ type: "follow", panel: "notes", follows: { pane: stack.id } });
store.dispatch({ type: "follow", panel: "notes", follows: null }); // an ordinary panel again
```

`subjectOf(state, panel)` (or `useSubject(store, panel)`) says which panel a follower is about
right now. What it shows about that panel is the app's business. A follower never leads, so
using it does not change what it is about, and a follower of a pane that has gone follows the
leader. A panel that is about others without following any one of them (a list of sources,
say) takes `leads: false` instead. When the focused panel does not lead, `{ type: "lead",
panel }` names the leader.

## Operations

```ts
store.dispatch({ type: "add", panel: { id: "p1", kind: "doc", title: "Notes" } });
store.dispatch({ type: "add", panel, target: { at: "beside", panel: "p1", side: "right" } });
store.dispatch({ type: "move", panel: "p1", target: { at: "edge", side: "left" } });
```

| Operation | Effect |
| --- | --- |
| `add`, `remove`, `update` | Open, close or change a panel |
| `move`, `moveStack` | Put a panel, or a whole stack of them, somewhere else |
| `activate`, `focus` | Show a panel; give a stack focus |
| `lead` | Name the leader while the focused panel does not lead |
| `follow` | Make a panel a follower, change whom it follows, or stop it following |
| `resize`, `configureEdge` | Sizes of splits and side regions |
| `maximize` | One stack fills the workspace (pass `null` to restore) |
| `flatten` | Gather every main-area panel into one stack |
| `batch`, `load` | Several operations as one step; replace the whole state |

Targets say where a panel goes: `focus` (a tab in the focused stack), `stack`, `split` (a new
stack on one side of an existing one), `beside` (next to the stack that holds another panel),
`root` (along one side of the whole main area) and `edge`.

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

A window that should keep its own layout across a reload, while a new window starts from the
one used last, saves to session storage and to local storage and reads session storage first.
That is a `{ load(), save() }` pair of a few lines; the library does not keep two windows in
step with each other.

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
`.mp-workspace` or any ancestor. The default colours follow the page's `color-scheme`: set
`color-scheme: light dark` on the root to follow the system, or `light` or `dark` to fix it.

The core can be used without React: `computeLayout(state, size, options)` returns rectangles for
every stack, panel and splitter, `dropTargetAt` says where a dragged panel would land, and
`resizeSplitter` turns a drag into an operation.

## Not built

- Dropping a tab on a side region that is empty or hidden. Use a `move` operation (a menu item).
- A general constraint solver. Sizes use minimums, maximums and priorities.
- Storage in mdbase records, and sync between devices, windows or people.
- Workspaces shared between apps. `PanelDescriptor.app` and the opaque `data` are there so a
  workspace can hold panels of several apps; nothing reads them yet.
- Pop-out windows.
- Other ways to arrange the main area. A view of columns that scroll sideways and a free canvas
  that pans and zooms were built and taken out again in 0.3.0, to keep the library to what its
  apps use. They are in the history at the `with-canvas` tag.

## Development

```sh
pnpm install
pnpm test        # unit and property tests
pnpm typecheck
pnpm demo        # http://127.0.0.1:5179
pnpm build       # dist/
```

To release, change `version` in `package.json`, merge that, and push a tag `v<version>`. The
`Publish to npm` workflow checks, builds and publishes it.
