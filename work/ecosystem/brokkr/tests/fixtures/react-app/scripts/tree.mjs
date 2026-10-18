// Spawns a grandchild `sleep 60`, records both pids and waits forever.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn("sleep", ["60"], { stdio: "ignore" });
// Print before recording pids: tests interrupt as soon as the pids file appears.
console.log("tree started");
writeFileSync("pids", `${process.pid} ${child.pid}`);
setInterval(() => {}, 1000);
