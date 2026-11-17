import { useState } from "react";
import { createRoot } from "react-dom/client";

import { mainStacks, webStorage, WorkspaceStore, type Operation } from "../src/core/index.js";
import { useWorkspaceState, Workspace } from "../src/react/index.js";
import "../src/styles.css";

const fresh = new URLSearchParams(location.search).has("fresh");
const seed: Operation[] = [
  { type: "add", panel: { id: "library", kind: "doc", title: "Library" } },
  { type: "add", panel: { id: "paper", kind: "doc", title: "Smith 2019" }, target: { at: "beside", panel: "library", side: "right" } },
  { type: "add", panel: { id: "notes", kind: "doc", title: "Notes on Smith" } },
  { type: "add", panel: { id: "nav", kind: "side", title: "Sources" }, target: { at: "edge", side: "left" }, activate: false },
  { type: "add", panel: { id: "inspector", kind: "side", title: "Notes" }, target: { at: "edge", side: "right" }, activate: false },
  { type: "configureEdge", side: "left", options: { size: 220, priority: 0 } },
  { type: "configureEdge", side: "right", options: { size: 280, priority: 1 } },
  { type: "activate", panel: "paper" },
];
const store = new WorkspaceStore({
  ...(fresh ? {} : { storage: webStorage("mdbase-panels-demo") }),
});
if (!Object.keys(store.state.panels).length) {
  for (const operation of seed) {
    store.dispatch(operation, { history: "skip" });
  }
}
Object.assign(globalThis, { store });

let count = 0;
function Doc({ id, title }: { id: string; title: string }) {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="doc" data-doc={id}>
      <h2>{title}</h2>
      <p>
        <button onClick={() => setClicks(clicks + 1)}>Clicked {clicks} times</button> State and the
        frame below must survive every move.
      </p>
      <iframe
        title={`${title} frame`}
        srcDoc={`<body style="font:14px system-ui"><p>Loaded at <b id="t"></b></p><p>Seconds alive: <b id="s">0</b></p><script>document.getElementById('t').textContent=new Date().toLocaleTimeString();let n=0;setInterval(()=>document.getElementById('s').textContent=++n,1000)</script></body>`}
      />
      {Array.from({ length: 30 }, (_, index) => (
        <p key={index}>Paragraph {index + 1} of {title}. Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      ))}
    </div>
  );
}

function App() {
  const state = useWorkspaceState(store);
  const [overview, setOverview] = useState(false);
  const add = (target?: Operation & { type: "add" }) => {
    count += 1;
    const id = `doc-${Date.now().toString(36)}-${String(count)}`;
    store.dispatch({ type: "add", panel: { id, kind: "doc", title: `Document ${String(count)}` }, ...(target ? { target: target.target } : {}) } as Operation);
  };
  const focused = mainStacks(state).find(({ id }) => id === state.focus);
  return (
    <div className="shell">
      <div className="bar">
        <button onClick={() => add()}>Open</button>
        <button
          onClick={() => {
            count += 1;
            store.dispatch({
              type: "add",
              panel: { id: `doc-${Date.now().toString(36)}-${String(count)}`, kind: "doc", title: `Document ${String(count)}` },
              target:
                state.view === "columns"
                  ? { at: "column", side: "right" }
                  : focused?.active
                    ? { at: "beside", panel: focused.active, side: "right" }
                    : { at: "root", side: "right" },
            });
          }}
        >
          Open beside
        </button>
        <button onClick={() => store.dispatch({ type: "setView", view: state.view === "tiling" ? "columns" : "tiling" })}>
          View: {state.view}
        </button>
        <button onClick={() => setOverview(!overview)}>Overview</button>
        <button onClick={() => store.dispatch({ type: "configureEdge", side: "left", options: { visible: !state.edges.left?.visible } })}>Left</button>
        <button onClick={() => store.dispatch({ type: "configureEdge", side: "right", options: { visible: !state.edges.right?.visible } })}>Right</button>
        <button onClick={() => store.dispatch({ type: "maximize", stack: state.maximized ? null : state.focus })}>Maximize</button>
        <button onClick={() => store.dispatch({ type: "flatten" })}>Flatten</button>
        <button onClick={() => store.undo()} disabled={!store.canUndo}>Undo</button>
        <button onClick={() => store.redo()} disabled={!store.canRedo}>Redo</button>
      </div>
      <Workspace
        store={store}
        layout={{ compactBelow: 681, compactHeaderHeight: 36 }}
        overview={overview}
        onOverviewChange={setOverview}
        renderPanel={(panel) =>
          panel.kind === "side" ? (
            <div className="side">
              <h3>{panel.title}</h3>
              <p>A fixed region. It keeps its width when the main area changes.</p>
            </div>
          ) : (
            <Doc id={panel.id} title={panel.title ?? panel.id} />
          )
        }
        renderEmpty={() => <p>Nothing open. Use Open.</p>}
        canClose={(panel) => panel.kind !== "side"}
        tabMenu={(panel, info) => [
          { label: "Close", action: info.close, disabled: panel.kind === "side" },
          { label: "Move to new pane right", action: () => store.dispatch({ type: "move", panel: panel.id, target: { at: "split", stack: info.stack, side: "right" } }) },
          { label: "Move to new pane below", action: () => store.dispatch({ type: "move", panel: panel.id, target: { at: "split", stack: info.stack, side: "bottom" } }) },
        ]}
        announce={(change) => (change.operation.type === "add" ? `Opened ${change.operation.panel.title ?? ""}` : undefined)}
      />
    </div>
  );
}

const app = document.getElementById("app");
if (app) {
  createRoot(app).render(<App />);
}
