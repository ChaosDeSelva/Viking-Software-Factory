import "./fixture-agent.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const root = resolve(dirname(process.env.SINDRI_ACCEPTANCE_MIMIR_MAIN), "../../..");
const { FakeRuntime } = await import(
  pathToFileURL(join(root, "packages/fake-runtime/dist/index.js"))
);
const { Brokkr } = await import(
  pathToFileURL(join(root, "apps/server/node_modules/@brokkr/sdk/dist/index.js"))
);
async function pauseAt(stage, workspace) {
  const marker = join(process.env.MIMIR_DATA_DIR, "hello-" + stage);
  if (existsSync(marker + ".continue")) return;
  writeFileSync(marker + ".started", workspace);
  const deadline = Date.now() + 60_000;
  while (!existsSync(marker + ".continue")) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting to continue hello-" + stage);
    await delay(25);
  }
}
const verify = Brokkr.prototype.verify;
Brokkr.prototype.verify = async function (options) {
  await pauseAt("verify", options.workspace);
  return verify.call(this, options);
};
const start = FakeRuntime.prototype.createSession;
const check = `
test("uses world for missing or blank names and trims surrounding whitespace", async (t) => {
  const base = await listen(t, greeter());
  for (const [query, expected] of [["", "world"], ["?name=", "world"], ["?name=++", "world"], ["?name=+Ada+", "Ada"]]) {
    const response = await fetch(base + "/greet" + query);
    assert.deepEqual(await response.json(), {message: "Hello, " + expected + "!"});
  }
});
`;
FakeRuntime.prototype.createSession = async function (spec) {
  if (spec.argv.join(" ").includes("Role: implementer")) {
    const tests = join(spec.cwd, "services/greeter/server.test.mjs");
    const src = join(spec.cwd, "services/greeter/server.mjs");
    const previous = readFileSync(tests, "utf8");
    if (!previous.includes(check)) {
      await pauseAt("build", spec.cwd);
      writeFileSync(tests, previous + check);
      let failed = false;
      try {
        execFileSync(process.execPath, ["--test", tests], { cwd: spec.cwd, stdio: "pipe" });
      } catch (e) {
        if (!String(e.stdout).includes("Hello, null!")) throw e;
        failed = true;
      }
      if (!failed)
        throw new Error("The greeting regression test must fail on the unmodified greeter");
      const original = readFileSync(src, "utf8");
      const updated = original.replace(
        'const name = url.searchParams.get("name");',
        'const name = url.searchParams.get("name")?.trim() || "world";',
      );
      if (original === updated) throw new Error("The hello-factory fixture has changed");
      writeFileSync(src, updated);
    }
  }
  return start.call(this, spec);
};
