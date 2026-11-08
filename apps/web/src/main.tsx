import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import "./styles.css";
import { registerServiceWorker } from "./lib/push.ts";
import { applySavedTheme } from "./lib/theme.ts";
import { createApp } from "./router.tsx";

applySavedTheme();
registerServiceWorker();
const { router, queryClient } = createApp();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
