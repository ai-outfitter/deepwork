import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const testRoot = join(process.cwd(), "test");

describe("requirement traceability comments", () => {
  // Covers PI-REQ-003.12.4 and the project convention that requirement tests name their covered PI-REQ IDs.
  it("requires every test case to have a nearby PI-REQ traceability comment", async () => {
    const testFiles = (await readdir(testRoot))
      .filter((name) => name.endsWith(".test.ts"))
      .filter((name) => name !== "requirement-comment-lint.test.ts");

    const missing: string[] = [];
    for (const file of testFiles) {
      const source = await readFile(join(testRoot, file), "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!/^\s*it(?:\.each)?\(/.test(line)) return;
        const nearby = lines.slice(Math.max(0, index - 3), index).join("\n");
        if (!nearby.includes("PI-REQ-")) missing.push(`${file}:${index + 1}`);
      });
    }

    expect(missing).toEqual([]);
  });
});
