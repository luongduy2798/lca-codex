import { describe, expect, test } from "bun:test";
import {
  dependencyAdvisories,
  lockedPackages,
  mergeLockedPackages,
} from "../scripts/audit-dependencies";

const lockfile = (packages: Record<string, unknown>) => JSON.stringify({ packages });

describe("dependency audit lock coverage", () => {
  test("merges resolved versions from multiple lockfile snapshots", () => {
    const root = lockedPackages(lockfile({
      zod: ["zod@4.4.3"],
      "zod@3.25.76": ["zod@3.25.76"],
    }), "bun.lock");
    const additional = lockedPackages(lockfile({
      "@types/node": ["@types/node@26.1.2"],
    }), "additional.lock");

    mergeLockedPackages(root, additional);

    expect([...root.get("zod")!].sort()).toEqual(["3.25.76", "4.4.3"]);
    expect([...root.get("@types/node")!]).toEqual(["26.1.2"]);
  });

  test("fails closed for an unsupported lockfile resolution", () => {
    expect(() => lockedPackages(lockfile({ local: ["workspace:local"] }), "bun.lock"))
      .toThrow("unsupported package resolution");
  });

  test("retains actionable advisory details and audited versions", () => {
    const packages = new Map([["zod", new Set(["4.4.3"])]]);
    expect(dependencyAdvisories({
      zod: [{ severity: "high", title: "Example advisory", url: "https://example.test/advisory" }],
    }, packages)).toEqual([{
      packageName: "zod",
      versions: ["4.4.3"],
      severity: "high",
      title: "Example advisory",
      url: "https://example.test/advisory",
    }]);
  });
});
