// A reply's visual: the AI's HTML, drawn in a frame of the core's visual
// page (apps/server/src/server/visual-frame.ts, ADR 0034), which loads and
// sends nothing and can't reach Rufi's page or session. The screen sends it
// the HTML when the frame loads, and Rufi's theme then and on each change;
// it reads back only the visual's height and that part of it didn't load,
// from that frame alone. Until its height comes, and while its block is
// written, a quiet box holds its place; a change of height above what you
// read keeps your place (KeepPlace, from the transcript).
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const FRAME = "/visual-frame.html";
/** The tallest a visual is drawn; a taller one scrolls inside. */
const TALLEST = 800;
/** The box that holds a visual's place until its height comes. */
const WAITING = 160;
/** Rufi's theme, by its own names (packages/brand/tokens.css). */
const TOKENS = [
  "--page",
  "--surface",
  "--side",
  "--line",
  "--ink",
  "--muted",
  "--accent",
  "--accent-soft",
  "--accent-ink",
  "--on-accent",
  "--font-ui",
];

/** Moves the view by `change` when `node` is above what you read. */
export const KeepPlace = createContext<(node: Element, change: number) => void>(
  () => undefined,
);

/** Rufi's theme where the visual is: its colours, font and text size. */
function themeAt(element: Element) {
  const style = getComputedStyle(element);
  return {
    scheme:
      document.documentElement.dataset["theme"] === "dark" ? "dark" : "light",
    fontSize: style.fontSize,
    variables: Object.fromEntries(
      TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]),
    ),
  };
}

/** A visual's place while its block is written. */
export function VisualWaiting() {
  return (
    <div
      className="visual rounded-lg bg-side"
      style={{ height: WAITING }}
      aria-hidden
    />
  );
}

export function Visual({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  const [height, setHeight] = useState<number>();
  const [broken, setBroken] = useState(false);
  const keepPlace = use(KeepPlace);

  useEffect(() => {
    const heard = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const { type, height: told } = data as {
        type?: unknown;
        height?: unknown;
      };
      if (
        type === "rufi-visual-height" &&
        typeof told === "number" &&
        Number.isFinite(told)
      ) {
        setHeight(Math.min(TALLEST, Math.max(0, Math.ceil(told))));
      } else if (type === "rufi-visual-broken") {
        setBroken(true);
      }
    };
    addEventListener("message", heard);
    // A new theme, colour or text size reaches a visual already drawn.
    const changes = new MutationObserver(() => {
      if (loads.current === 0 || !box.current) return;
      frame.current?.contentWindow?.postMessage(
        { type: "rufi-visual-theme", theme: themeAt(box.current) },
        "*",
      );
    });
    changes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-colour", "data-text-size", "style"],
    });
    return () => {
      removeEventListener("message", heard);
      changes.disconnect();
    };
  }, []);

  const shown = height ?? WAITING;
  const before = useRef(shown);
  useLayoutEffect(() => {
    if (box.current && before.current !== shown) {
      keepPlace(box.current, shown - before.current);
    }
    before.current = shown;
  }, [shown, keepPlace]);

  return (
    <div ref={box} className="visual">
      <iframe
        ref={frame}
        src={FRAME}
        title="Visual"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={`block w-full rounded-lg border-0 ${height === undefined ? "bg-side" : ""}`}
        style={{ height: shown }}
        onLoad={() => {
          // On every load: a frame the browser loaded again (as when it
          // moves in the page) is empty until it gets the visual again. A
          // visual already written in takes no second one.
          if (!box.current) return;
          loads.current += 1;
          frame.current?.contentWindow?.postMessage(
            { type: "rufi-visual", html, theme: themeAt(box.current) },
            "*",
          );
        }}
      />
      {/* A drawn visual of no height is blank: it says so too. */}
      {(broken || height === 0) && (
        <p className="mt-1 text-muted">Part of this visual didn't load</p>
      )}
    </div>
  );
}
