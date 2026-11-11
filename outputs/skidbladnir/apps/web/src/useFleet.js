import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Local session token + the live snapshot stream. The stream is always fleet-wide: capacity is
 * shared, and the project scope is applied in the UI with the same `projectSnapshot` the API uses.
 */
export function useFleet() {
  const [data, setData] = useState(null);
  const [token, setToken] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  // One idempotency key per distinct request until it succeeds, so a retried click is not a
  // second launch or command.
  const requests = useRef(new Map());

  useEffect(() => {
    let live = true;
    let source;
    async function connect() {
      try {
        const res = await fetch('/api/session');
        if (!res.ok) throw new Error('Cannot establish local session.');
        const session = await res.json();
        if (!live) return;
        setToken(session.token);
        setSessionError('');
        source = new EventSource('/api/events');
        source.addEventListener('snapshot', (event) => {
          if (!live) return;
          setData(JSON.parse(event.data));
          setConnection('live');
        });
        source.onerror = () => {
          if (live) setConnection('reconnecting');
        };
      } catch (e) {
        if (live) {
          setSessionError(e.message);
          setConnection('offline');
        }
      }
    }
    connect();
    return () => {
      live = false;
      source?.close();
    };
  }, [attempt]);

  const reconnect = useCallback(() => {
    setConnection('connecting');
    setAttempt((n) => n + 1);
  }, []);

  /** POSTs with the session token; resolves to the JSON body, or throws the server's message. */
  const post = useCallback(
    async (path, body = {}) => {
      setBusy(true);
      const fingerprint = JSON.stringify([path, body]);
      if (!requests.current.has(fingerprint)) requests.current.set(fingerprint, crypto.randomUUID());
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Skidbladnir-Token': token,
            'Idempotency-Key': requests.current.get(fingerprint),
          },
          body: JSON.stringify(body),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Request failed.');
        requests.current.delete(fingerprint);
        return value;
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  return { data, token, sessionError, connection, reconnect, post, busy };
}
