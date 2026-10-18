// Ignores SIGTERM and starts a descendant that leaves the process group while
// holding stdout/stderr (like a daemon started with setsid), then waits.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => {});
const escapee = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
escapee.unref();
console.log("stubborn started");
writeFileSync("pids", `${process.pid} ${escapee.pid}`);
setInterval(() => {}, 1000);
