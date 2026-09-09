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
  revision: string;
  defaultAgent: string;
  agents: AgentProfile[];
  credentials: { name: string; configured: boolean }[];
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
