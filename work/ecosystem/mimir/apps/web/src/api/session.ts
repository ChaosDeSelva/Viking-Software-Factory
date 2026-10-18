import { createContext, useContext } from "react";

export interface SessionValue {
  /** Forget the stored token and return to the token prompt. */
  signOut: () => void;
}

export const SessionContext = createContext<SessionValue>({ signOut: () => undefined });

export function useSession(): SessionValue {
  return useContext(SessionContext);
}
