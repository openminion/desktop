// Editable profile fields; stored credentials never cross into the renderer.
export const TOOL_CREDENTIALS = [
  ["BRAVE_API_KEY", "Brave Search"],
  ["SERPAPI_API_KEY", "SerpAPI"],
  ["SERPER_API_KEY", "Serper"],
  ["TAVILY_API_KEY", "Tavily"],
  ["FIRECRAWL_API_KEY", "Firecrawl"],
  ["TINYFISH_API_KEY", "TinyFish"],
] as const;

export type AgentProfile = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  keyConfigured: boolean;
};

export type ProfileSettings = {
  setupRequired: boolean;
  revision: string;
  defaultAgent: string;
  agents: AgentProfile[];
  credentials: { name: string; configured: boolean }[];
};

export type SetupPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
};

export type ProfileSetupInput = {
  revision: string;
  // Present only when creating an additional profile; existing IDs are rejected.
  agentId?: string;
  presetId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  checkProvider: boolean;
};

export type ProviderCheckStatus = "verified" | "not_requested";

export type ProfileSetupResult = {
  settings: ProfileSettings;
  providerCheck: ProviderCheckStatus;
};

export type ProfileSaveInput = {
  revision: string;
  agentId: string;
  model: string;
  baseUrl: string;
  makeDefault: boolean;
  // Omitted means keep; null removes the saved value.
  apiKey?: string | null;
  credentials: Record<string, string | null>;
};
