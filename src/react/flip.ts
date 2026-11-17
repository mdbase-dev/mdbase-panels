/** What an element looked like at the end of a render, in viewport coordinates. */
export interface Visual {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly visible: boolean;
}

export interface FlipOptions {
  readonly duration: number;
  readonly easing: string;
}

export const defaultFlip: FlipOptions = {
  duration: 220,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};

export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Animate an element from where it was to where it now is. The element is already laid out at
 * its final size, so its content reflows once; only a transform plays.
 */
export function flip(
  element: HTMLElement,
  from: Visual | undefined,
  to: Visual,
  options: FlipOptions,
): void {
  if (!to.visible || typeof element.animate !== "function") {
    return;
  }
  const rest = to.scale === 1 ? "none" : `scale(${String(to.scale)})`;
  if (!from?.visible) {
    element.animate(
      [
        { opacity: 0, transform: `${rest === "none" ? "" : `${rest} `}scale(0.985)` },
        { opacity: 1, transform: rest },
      ],
      { duration: options.duration * 0.8, easing: options.easing },
    );
    return;
  }
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const sx = (from.width * from.scale) / Math.max(1, to.width);
  const sy = (from.height * from.scale) / Math.max(1, to.height);
  if (
    Math.abs(dx) < 0.5 &&
    Math.abs(dy) < 0.5 &&
    Math.abs(sx - to.scale) < 0.002 &&
    Math.abs(sy - to.scale) < 0.002
  ) {
    return;
  }
  element.animate(
    [
      { transform: `translate(${String(dx)}px, ${String(dy)}px) scale(${String(sx)}, ${String(sy)})` },
      { transform: rest },
    ],
    { duration: options.duration, easing: options.easing },
  );
}
