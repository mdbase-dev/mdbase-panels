import { useSyncExternalStore } from "react";

import { type WorkspaceState, type WorkspaceStore } from "../core/index.js";

/** The current workspace, re-rendering the caller when it changes. */
export function useWorkspaceState(store: WorkspaceStore): WorkspaceState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
