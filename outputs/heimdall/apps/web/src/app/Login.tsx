// Sign-in: Heimdall's access token, printed by its launcher. Nothing else is reachable before it.
import { Button, Callout, Card, Field, Input } from "@factory/ui";
import { useState } from "react";
import { post } from "../lib/api";

export function Login({
  error,
  onSignedIn,
}: {
  error: string;
  onSignedIn: () => Promise<void>;
}) {
  const [token, setToken] = useState(""),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const message = failure || error;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10 text-fg">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-md bg-accent text-md font-bold text-on-accent"
          >
            H
          </span>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Sign in to Heimdall
            </h1>
            <p className="text-sm text-muted">
              Watch Sindri and Mimir together, for every project.
            </p>
          </div>
        </div>
        <Card>
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await post("login", { token });
                setToken("");
                setFailure("");
                await onSignedIn();
              } catch (err) {
                setFailure((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              label="Access token"
              term="Access token"
              hint="Printed in the terminal window that started Heimdall."
            >
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                required
              />
            </Field>
            {message && <Callout tone="danger">{message}</Callout>}
            <Button type="submit" variant="primary" size="lg" loading={busy}>
              Connect to factory
            </Button>
          </form>
        </Card>
        <p className="text-center text-xs text-muted">
          Loopback only. Credentials remain on this Mac.
        </p>
      </div>
    </main>
  );
}
