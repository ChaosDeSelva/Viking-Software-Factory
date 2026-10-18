// Mirrors Mimir's mission state transitions; the server remains authoritative.
export function canControlMission(status: string, action: string): boolean {
  if (action === "pause") return status === "active";
  if (action === "resume") return status === "paused";
  if (action === "cancel") return ["draft", "active", "paused"].includes(status);
  return false;
}
