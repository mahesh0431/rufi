import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { onReconnect, startSession } from "./api.ts";
import { queries } from "./reads.ts";
import { router } from "./router.tsx";
import "./styles.css";

// A new link opened in this tab changes only the fragment, which doesn't load
// the page again: load it, so the new link is used.
addEventListener("hashchange", () => {
  if (location.hash.includes("launch=")) location.reload();
});

// When Rufi can be reached again, what failed meanwhile is read again.
onReconnect(() => void queries.invalidateQueries());

const element = document.getElementById("root");
if (element === null) throw new Error("The page has no #root.");
const root = createRoot(element);

// The frame shows in any case: without a session it says so, and Emergency
// still works.
void startSession()
  .catch(() => false)
  .finally(() => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queries}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
