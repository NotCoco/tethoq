import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./navigation.css";
import "./workflow-settings.css";
import "./live-session.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
