import { useSyncExternalStore } from "react";

import {
  subjectOf,
  type PanelDescriptor,
  type PanelId,
  type WorkspaceState,
  type WorkspaceStore,
} from "../core/index.js";

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

/**
 * The panel a follower is about right now (see `PanelDescriptor.follows`): the leader, or the
 * panel leading the pane it follows. Re-renders the caller only when that changes.
 */
export function useSubject(store: WorkspaceStore, panel: PanelId): PanelDescriptor | null {
  const read = (): PanelDescriptor | null => {
    const state = store.getState();
    const subject = subjectOf(state, panel);
    return subject === null ? null : (state.panels[subject] ?? null);
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
