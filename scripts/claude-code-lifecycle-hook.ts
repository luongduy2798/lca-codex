interface ClaudeCodeHookInput {
  session_id?: unknown;
  agent_id?: unknown;
  hook_event_name?: unknown;
}

export {};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function main(): Promise<void> {
  let input: ClaudeCodeHookInput;
  try {
    input = JSON.parse(await Bun.stdin.text()) as ClaudeCodeHookInput;
  } catch {
    return;
  }
  const sessionId = stringValue(input.session_id);
  const event = stringValue(input.hook_event_name);
  if (!sessionId || (event !== "Stop" && event !== "SessionEnd" && event !== "SubagentStop")) return;

  const agentId = stringValue(input.agent_id);
  if (event === "SubagentStop" && !agentId) return;
  const lifecycleAgentId = event === "SubagentStop" ? agentId : undefined;

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, "");
  const token = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!baseUrl || !token) return;
  try {
    await fetch(`${baseUrl}/v1/agent/lifecycle`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-claude-code-session-id": sessionId,
        ...(lifecycleAgentId ? { "x-claude-code-agent-id": lifecycleAgentId } : {}),
      },
      body: JSON.stringify({ method: "task/stop" }),
    });
  } catch {
    // A lifecycle notification must never prevent Claude Code itself from stopping.
  }
}

await main();
