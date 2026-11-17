import { useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent } from "react";

export interface MenuItem {
  readonly label: string;
  readonly action: () => void;
  readonly disabled?: boolean;
  /** Draw a divider above this item. */
  readonly separated?: boolean;
}

export interface MenuState {
  readonly items: readonly MenuItem[];
  readonly x: number;
  readonly y: number;
  /** Element to refocus when the menu closes. */
  readonly origin: HTMLElement | null;
}

/** A small context menu: arrow keys move, Enter runs, Escape or an outside press closes. */
export function Menu({
  menu,
  onClose,
}: {
  readonly menu: MenuState;
  readonly onClose: () => void;
}): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) {
      return;
    }
    // Keep the menu inside the window.
    const bounds = node.getBoundingClientRect();
    const left = Math.max(8, Math.min(menu.x, globalThis.innerWidth - bounds.width - 8));
    const top = Math.max(8, Math.min(menu.y, globalThis.innerHeight - bounds.height - 8));
    node.style.left = `${String(left)}px`;
    node.style.top = `${String(top)}px`;
    node.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [menu]);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (!element.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const blur = (): void => onClose();
    document.addEventListener("pointerdown", outside, true);
    globalThis.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      globalThis.removeEventListener("blur", blur);
    };
  }, [onClose]);
  const close = (refocus: boolean): void => {
    onClose();
    if (refocus) {
      menu.origin?.focus();
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [
      ...(element.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") {
      move(index + 1);
    } else if (event.key === "ArrowUp") {
      move(index - 1);
    } else if (event.key === "Home") {
      move(0);
    } else if (event.key === "End") {
      move(items.length - 1);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  return (
    <div
      ref={element}
      className="mp-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={keyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item, index) => (
        <button
          key={`${String(index)}:${item.label}`}
          type="button"
          role="menuitem"
          className={item.separated ? "mp-menu-item is-separated" : "mp-menu-item"}
          disabled={item.disabled}
          tabIndex={-1}
          onClick={() => {
            close(true);
            item.action();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
