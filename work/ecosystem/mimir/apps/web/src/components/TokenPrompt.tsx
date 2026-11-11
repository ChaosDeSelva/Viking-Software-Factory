import { Button, Callout, Card, Field, Input } from "@factory/ui";
import { useEffect, useRef, useState, type FormEvent } from "react";

/** Asks once for the server auth token. The token is kept in sessionStorage by the caller. */
export function TokenPrompt({
  onSubmit,
  rejected = false,
}: {
  onSubmit: (token: string) => void;
  rejected?: boolean;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim().length > 0) onSubmit(value.trim());
  };
  return (
    <main
      id="main"
      className="flex min-h-dvh items-start justify-center bg-canvas px-4 py-16 text-fg"
    >
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-md bg-accent text-lg font-bold text-on-accent"
          >
            M
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">Connect to Mimir</h1>
        </div>
        <Card>
          <form onSubmit={submit} className="flex flex-col gap-field">
            {rejected && (
              <Callout tone="danger">The server rejected that token. Enter it again.</Callout>
            )}
            <Field
              label="Auth token"
              hint={
                <>
                  The server prints where the token lives at startup (default{" "}
                  <code>~/.mimir/auth-token</code>). It is kept for this tab only (sessionStorage)
                  and never put in the URL.
                </>
              }
            >
              <Input
                ref={inputRef}
                type="password"
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            <div>
              <Button type="submit" variant="primary">
                Connect
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </main>
  );
}
