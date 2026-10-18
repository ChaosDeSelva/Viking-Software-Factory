import { startServer } from "./boot.js";

const s = await startServer(process.env, {
  overrides: {
    // The approval pairing code goes to this terminal only, never to the log (audit M9).
    approval: {
      onPairingCode: (code) =>
        process.stderr.write(
          `sindri approval pairing code: ${code} (enter it in the browser or at the \`sindri approve\` prompt to approve specs, plans and PRs; never give it to an agent)\n`,
        ),
    },
  },
});
s.app.log.info({ tokenPath: s.tokenPath }, `sindri server listening on ${s.url}`);
