import { spawn } from "node:child_process";

export class GitDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDiffError";
  }
}

export async function getChangedFiles(projectRoot: string, baseRef?: string): Promise<string[]> {
  const base = baseRef ?? await detectBaseRef(projectRoot);
  const mergeBase = base === "HEAD" ? "HEAD" : await getMergeBase(projectRoot, base);
  const diffFiles = await gitDiffNameOnly(projectRoot, mergeBase);
  const stagedFiles = await gitDiffNameOnly(projectRoot, undefined, true);
  const untrackedFiles = await gitLines(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...diffFiles, ...stagedFiles, ...untrackedFiles])].sort();
}

export async function getLastCommitFiles(projectRoot: string): Promise<string[]> {
  return gitLines(projectRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACMR", "HEAD"]);
}

async function detectBaseRef(projectRoot: string): Promise<string> {
  try {
    const fullRef = (await git(projectRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    const shortRef = fullRef.replace(/^refs\/remotes\//, "");
    await git(projectRoot, ["rev-parse", "--verify", shortRef]);
    return shortRef;
  } catch {
    // Continue through fallback refs when the remote HEAD is unavailable.
  }

  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    try {
      await git(projectRoot, ["rev-parse", "--verify", ref]);
      return ref;
    } catch {
      // Try the next conventional base ref.
    }
  }
  return "HEAD";
}

async function getMergeBase(projectRoot: string, ref: string): Promise<string> {
  try {
    return (await git(projectRoot, ["merge-base", "HEAD", ref])).trim();
  } catch (error) {
    throw new GitDiffError(`Failed to find merge-base with '${ref}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function gitDiffNameOnly(projectRoot: string, ref?: string, staged = false): Promise<string[]> {
  const args = ["diff", "--name-only", "--diff-filter=ACMR"];
  if (staged) args.push("--cached");
  if (ref) args.push(ref);
  return gitLines(projectRoot, args);
}

async function gitLines(projectRoot: string, args: string[]): Promise<string[]> {
  const output = await git(projectRoot, args);
  return output.trim().split("\n").filter(Boolean);
}

function git(projectRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(new GitDiffError(error.message)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new GitDiffError(stderr.trim() || `git ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}
