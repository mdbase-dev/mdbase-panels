import { useSyncExternalStore } from "react";

import { type PanelDescriptor, type WorkspaceState, type WorkspaceStore } from "../core/index.js";

/** The current workspace, re-rendering the caller when it changes. */
export function useWorkspaceState(store: WorkspaceStore): WorkspaceState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/**
 * The panel that followers are about: the one that last had focus, not counting panels with
 * `leads: false`. Re-renders the caller only when that changes.
 */
export function useLeader(store: WorkspaceStore): PanelDescriptor | null {
  const read = (): PanelDescriptor | null => {
    const { leader, panels } = store.getState();
    return leader === null ? null : (panels[leader] ?? null);
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
