import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// index.html has one empty <div id="root">. React draws the whole page inside it.
const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html has no element with the id root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
