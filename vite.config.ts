import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API listens on 8787 unless API_PORT is set. src/server/index.ts reads the same variable.
const apiPort = process.env.API_PORT ?? "8787";

export default defineConfig({
  // The page lives in web/. Vite treats that folder as the site, and builds it into web/dist.
  root: "web",
  plugins: [react()],
  server: {
    // The page calls /api/... on its own address and Vite passes those calls on to the API.
    // The browser never makes a cross-origin request, so the API needs no CORS setup.
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
