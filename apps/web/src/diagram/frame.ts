// The diagram frame (public/diagram.html, built to dist/diagram/diagram.js):
// draws one Mermaid diagram from its address and tells the screens its
// height. Mermaid lays a diagram out with inline styles, which the screens'
// policy refuses, so it runs here: a frame in an opaque origin, under a
// policy of its own (only this script, no network), that can't reach Rufi.
// The diagram can't change how it is drawn: no theme, styles or HTML labels
// of its own (Mermaid drops `secure` keys from a diagram's own settings).
import mermaid from "mermaid";
import type { DiagramAnswer, DiagramAsk } from "./message.ts";

/** Settings a diagram's own front matter or directives may not change. */
const LOCKED = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "fontFamily",
  "altFontFamily",
  "htmlLabels",
  "dompurifyConfig",
  "look",
];

function tell(drawn: boolean): void {
  const answer: DiagramAnswer = {
    type: "rufi-diagram",
    drawn,
    height: Math.ceil(document.documentElement.getBoundingClientRect().height),
  };
  // Only a height and whether it drew: nothing the page's origin must keep.
  parent.postMessage(answer, "*");
}

async function draw(): Promise<void> {
  const { source, colours, font, dark } = JSON.parse(
    decodeURIComponent(location.hash.slice(1)),
  ) as DiagramAsk;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    suppressErrorRendering: true,
    theme: "base",
    themeCSS: "",
    fontFamily: font,
    themeVariables: {
      darkMode: dark,
      fontFamily: font,
      fontSize: "13px",
      background: colours.surface,
      mainBkg: colours["accent-soft"],
      primaryColor: colours["accent-soft"],
      primaryBorderColor: colours.accent,
      nodeBorder: colours.accent,
      primaryTextColor: colours.ink,
      secondaryColor: colours.side,
      tertiaryColor: colours.surface,
      textColor: colours.ink,
      titleColor: colours.ink,
      lineColor: colours.muted,
      clusterBkg: colours.side,
      clusterBorder: colours.line,
      edgeLabelBackground: colours.surface,
    },
    secure: LOCKED,
  });
  try {
    const { svg } = await mermaid.render("diagram", source);
    document.body.innerHTML = svg;
    tell(true);
    // A narrower chat scales the diagram down: its height changes too.
    new ResizeObserver(() => {
      tell(true);
    }).observe(document.body);
  } catch {
    tell(false);
  }
}

void draw();
