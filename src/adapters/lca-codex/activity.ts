export const LCA_CODEX_ACTIVITY_PREFIX = "[lca-codex-activity] ";

export type LcaCodexActivityLevel = "info" | "warning" | "error";

export type LcaCodexActivityDetail = Record<string, string | number | boolean | null | undefined>;

export interface LcaCodexActivityOptions {
  observedAt?: number;
}

function isHealthProbeActivity(detail: LcaCodexActivityDetail): boolean {
  return typeof detail.traceId === "string" && detail.traceId.startsWith("health-");
}

/**
 * Emit a bounded, payload-minimized activity record. The launcher recognizes this prefix and stores
 * the JSON as a first-class Activity entry; other hosts still receive a readable diagnostic line.
 * Logging is deliberately best-effort and must never affect a browser turn or native tool call.
 */
export function logLcaCodexActivity(
  event: string,
  detail: LcaCodexActivityDetail,
  level: LcaCodexActivityLevel = "info",
  options: LcaCodexActivityOptions = {},
): void {
  if (isHealthProbeActivity(detail)) return;
  try {
    const observedAt = Number.isFinite(options.observedAt) && options.observedAt! >= 0
      ? Math.round(options.observedAt!)
      : undefined;
    const line = `${LCA_CODEX_ACTIVITY_PREFIX}${JSON.stringify({
      event,
      level,
      detail,
      ...(observedAt === undefined ? {} : { observedAt }),
    })}`;
    if (level === "error") console.error(line);
    else if (level === "warning") console.warn(line);
    else console.info(line);
  } catch {
    // Diagnostics must not change turn or tool behavior.
  }
}

export function activityCallId(value: string): string {
  return value.slice(0, 17);
}

export function activityDuration(startedAt: number): number {
  return Math.max(0, Math.round(Date.now() - startedAt));
}
