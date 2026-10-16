import type { SessionSummaryV1 } from "./contracts.js";

export type CustomCommand = { name: string; description: string; usage: string };

// Read-only CLI/daemon facts that Desktop may present without runtime authority.
export type ReportInput = {
  kind:
    | "status"
    | "agents"
    | "tools"
    | "tokens"
    | "skills"
    | "learning"
    | "mcp"
    | "graph"
    | "commands"
    | "command";
  sessionId?: string;
  commandName?: string;
  arguments?: string;
  toolView?: "status" | "list";
  graphView?: "status";
  agentFilter?: string;
  skillId?: string;
  proposalId?: string;
};

export type ReportValue =
  | { kind: "status"; session: SessionSummaryV1 }
  | { kind: "commands"; commands: CustomCommand[] }
  | { kind: "command"; prompt: string }
  | { kind: "agents"; activeAgentId: string | null; agents: { id: string; label: string }[] }
  | { kind: "tools"; tools: { name: string; enabled: boolean }[] }
  | { kind: "tools"; text: string }
  | { kind: "tokens"; text: string }
  | { kind: "skills"; agentId: string | null; skills: string[] }
  | { kind: "skills"; text: string }
  | { kind: "learning"; text: string }
  | { kind: "mcp"; text: string }
  | { kind: "graph"; text: string };
