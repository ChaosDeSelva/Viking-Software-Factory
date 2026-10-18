import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2] ?? "ran", "1");
