import { type SplitterLayout } from "./layout.js";
import { type Operation } from "./types.js";

export interface SplitterResize {
  readonly operation: Operation;
  /** How far the splitter actually moved, after limits. */
  readonly moved: number;
}

/** The operation that moves a splitter by `delta` pixels along its direction. */
export function resizeSplitter(splitter: SplitterLayout, delta: number): SplitterResize | null {
  if (splitter.kind === "split") {
    const before = splitter.sizes[splitter.index] ?? 0;
    const after = splitter.sizes[splitter.index + 1] ?? 0;
    const least = splitter.minimums[splitter.index] ?? 0;
    const leastAfter = splitter.minimums[splitter.index + 1] ?? 0;
    const moved = Math.max(
      Math.min(0, least - before),
      Math.min(Math.max(0, after - leastAfter), delta),
    );
    const sizes = [...splitter.sizes];
    sizes[splitter.index] = before + moved;
    sizes[splitter.index + 1] = after - moved;
    const total = sizes.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return null;
    }
    return {
      moved,
      operation: {
        type: "resize",
        split: splitter.split,
        sizes: sizes.map((value) => value / total),
      },
    };
  }
  const grow = splitter.side === "left" || splitter.side === "top" ? delta : -delta;
  const size = Math.min(splitter.max, Math.max(splitter.min, splitter.size + grow));
  const moved = size - splitter.size;
  return {
    moved: splitter.side === "left" || splitter.side === "top" ? moved : -moved,
    operation: { type: "configureEdge", side: splitter.side, options: { size } },
  };
}
