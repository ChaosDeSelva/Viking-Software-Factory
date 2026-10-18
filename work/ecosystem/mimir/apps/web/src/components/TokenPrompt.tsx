import { useEffect, useId, useRef, useState, type FormEvent } from "react";

/** Asks once for the server auth token. The token is kept in sessionStorage by the caller. */
export function TokenPrompt({
  onSubmit,
  rejected = false,
}: {
  onSubmit: (token: string) => void;
  rejected?: boolean;
}) {
  const [value, setValue] = useState("");
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim().length > 0) onSubmit(value.trim());
  };
  return (
    <main id="main" className="mx-auto mt-16 max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">Connect to Mimir</h1>
      {rejected && (
        <p
          role="alert"
          className="mb-3 rounded border border-red-700 bg-red-50 p-2 text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          The server rejected that token. Enter it again.
        </p>
      )}
      <form onSubmit={submit} className="space-y-3">
        <label htmlFor={id} className="block font-medium">
          Auth token
        </label>
        <input
          id={id}
          ref={inputRef}
          type="password"
          autoComplete="off"
          className="input w-full"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-sm text-zinc-700 dark:text-zinc-300">
          The server prints where the token lives at startup (default{" "}
          <code>~/.mimir/auth-token</code>). It is kept for this tab only (sessionStorage) and never
          put in the URL.
        </p>
        <button type="submit" className="btn btn-primary">
          Connect
        </button>
      </form>
    </main>
  );
}
