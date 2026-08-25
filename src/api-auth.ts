import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";

const API_TOKEN_PREFIX = "lcat_";

export function apiTokenPath(): string {
  return join(getConfigDir(), "secrets", "api-token");
}

function newApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function readApiToken(): string | undefined {
  const path = apiTokenPath();
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, "utf8").trim();
  return value.startsWith(API_TOKEN_PREFIX) && value.length >= API_TOKEN_PREFIX.length + 40
    ? value
    : undefined;
}

export function ensureApiToken(): { token: string; created: boolean } {
  const existing = readApiToken();
  if (existing) return { token: existing, created: false };
  const token = newApiToken();
  atomicWriteFile(apiTokenPath(), `${token}\n`);
  return { token, created: true };
}

export function rotateApiToken(): string {
  const token = newApiToken();
  atomicWriteFile(apiTokenPath(), `${token}\n`);
  return token;
}

export function removeApiToken(): void {
  rmSync(apiTokenPath(), { force: true });
}

export function requestApiToken(req: Request): string | undefined {
  const authorization = req.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(lcat_[A-Za-z0-9_-]+)$/i.exec(authorization);
  return match?.[1];
}

export function apiTokenAuthorized(req: Request): boolean {
  const expectedToken = readApiToken();
  const actualToken = requestApiToken(req);
  if (!expectedToken || !actualToken) return false;
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(actualToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
