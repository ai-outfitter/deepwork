export type ReviewStrategy = "individual" | "matches_together" | "all_changed_files";
export type ReviewCadence = "change_cycle" | "pull_request";
export type ReviewCacheInvalidation = "file_content" | "changed_file_set";

export type ReferenceFile = {
  path: string;
  relativeLabel: string;
  description?: string;
};

export type ReviewRule = {
  name: string;
  description: string;
  includePatterns: string[];
  excludePatterns: string[];
  strategy: ReviewStrategy;
  cadence: ReviewCadence;
  cacheInvalidatesOn: ReviewCacheInvalidation;
  instructions: string;
  agent?: Record<string, string>;
  allChangedFilenames: boolean;
  unchangedMatchingFiles: boolean;
  precomputedInfoBashCommand?: string;
  sourceDir: string;
  sourceFile: string;
  sourceLine: number;
  referenceFiles: ReferenceFile[];
};

export type ReviewTaskNative = {
  ruleName: string;
  filesToReview: string[];
  instructions: string;
  agentName?: string;
  sourceLocation: string;
  additionalFiles: string[];
  allChangedFilenames?: string[];
  precomputedInfoBashCommand?: string;
  inlineContent?: string;
  referenceFiles: ReferenceFile[];
  cacheInvalidatesOn: ReviewCacheInvalidation;
};

export type DiscoveryError = {
  filePath: string;
  error: string;
};
