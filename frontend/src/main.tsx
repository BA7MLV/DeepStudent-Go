import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./shell.css";
import { App } from "./App";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
