import { useState } from "react";
import { createRoot } from "react-dom/client";

import { mainStacks, webStorage, WorkspaceStore, type Operation } from "../src/core/index.js";
import { useSubject, useWorkspaceState, Workspace } from "../src/react/index.js";
import "../src/styles.css";

const fresh = new URLSearchParams(location.search).has("fresh");
const seed: Operation[] = [
  { type: "add", panel: { id: "library", kind: "doc", title: "Library" } },
  { type: "add", panel: { id: "paper", kind: "doc", title: "Smith 2019" }, target: { at: "beside", panel: "library", side: "right" } },
  { type: "add", panel: { id: "notes", kind: "doc", title: "Notes on Smith" } },
  { type: "add", panel: { id: "nav", kind: "side", title: "Sources", leads: false }, target: { at: "edge", side: "left" }, activate: false },
  { type: "add", panel: { id: "inspector", kind: "side", title: "Notes", follows: "leader" }, target: { at: "edge", side: "right" }, activate: false },
  { type: "configureEdge", side: "left", options: { size: 220, priority: 0 } },
  { type: "configureEdge", side: "right", options: { size: 280, priority: 1 } },
  { type: "activate", panel: "paper" },
];
const store = new WorkspaceStore(fresh ? {} : { storage: webStorage("mdbase-panels-demo:3") });
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

/** A follower is about the document last used, or the one leading the pane it follows. */
function Follower({ id, title }: { id: string; title: string }) {
  const subject = useSubject(store, id);
  return (
    <div className="side">
      <h3>{title}</h3>
      <p data-following={subject?.id ?? ""}>
        {subject ? `About: ${subject.title ?? subject.id}` : "Nothing to be about."}
      </p>
      <p>A region docked to the side. Any tab can live here, and this one can live anywhere.</p>
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
              target: focused?.active
                ? { at: "beside", panel: focused.active, side: "right" }
                : { at: "root", side: "right" },
            });
          }}
        >
          Open beside
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
            <Follower id={panel.id} title={panel.title ?? panel.id} />
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
          ...(panel.follows
            ? [
                { label: "Follow the document last used", action: () => store.dispatch({ type: "follow", panel: panel.id, follows: "leader" }), separated: true },
                ...mainStacks(state).map((stack) => ({
                  label: `Follow the pane showing ${state.panels[stack.lead ?? ""]?.title ?? stack.id}`,
                  action: () => store.dispatch({ type: "follow", panel: panel.id, follows: { pane: stack.id } }),
                })),
              ]
            : []),
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
