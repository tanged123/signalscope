import { SESSION_SCHEMA_VERSION, type Session } from "../generated/session";

export function parseBakedSession(sessionJson: string): Session {
  const parsed = JSON.parse(sessionJson) as {
    app?: unknown;
    schema_version?: unknown;
  };
  if (parsed.app !== "signalscope") {
    throw new Error(
      `snapshot session has unexpected app: ${String(parsed.app)}`,
    );
  }
  if (parsed.schema_version !== SESSION_SCHEMA_VERSION) {
    throw new Error(
      `snapshot session schema ${String(parsed.schema_version)} does not match this build (${String(SESSION_SCHEMA_VERSION)})`,
    );
  }
  return parsed as Session;
}
