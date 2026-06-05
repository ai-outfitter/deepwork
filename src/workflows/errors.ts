export class WorkflowRuntimeError extends Error {
  constructor(
    message: string,
    readonly errorType = "ToolError",
  ) {
    super(message);
    this.name = "WorkflowRuntimeError";
  }
}
