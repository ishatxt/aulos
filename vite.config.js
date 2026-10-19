import { defineConfig } from "vite";

// base "./" keeps every generated URL relative to the page, so the production
// build works both at a domain root and inside a GitHub Pages subpath such as
// https://<user>.github.io/aulos/. Vite dev server behaves as before.
export default defineConfig({
  base: "./",
});
