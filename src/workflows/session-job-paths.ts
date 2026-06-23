import { join } from "node:path";

export type SessionJobIdentity = {
  sessionId?: string;
  agentId?: string;
};

export function sessionJobFolders(projectRoot: string, identity: SessionJobIdentity = {}): string[] {
  if (!identity.sessionId) return [];
  return [sessionJobsDir(projectRoot, identity)];
}

export function sessionJobsDir(projectRoot: string, identity: SessionJobIdentity): string {
  const sessionId = safeSessionId(identity.sessionId);
  return join(projectRoot, ".deepwork", "tmp", "sessions", "pi", `session-${sessionId}`, "jobs");
}

function safeSessionId(sessionId: string | undefined): string {
  if (!sessionId || sessionId.trim() === "") throw new Error("session_id is required for session job storage");
  if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
    throw new Error("session_id must not contain path separators or traversal sequences");
  }
  return sessionId;
}
