import { describe, expect, test } from "bun:test";
import {
  dependencyAdvisories,
  lockedPackages,
  mergeLockedPackages,
} from "../scripts/audit-dependencies";

const lockfile = (packages: Record<string, unknown>) => JSON.stringify({ packages });

describe("dependency audit lock coverage", () => {
  test("merges every resolved version from root and launcher lockfiles", () => {
    const root = lockedPackages(lockfile({
      zod: ["zod@4.4.3"],
      "zod@3.25.76": ["zod@3.25.76"],
    }), "bun.lock");
    const launcher = lockedPackages(lockfile({
      electron: ["electron@41.10.4"],
      "@types/node": ["@types/node@26.1.2"],
    }), "launcher/bun.lock");

    mergeLockedPackages(root, launcher);

    expect([...root.get("zod")!].sort()).toEqual(["3.25.76", "4.4.3"]);
    expect([...root.get("electron")!]).toEqual(["41.10.4"]);
    expect([...root.get("@types/node")!]).toEqual(["26.1.2"]);
  });

  test("fails closed for an unsupported lockfile resolution", () => {
    expect(() => lockedPackages(lockfile({ local: ["workspace:local"] }), "bun.lock"))
      .toThrow("unsupported package resolution");
  });

  test("retains actionable advisory details and audited versions", () => {
    const packages = new Map([["electron", new Set(["41.7.1"])]]);
    expect(dependencyAdvisories({
      electron: [{ severity: "high", title: "Sandbox bypass", url: "https://example.test/advisory" }],
    }, packages)).toEqual([{
      packageName: "electron",
      versions: ["41.7.1"],
      severity: "high",
      title: "Sandbox bypass",
      url: "https://example.test/advisory",
    }]);
  });
});
