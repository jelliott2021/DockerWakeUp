/**
 * Small helpers shared across the wake proxy.
 */

/** Human-readable message for anything thrown or rejected. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e && typeof e.message === "string") {
    return e.message;
  }
  return String(e);
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
