export type DeepSchema = {
  name: string;
  schemaType: "named" | "anonymous";
  sourcePath: string;
  requirements: Record<string, string>;
  parentDeepSchemas: string[];
  jsonSchemaPath?: string;
  verificationBashCommand: string[];
  summary?: string;
  instructions?: string;
  examples: Array<{ path: string; description: string }>;
  references: Array<{ path: string; description: string }>;
  matchers: string[];
};

export type DeepSchemaDiscoveryError = {
  filePath: string;
  error: string;
};
