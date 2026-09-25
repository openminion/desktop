// Read-only CLI/daemon facts that Desktop may present without runtime authority.
export type ReportInput = {
  kind: "agents" | "tools" | "tokens" | "skills" | "mcp" | "graph";
  sessionId?: string;
  agentFilter?: string;
  agentId?: string;
  skillId?: string;
};

export type ReportValue =
  | { kind: "agents"; agents: { id: string; label: string }[] }
  | { kind: "tools"; tools: { name: string; enabled: boolean }[] }
  | { kind: "tokens"; text: string }
  | { kind: "skills"; text: string }
  | { kind: "mcp"; text: string }
  | { kind: "graph"; text: string };
