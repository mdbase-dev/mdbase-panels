import { allStacks, mainStacks } from "./tree.js";
import { type LayoutNode, type WorkspaceState } from "./types.js";

/** Problems with a state that normalization should have removed. Empty when it is canonical. */
export function violations(state: WorkspaceState): string[] {
  const problems: string[] = [];
  const stacks = allStacks(state);
  const placed = stacks.flatMap(({ panels }) => panels);
  if (new Set(placed).size !== placed.length) {
    problems.push("a panel is placed more than once");
  }
  for (const id of placed) {
    if (!Object.hasOwn(state.panels, id)) {
      problems.push(`placed panel ${id} has no descriptor`);
    }
  }
  for (const id of Object.keys(state.panels)) {
    if (!placed.includes(id)) {
      problems.push(`panel ${id} is not placed`);
    }
    if (state.panels[id]?.id !== id) {
      problems.push(`panel ${id} is stored under the wrong id`);
    }
  }
  for (const stack of stacks) {
    if (stack.panels.length ? !stack.panels.includes(stack.active ?? "") : stack.active !== null) {
      problems.push(`stack ${stack.id} has a stale active panel`);
    }
  }
  const ids: string[] = [];
  const visit = (node: LayoutNode, parent: LayoutNode | null): void => {
    ids.push(node.id);
    if (node.type === "stack") {
      if (!node.panels.length) {
        problems.push(`main stack ${node.id} is empty`);
      }
      return;
    }
    if (node.children.length < 2) {
      problems.push(`split ${node.id} has fewer than two children`);
    }
    if (parent?.type === "split" && parent.direction === node.direction) {
      problems.push(`split ${node.id} repeats its parent's direction`);
    }
    if (node.sizes.length !== node.children.length) {
      problems.push(`split ${node.id} has the wrong number of sizes`);
    }
    if (node.sizes.some((size) => !(size > 0))) {
      problems.push(`split ${node.id} has a non-positive size`);
    }
    if (Math.abs(node.sizes.reduce((sum, size) => sum + size, 0) - 1) > 1e-6) {
      problems.push(`split ${node.id} sizes do not sum to 1`);
    }
    node.children.forEach((child) => visit(child, node));
  };
  if (state.root) {
    visit(state.root, null);
  }
  for (const edge of Object.values(state.edges)) {
    ids.push(edge.stack.id);
  }
  if (new Set(ids).size !== ids.length) {
    problems.push("a node id is used twice");
  }
  const main = mainStacks(state);
  if (state.focus !== null && !stacks.some(({ id }) => id === state.focus)) {
    problems.push("focus refers to a missing stack");
  }
  if (state.focus === null && placed.length) {
    problems.push("nothing is focused although panels are open");
  }
  if (state.maximized !== null && !main.some(({ id }) => id === state.maximized)) {
    problems.push("maximized refers to a missing main stack");
  }
  if (state.leader !== null && state.panels[state.leader]?.leads === false) {
    problems.push("the leader is a panel that does not lead");
  }
  if (state.leader !== null && !Object.hasOwn(state.panels, state.leader)) {
    problems.push("the leader refers to a missing panel");
  }
  const focused = stacks.find(({ id }) => id === state.focus)?.active;
  if (focused && state.panels[focused]?.leads !== false && state.leader !== focused) {
    problems.push("the focused panel can lead but is not the leader");
  }
  for (const id of Object.keys(state.canvas.frames)) {
    if (!main.some((stack) => stack.id === id)) {
      problems.push(`canvas frame ${id} has no main stack`);
    }
  }
  if (state.view === "canvas") {
    for (const { id } of main) {
      const frame = state.canvas.frames[id];
      if (!frame) {
        problems.push(`main stack ${id} has no canvas frame`);
      } else if (
        id === state.focus &&
        Object.entries(state.canvas.frames).some(([other, { z }]) => other !== id && z >= frame.z)
      ) {
        problems.push("the focused stack is not in front");
      }
    }
  }
  return problems;
}
