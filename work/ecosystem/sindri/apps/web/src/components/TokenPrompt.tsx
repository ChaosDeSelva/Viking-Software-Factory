import { useState } from "react";
import { TOKEN_KEY, useStore } from "../store/context.js";
import { NoticeRegion } from "./Layout.js";
import { Button, Card, Field, inputClass } from "./ui.js";

/** Sign-in: the API token, kept in this tab's sessionStorage only. */
export function TokenPrompt() {
  const { dispatch } = useStore();
  const [token, setToken] = useState("");
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-fg">
      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 py-16">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-md bg-accent text-md font-bold text-on-accent"
          >
            S
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Sindri</h1>
        </div>
        <NoticeRegion />
        <Card title="Sign in" term="Access token" description="Sindri plans work for the factory.">
          <form
            className="flex flex-col gap-field"
            onSubmit={(e) => {
              e.preventDefault();
              const t = token.trim();
              if (!t) return;
              // Write before dispatch so the first requests already carry the token.
              sessionStorage.setItem(TOKEN_KEY, t);
              dispatch({ type: "token/set", token: t });
            }}
          >
            <Field
              label="API token"
              id="token"
              hint="Copy it from ~/.sindri/auth-token (or $SINDRI_DATA_DIR/auth-token). It is kept in this tab's sessionStorage only."
            >
              <input
                id="token"
                type="password"
                autoComplete="off"
                aria-describedby="token-hint"
                className={inputClass}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
              />
            </Field>
            <div>
              <Button
                type="submit"
                {...(!token.trim() ? { disabledReason: "Paste the token first" } : {})}
              >
                Connect
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
}
