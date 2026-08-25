import type { CodexTool } from "../types";

export type AgentSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean };

export interface AgentTurnEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: AgentSandboxPolicy;
  tools: CodexTool[];
}

/**
 * Generic Responses tools are owned and executed by the authenticated outer harness. LCA Token
 * keeps the exact registry but deliberately grants itself no local filesystem or network access.
 */
export function agentTurnEnvironment(tools: CodexTool[]): AgentTurnEnvironment {
  return {
    cwd: "/",
    roots: [],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools,
  };
}
