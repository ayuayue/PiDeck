import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import "./styles.css";

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
  window.piDesktop?.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

window.addEventListener("error", (event) => {
  writeStartupLog("error", "Renderer startup uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  writeStartupLog("error", "Renderer startup unhandled rejection", {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

writeStartupLog("info", "Renderer bootstrap started", {
  url: window.location.href,
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  writeStartupLog("error", "Renderer root element missing");
  throw new Error("Renderer root element missing");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  writeStartupLog("info", "Renderer React tree mounted");
});
