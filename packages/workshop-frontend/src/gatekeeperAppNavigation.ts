export const MAX_GATEKEEPER_APP_PROMPT_LENGTH = 4_000;
export const MAX_GATEKEEPER_APP_PATH_LENGTH = 512;

// A URL path with no query or fragment.
const APP_PATH_PATTERN = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

// A Durable Object ID string, which is what a workspace ID is.
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{64}$/;

export type GatekeeperAppWorkspaceTarget = { workspaceId: string; gadgetId?: number };

/**
 * Validates a workspace target arriving from a sandboxed gatekeeper app before the host navigates
 * to it. The app is untrusted input, so the shape is checked here rather than at the router.
 */
export function parseGatekeeperAppWorkspaceTarget(
  workspaceId: unknown,
  gadgetId: unknown,
): GatekeeperAppWorkspaceTarget {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  if (gadgetId === undefined) return { workspaceId };
  if (typeof gadgetId !== "number" || !Number.isSafeInteger(gadgetId) || gadgetId < 0) {
    throw new TypeError("Invalid gatekeeper app workspace target.");
  }
  return { workspaceId, gadgetId };
}

export function normalizeGatekeeperAppPrompt(value: string): string {
  if (typeof value !== "string") throw new TypeError("Gatekeeper app prompt must be text.");
  const prompt = value.trim();
  if (!prompt) throw new TypeError("Gatekeeper app prompt cannot be empty.");
  if (prompt.length > MAX_GATEKEEPER_APP_PROMPT_LENGTH) {
    throw new RangeError("Gatekeeper app prompt is too long.");
  }
  return prompt;
}

/**
 * Validates a path a sandboxed gatekeeper app asks to show below its own route, /gatekeepers/$appId.
 * Empty, `.` and `..` segments are refused so a URL parser cannot fold the path into another route.
 */
export function parseGatekeeperAppPath(path: unknown): string {
  if (typeof path !== "string" || path.length > MAX_GATEKEEPER_APP_PATH_LENGTH || !APP_PATH_PATTERN.test(path)) {
    throw new TypeError("Invalid gatekeeper app path.");
  }
  if (path === "/") return path;
  if (path.slice(1).split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("Invalid gatekeeper app path.");
  }
  return path;
}
