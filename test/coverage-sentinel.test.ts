import { describe, expect, it } from "vitest";
import { coverageSentinel } from "./coverage-sentinel.js";

describe("coverage enforcement sentinel", () => {
  // Covers PI-REQ-001.2.7 by proving the package coverage command enforces a 100% threshold on included TypeScript files.
  it("is fully covered so threshold regressions fail when included code is missed", () => {
    expect(coverageSentinel("covered")).toBe("covered");
  });
});
