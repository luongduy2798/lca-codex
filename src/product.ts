export const PRODUCT_ID = "lca-token";
export const PRODUCT_DISPLAY_NAME = "LCA Token";
export const PRODUCT_HOME_ENV = "LCA_TOKEN_HOME";
export const PRODUCT_PROFILE_ENV = "LCA_TOKEN_PROFILE";
export const PRODUCT_BUN_ENV = "LCA_TOKEN_BUN";
export const SOURCE_CLI_COMMAND = "bun run src/cli.ts";
export const DEFAULT_PROFILE = "default";
export const DEFAULT_PORT = 8317;

export function assertProfileName(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    throw new Error("Profile names may contain only letters, digits, dot, underscore, and dash");
  }
  return profile;
}

export function tunnelIdentity(profile: string): string {
  return `${PRODUCT_ID}-${assertProfileName(profile)}`;
}
