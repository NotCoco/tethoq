import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import RendererErrorBoundary, {
  installGlobalRendererFaultHandlers,
  reportRendererStartupFault,
} from "./RendererErrorBoundary";
import "./styles.css";
import "./navigation.css";
import "./workflow-settings.css";
import "./live-session.css";

installGlobalRendererFaultHandlers();

let root = document.getElementById("root");
if (root === null) {
  reportRendererStartupFault(new Error("Renderer root is missing"));
  root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
}

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);
