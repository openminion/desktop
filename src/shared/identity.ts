export type IdentityRenderView = {
  text: string;
  purpose: string;
  profileVersion: string;
  renderVersion: string;
  includedFields: string[];
  omittedFields: string[];
};

export type IdentityProfileView = {
  agentId: string;
  displayName: string;
  source: string;
  editable: boolean;
  readOnlyReason: string | null;
  authoredYaml: string | null;
  profileRevision: number;
  profileVersion: string;
  sourceSha256: string | null;
  validationOk: boolean;
  sourceStatus: string;
  verificationIssues: string[];
  generatedStatus: string;
  generatedFiles: string[];
  render: IdentityRenderView;
};

export type IdentitySettings = { profiles: IdentityProfileView[] };

export type IdentityValidation = {
  agentId: string;
  validationOk: boolean;
  issues: string[];
  render: IdentityRenderView | null;
};

export type IdentityVerifyInput = { yaml: string };

export type IdentitySaveInput = {
  yaml: string;
  expectedProfileVersion: string;
  expectedSourceSha256: string;
};
