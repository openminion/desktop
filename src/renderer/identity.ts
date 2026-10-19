const SOURCE_LABELS: Record<string, string> = {
  yaml: "Direct YAML",
  bundle: "Markdown bundle",
  default: "Built-in default",
  unknown: "Unknown",
};

const STATUS_LABELS: Record<string, string> = {
  clean: "In sync",
  drifted: "Changed",
  missing: "Missing",
  invalid: "Invalid",
  not_applicable: "Not applicable",
  unknown: "Unknown",
};

export function identitySourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? "Unknown";
}

export function identityStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Unknown";
}
