export type ReviewBlock = {
  strategy: "individual" | "matches_together";
  instructions: string;
  agent?: Record<string, string>;
  additional_context?: Record<string, boolean>;
  review_depth?: "lightweight";
};

export type StepArgument = {
  name: string;
  description: string;
  type: "string" | "file_path";
  review?: ReviewBlock;
  json_schema?: Record<string, unknown>;
};

export type StepInputRef = {
  argument_name: string;
  required: boolean;
};

export type StepOutputRef = {
  argument_name: string;
  required: boolean;
  review?: ReviewBlock;
};

export type SubWorkflowRef = {
  workflow_name: string;
  workflow_job?: string;
};

export type WorkflowStep = {
  name: string;
  instructions?: string;
  sub_workflow?: SubWorkflowRef;
  inputs: Record<string, StepInputRef>;
  outputs: Record<string, StepOutputRef>;
  process_requirements: Record<string, string>;
};

export type Workflow = {
  name: string;
  summary: string;
  steps: WorkflowStep[];
  agent?: string;
  common_job_info?: string;
  post_workflow_instructions?: string;
};

export type JobDefinition = {
  name: string;
  summary: string;
  step_arguments: StepArgument[];
  workflows: Record<string, Workflow>;
  job_dir: string;
};

export type JobLoadError = {
  job_name: string;
  job_dir: string;
  error: string;
};

export type WorkflowInfo = {
  name: string;
  summary: string;
  how_to_invoke: string;
};

export type JobInfo = {
  name: string;
  summary: string;
  workflows: WorkflowInfo[];
};

export type GetWorkflowsResponse = {
  jobs: JobInfo[];
  errors: JobLoadError[];
  issue_detected?: string;
};

export type Issue = {
  severity: "error" | "warning";
  job_name: string;
  job_dir: string;
  message: string;
  suggestion: string;
};
