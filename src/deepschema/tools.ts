import { basename, dirname } from "node:path";
import type { JsonValue } from "../bridge.js";
import { findNamedSchemas, parseDeepSchemaFile } from "./discovery.js";

export async function getNamedSchemasNative(projectRoot: string): Promise<JsonValue> {
  const results: Array<{ name: string; summary: string; matchers: string[] }> = [];
  for (const manifestPath of await findNamedSchemas(projectRoot)) {
    const name = basename(dirname(manifestPath));
    try {
      const schema = await parseDeepSchemaFile(manifestPath, "named", name);
      results.push({
        name: schema.name,
        summary: schema.summary ?? "",
        matchers: schema.matchers,
      });
    } catch {
      results.push({
        name,
        summary: `(failed to parse ${manifestPath})`,
        matchers: [],
      });
    }
  }
  return results;
}
