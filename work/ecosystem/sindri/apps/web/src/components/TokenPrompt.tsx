import { useState } from "react";
import { TOKEN_KEY, useStore } from "../store/context.js";
import { NoticeRegion } from "./Layout.js";
import { Button, Field, inputClass } from "./ui.js";

export function TokenPrompt() {
  const { dispatch } = useStore();
  const [token, setToken] = useState("");
  return (
    <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <main className="mx-auto max-w-lg space-y-4 px-4 py-16">
        <h1 className="text-3xl font-semibold">Sindri</h1>
        <NoticeRegion />
        <form
          className="space-y-3"
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
          <Button type="submit" disabled={!token.trim()}>
            Connect
          </Button>
        </form>
      </main>
    </div>
  );
}
