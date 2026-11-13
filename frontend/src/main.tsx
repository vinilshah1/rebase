import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

// One editor/socket lifecycle per mount; intentionally no StrictMode.
createRoot(root).render(<App />);
