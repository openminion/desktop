// Read-only CLI/daemon facts that Desktop may present without runtime authority.
export type ReportInput = {
  kind: "agents" | "tools" | "tokens";
  sessionId?: string;
  agentFilter?: string;
};

export type ReportValue =
  | { kind: "agents"; agents: { id: string; label: string }[] }
  | { kind: "tools"; tools: { name: string; enabled: boolean }[] }
  | { kind: "tokens"; text: string };
