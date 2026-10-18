// Synthetic demo service only. Never connects to your real factory.
import { fixture } from "../tests/fixture.mjs";
import { startHeimdall } from "../apps/server/main.mjs";
const source = await fixture();
source.data.projects[0].name = "DEMO · Invoice library";
source.data.missions[0].objective = "DEMO · Build reliable invoice tools";
source.data.tasks.forEach((t) => {
  t.title = "DEMO · " + t.title;
});
const app = await startHeimdall({
  env: {
    HEIMDALL_PORT: process.env.HEIMDALL_PORT ?? "4322",
    HEIMDALL_DATA_DIR: ".heimdall/demo",
    MIMIR_URL: source.url,
    MIMIR_TOKEN: "fixture-token",
  },
});
console.log(
  `SYNTHETIC DEMO ONLY — ${app.url}\nAccess token: ${app.token}\nOperator code: ${app.operatorCode}`,
);
const timer = setInterval(() => source.emit(), 5000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(
    signal,
    () =>
      void (async () => {
        clearInterval(timer);
        await app.close();
        await source.close();
        process.exit(0);
      })(),
  );
