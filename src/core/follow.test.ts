import { describe, expect, it } from "vitest";

import { violations } from "./invariants.js";
import { apply } from "./operations.js";
import { fromSnapshot, toSnapshot } from "./serialize.js";
import { emptyWorkspace, findStack, mainStacks, paneLeader, stackOfPanel, subjectOf } from "./tree.js";
import { type Operation, type WorkspaceState } from "./types.js";

const run = (operations: readonly Operation[], from = emptyWorkspace()): WorkspaceState =>
  operations.reduce((state, operation) => {
    const next = apply(state, operation);
    expect(violations(next)).toEqual([]);
    return next;
  }, from);

const doc = (id: string): Operation => ({ type: "add", panel: { id, kind: "doc" } });

/** Two panes: a and b in the first, c in the second, and an outline at the right. */
function twoPanes(): WorkspaceState {
  return run([
    doc("a"),
    doc("b"),
    { type: "add", panel: { id: "c", kind: "doc" }, target: { at: "split", stack: "n1", side: "right" } },
    {
      type: "add",
      panel: { id: "outline", kind: "outline", follows: "leader" },
      target: { at: "edge", side: "right" },
      activate: false,
    },
  ]);
}

describe("following", () => {
  it("a follower of the leader is about whichever panel was used last", () => {
    let state = twoPanes();
    expect(subjectOf(state, "outline")).toBe("c");
    state = run([{ type: "activate", panel: "a" }], state);
    expect(subjectOf(state, "outline")).toBe("a");
  });

  it("a follower never leads, so using it does not change what it is about", () => {
    const state = run([{ type: "activate", panel: "outline" }], twoPanes());
    expect(state.leader).toBe("c");
    expect(subjectOf(state, "outline")).toBe("c");
  });

  it("a follower of a pane stays with that pane while another pane is in use", () => {
    let state = twoPanes();
    const first = stackOfPanel(state, "a")?.id ?? "";
    state = run([{ type: "follow", panel: "outline", follows: { pane: first } }], state);
    expect(state.leader).toBe("c");
    expect(subjectOf(state, "outline")).toBe("b");
    state = run([{ type: "activate", panel: "a" }, { type: "activate", panel: "c" }], state);
    expect(subjectOf(state, "outline")).toBe("a");
  });

  it("a pane is led by the panel in it that last could lead", () => {
    let state = run([
      doc("a"),
      doc("b"),
      { type: "add", panel: { id: "notes", kind: "notes", follows: { pane: "n1" } }, target: { at: "stack", stack: "n1" } },
    ]);
    expect(findStack(state, "n1")?.active).toBe("notes");
    expect(paneLeader(state, "n1")).toBe("b");
    expect(subjectOf(state, "notes")).toBe("b");
    state = run([{ type: "activate", panel: "a" }, { type: "activate", panel: "notes" }], state);
    expect(subjectOf(state, "notes")).toBe("a");
    state = run([{ type: "remove", panel: "a" }], state);
    expect(subjectOf(state, "notes")).toBe("b");
  });

  it("a follower of a pane that has gone follows the leader", () => {
    let state = twoPanes();
    const second = stackOfPanel(state, "c")?.id ?? "";
    state = run([{ type: "follow", panel: "outline", follows: { pane: second } }], state);
    state = run([{ type: "remove", panel: "c" }], state);
    expect(mainStacks(state)).toHaveLength(1);
    expect(state.panels["outline"]?.follows).toBe("leader");
    expect(subjectOf(state, "outline")).toBe(state.leader);
  });

  it("a panel that starts following hands the lead on, and can take it back", () => {
    let state = run([doc("a"), doc("b")]);
    expect(state.leader).toBe("b");
    state = run([{ type: "follow", panel: "b", follows: "leader" }], state);
    expect(state.leader).toBe("a");
    expect(subjectOf(state, "b")).toBe("a");
    state = run([{ type: "follow", panel: "b", follows: null }], state);
    expect(state.panels["b"]).toEqual({ id: "b", kind: "doc" });
    expect(state.leader).toBe("b");
    expect(subjectOf(state, "b")).toBeNull();
  });

  it("whom a panel follows survives a snapshot", () => {
    let state = twoPanes();
    const first = stackOfPanel(state, "a")?.id ?? "";
    state = run([{ type: "follow", panel: "outline", follows: { pane: first } }, { type: "activate", panel: "a" }], state);
    const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))));
    expect(restored.panels["outline"]?.follows).toEqual({ pane: first });
    expect(subjectOf(restored, "outline")).toBe("a");
    expect(restored).toEqual(state);
  });
});
