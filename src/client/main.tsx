import { StrictMode } from "react";
import { config as configureZod } from "zod/v4/core";
import { createRoot } from "react-dom/client";
import { browserSupportsRequiredFeatures } from "./browser-support";
import { Startup } from "./startup";
import { RenderBoundary } from "./RenderBoundary";
import "./startup.css";
import { installClientTelemetry } from "./telemetry";
import { installChunkRecovery } from "./chunk-recovery";

// The browser policy forbids dynamic code, including Zod's caught capability probe.
// Configure before Startup lazily loads the editor and its validation schemas.
configureZod({ jitless: true });

installClientTelemetry();
installChunkRecovery();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void (async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      } catch (error) {
        console.error("Could not prepare offline app shell", error);
      }
    })();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RenderBoundary label="The workspace could not be displayed">
      <Startup supported={browserSupportsRequiredFeatures()} />
    </RenderBoundary>
  </StrictMode>,
);
