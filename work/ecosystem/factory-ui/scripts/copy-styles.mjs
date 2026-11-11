// dist/styles.css is Tailwind v4 source: the app's Tailwind compiles it and, via its
// `@source "."`, scans dist/index.js for the utilities the components use.
import { copyFileSync } from "node:fs";
copyFileSync(
  new URL("../src/styles.css", import.meta.url),
  new URL("../dist/styles.css", import.meta.url),
);
