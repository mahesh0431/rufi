import { Tooltip } from "@base-ui/react/tooltip";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { onReconnect } from "./api.ts";
import { onPhone } from "./phone.ts";
import { queries } from "./reads.ts";
import { router } from "./router.tsx";
import "./styles.css";

// A new link opened in this tab changes only the fragment, which doesn't load
// the page again: load it, so the new link is used.
addEventListener("hashchange", () => {
  if (location.hash.includes("launch=")) location.reload();
});

// In the Rufi app (apps/desktop), its windows add this mark to the user
// agent; the app's own look is in styles.css, under [data-app].
if (navigator.userAgent.endsWith(" RufiApp")) {
  document.documentElement.dataset["app"] = "";
}

// In Rufi's iPhone app, the page never zooms: an input's focus would, and the
// iPhone's Text Size replaces pinching. It fills the screen under the app's
// bars, which it pads itself by (src/phone.ts).
if (onPhone) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover",
    );
}

// When Rufi can be reached again, what failed meanwhile is read again.
onReconnect(() => void queries.invalidateQueries());

const element = document.getElementById("root");
if (element === null) throw new Error("The page has no #root.");
const root = createRoot(element);

// The frame shows at once; reads wait for the session (api.ts).
root.render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      {/* One after another, icon buttons' tooltips show without a wait. */}
      <Tooltip.Provider>
        <RouterProvider router={router} />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
