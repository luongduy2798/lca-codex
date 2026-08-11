import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AUDIT_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const RESOLVED_PACKAGE = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/;

interface BunLockfile {
  packages?: Record<string, unknown>;
}

export interface DependencyAdvisory {
  packageName: string;
  versions: string[];
  severity: string;
  title: string;
  url: string;
}

export function lockedPackages(lockfileText: string, source: string): Map<string, Set<string>> {
  let lockfile: BunLockfile;
  try {
    lockfile = Bun.JSONC.parse(lockfileText) as BunLockfile;
  } catch (error) {
    throw new Error(`Cannot parse ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!lockfile.packages || typeof lockfile.packages !== "object") {
    throw new Error(`${source} has no packages table`);
  }
  const packages = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(lockfile.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      throw new Error(`${source} has an invalid package entry: ${key}`);
    }
    const match = RESOLVED_PACKAGE.exec(entry[0]);
    if (!match) throw new Error(`${source} has an unsupported package resolution: ${entry[0]}`);
    const [, packageName, version] = match;
    const versions = packages.get(packageName) ?? new Set<string>();
    versions.add(version);
    packages.set(packageName, versions);
  }
  return packages;
}

export function mergeLockedPackages(
  destinations: Map<string, Set<string>>,
  source: Map<string, Set<string>>,
): void {
  for (const [packageName, sourceVersions] of source) {
    const versions = destinations.get(packageName) ?? new Set<string>();
    for (const version of sourceVersions) versions.add(version);
    destinations.set(packageName, versions);
  }
}

export function dependencyAdvisories(
  report: unknown,
  packages: Map<string, Set<string>>,
): DependencyAdvisory[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Dependency audit returned an invalid advisory report");
  }
  const findings: DependencyAdvisory[] = [];
  for (const [packageName, records] of Object.entries(report)) {
    if (!Array.isArray(records)) {
      throw new Error(`Dependency audit returned invalid advisories for ${packageName}`);
    }
    for (const record of records) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`Dependency audit returned an invalid advisory for ${packageName}`);
      }
      const advisory = record as Record<string, unknown>;
      if (typeof advisory.severity !== "string"
        || typeof advisory.title !== "string"
        || typeof advisory.url !== "string") {
        throw new Error(`Dependency audit returned an incomplete advisory for ${packageName}`);
      }
      findings.push({
        packageName,
        versions: [...(packages.get(packageName) ?? [])].sort(),
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
      });
    }
  }
  return findings.sort((left, right) => (
    left.packageName.localeCompare(right.packageName) || left.title.localeCompare(right.title)
  ));
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const packages = new Map<string, Set<string>>();
  for (const relativePath of ["bun.lock", "launcher/bun.lock"]) {
    mergeLockedPackages(
      packages,
      lockedPackages(readFileSync(resolve(root, relativePath), "utf8"), relativePath),
    );
  }
  const payload = Object.fromEntries(
    [...packages.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, versions]) => [packageName, [...versions].sort()]),
  );
  const response = await fetch(AUDIT_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 500);
    throw new Error(`Dependency audit request failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const findings = dependencyAdvisories(await response.json(), packages);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.severity.toUpperCase()} ${finding.packageName}@${finding.versions.join(",")}:`
        + ` ${finding.title} (${finding.url})\n`,
      );
    }
    throw new Error(`Dependency audit found ${findings.length} advisory finding(s)`);
  }
  process.stdout.write(`DEPENDENCY_AUDIT_OK ${packages.size} packages across 2 lockfiles\n`);
}

if (import.meta.main) await main();
