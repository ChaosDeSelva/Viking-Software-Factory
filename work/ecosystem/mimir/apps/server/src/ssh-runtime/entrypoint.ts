import { fileURLToPath } from "node:url";
import { run } from "./remote.js";

void run(process.argv, process.stdin, fileURLToPath(import.meta.url));
