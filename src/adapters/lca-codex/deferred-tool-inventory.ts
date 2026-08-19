export interface GatewayDiscoveredTool {
  wireName: string;
  description: string;
  freeform: boolean;
  rank: number;
  parameters?: Record<string, unknown>;
  schemaError?: string;
}

const CODEX_TOOL_INVENTORY_MARKER = "LCA_CODEX_TOOL_INVENTORY:";
const DEFERRED_GATEWAY_BLOCKED_LOGICAL_NAMES = [
  "codex_bind_turn",
  "codex_context",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
];
const DEFERRED_TOOL_DESCRIPTION_TOTAL_BUDGET = 24_000;
const DEFERRED_TOOL_DESCRIPTION_MAX_BUDGET = 12_000;
const DEFERRED_TOOL_SCHEMA_TOTAL_BUDGET = 96_000;
const DEFERRED_TOOL_SCHEMA_MAX_BUDGET = 32_000;

export function inventoryToolRank(
  needle: string,
  wireNameValue: string,
  name: string,
  namespace: string,
  description: string,
  exactNamespaceMatchExists = false,
): number {
  if (!needle) return 0;
  const wire = wireNameValue.toLowerCase();
  const logicalName = name.toLowerCase();
  const provider = namespace.toLowerCase();
  const needleKey = needle.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const combined = provider ? `${provider}_${logicalName}` : logicalName;
  const summary = description.split(/\n\nexec tool declaration:/i)[0]!.toLowerCase();
  if (wire === needle || combined === needleKey) return 0;
  if (exactNamespaceMatchExists && provider === needleKey) return 0;
  if (!exactNamespaceMatchExists && logicalName === needleKey) return 0;
  if (logicalName === needleKey) return 1;
  if (logicalName.includes(needleKey) || combined.includes(needleKey)) return 2;
  if (provider.includes(needleKey)) return 3;
  if (summary.includes(needle)) return 4;
  return 5;
}

export function gatewayWireIdentity(wireNameValue: string): { name: string; namespace: string | null } {
  const parts = wireNameValue.split("__");
  if (parts.length < 3) return { name: wireNameValue, namespace: null };
  return {
    namespace: parts[1] || null,
    name: parts.slice(2).join("__") || wireNameValue,
  };
}

interface TypeToken {
  kind: "identifier" | "string" | "number" | "punctuation";
  value: string;
}

function tokenizeTypeScriptType(source: string): TypeToken[] {
  const tokens: TypeToken[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) throw new Error("unterminated block comment");
      index = close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) throw new Error("unterminated string escape");
          value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        value += current;
        index += 1;
      }
      if (!closed) throw new Error("unterminated string literal");
      tokens.push({ kind: "string", value });
      continue;
    }
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(index));
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    if ("{}[]():;?|<>,".includes(char)) {
      tokens.push({ kind: "punctuation", value: char });
      index += 1;
      continue;
    }
    throw new Error(`unsupported token ${JSON.stringify(char)}`);
  }
  return tokens;
}

function typeScriptTypeToJsonSchema(source: string): Record<string, unknown> {
  const tokens = tokenizeTypeScriptType(source);
  let index = 0;
  const peek = (value?: string): TypeToken | undefined => {
    const token = tokens[index];
    return value === undefined || token?.value === value ? token : undefined;
  };
  const take = (value?: string): TypeToken => {
    const token = tokens[index];
    if (!token || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? "type token"}, got ${token?.value ?? "end of declaration"}`);
    }
    index += 1;
    return token;
  };

  const parseType = (): Record<string, unknown> => {
    const variants = [parsePostfixType()];
    while (peek("|")) {
      take("|");
      variants.push(parsePostfixType());
    }
    if (variants.length === 1) return variants[0]!;
    const constants = variants.map(schema => schema.const);
    if (constants.every(value => typeof value === "string")) {
      return { type: "string", enum: constants };
    }
    return { anyOf: variants };
  };

  const parsePostfixType = (): Record<string, unknown> => {
    let schema = parsePrimaryType();
    while (peek("[") && tokens[index + 1]?.value === "]") {
      take("[");
      take("]");
      schema = { type: "array", items: schema };
    }
    return schema;
  };

  const parseObjectType = (): Record<string, unknown> => {
    take("{");
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    let additionalProperties: boolean | Record<string, unknown> = false;
    while (!peek("}")) {
      if (peek("[")) {
        take("[");
        take();
        take(":");
        take("string");
        take("]");
        take(":");
        additionalProperties = parseType();
      } else {
        const nameToken = take();
        if (nameToken.kind !== "identifier" && nameToken.kind !== "string") {
          throw new Error(`unsupported property name ${nameToken.value}`);
        }
        const optional = Boolean(peek("?"));
        if (optional) take("?");
        take(":");
        properties[nameToken.value] = parseType();
        if (!optional) required.push(nameToken.value);
      }
      if (peek(";") || peek(",")) take();
    }
    take("}");
    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties,
    };
  };

  const parseTupleType = (): Record<string, unknown> => {
    take("[");
    const prefixItems: Record<string, unknown>[] = [];
    while (!peek("]")) {
      prefixItems.push(parseType());
      if (peek(",")) take(",");
      else break;
    }
    take("]");
    return { type: "array", prefixItems, minItems: prefixItems.length, maxItems: prefixItems.length };
  };

  const parsePrimaryType = (): Record<string, unknown> => {
    const token = peek();
    if (!token) throw new Error("unexpected end of declaration");
    if (token.value === "{") return parseObjectType();
    if (token.value === "[") return parseTupleType();
    if (token.value === "(") {
      take("(");
      const schema = parseType();
      take(")");
      return schema;
    }
    if (token.kind === "string") {
      take();
      return { type: "string", const: token.value };
    }
    if (token.kind === "number") {
      take();
      return { type: "number", const: Number(token.value) };
    }
    if (token.kind !== "identifier") throw new Error(`unsupported type token ${token.value}`);
    take();
    if (token.value === "string" || token.value === "number" || token.value === "boolean") return { type: token.value };
    if (token.value === "null") return { type: "null" };
    if (token.value === "true") return { type: "boolean", const: true };
    if (token.value === "false") return { type: "boolean", const: false };
    if (token.value === "unknown" || token.value === "any") return {};
    if (token.value === "object") return { type: "object", additionalProperties: true };
    if (token.value === "Array") {
      take("<");
      const items = parseType();
      take(">");
      return { type: "array", items };
    }
    if (token.value === "Record") {
      take("<");
      const key = take();
      if (key.value !== "string") throw new Error(`unsupported Record key ${key.value}`);
      take(",");
      const values = parseType();
      take(">");
      return { type: "object", additionalProperties: values };
    }
    throw new Error(`unsupported named type ${token.value}`);
  };

  const schema = parseType();
  if (index !== tokens.length) throw new Error(`unexpected trailing token ${tokens[index]?.value}`);
  return schema;
}

function nestedToolParameters(declaration: string): Record<string, unknown> {
  const match = /\(\s*args\s*:\s*/.exec(declaration);
  if (!match) throw new Error("exec declaration does not expose an args parameter");
  const typeSource = declaration.slice(match.index + match[0].length);
  const tokens = tokenizeTypeScriptType(typeSource);
  let depth = 0;
  let end = 0;
  for (; end < tokens.length; end += 1) {
    const value = tokens[end]!.value;
    if (value === "{" || value === "[" || value === "(" || value === "<") depth += 1;
    else if (value === "}" || value === "]" || value === ">") depth -= 1;
    else if (value === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (end >= tokens.length) throw new Error("could not find the end of the args type");
  const typeText = tokens.slice(0, end).map(token => (
    token.kind === "string" ? JSON.stringify(token.value) : token.value
  )).join(" ");
  const schema = typeScriptTypeToJsonSchema(typeText);
  if (schema.type !== "object") throw new Error("exec declaration args type is not an object");
  return schema;
}

export function gatewayToolInventoryProgram({
  query,
  excludedWireNames,
  offset,
  limit,
  includeSchema,
}: {
  query?: string;
  excludedWireNames: string[];
  offset: number;
  limit: number;
  includeSchema: boolean;
}): string {
  return [
    `const needle = ${JSON.stringify(query?.trim().toLowerCase() ?? "")};`,
    "const needleKey = needle.replace(/[^a-z0-9]+/g, \"_\").replace(/^_+|_+$/g, \"\");",
    `const excluded = new Set(${JSON.stringify(excludedWireNames)});`,
    `const blockedLogicalNames = new Set(${JSON.stringify(DEFERRED_GATEWAY_BLOCKED_LOGICAL_NAMES)});`,
    "const blockedLogicalSuffixes = [...blockedLogicalNames].map(name => `_${name}`);",
    "const identity = tool => { const wire = tool.name.toLowerCase(); const parts = wire.split(\"__\"); return { wire, logicalName: parts.length >= 3 ? parts.slice(2).join(\"__\") : wire, provider: parts.length >= 3 ? parts[1] : \"\" }; };",
    "const isBlockedLogicalName = logicalName => blockedLogicalNames.has(logicalName) || blockedLogicalSuffixes.some(suffix => logicalName.endsWith(suffix));",
    "const candidates = ALL_TOOLS.filter(tool => !excluded.has(tool.name) && !isBlockedLogicalName(identity(tool).logicalName));",
    "const exactNamespaceMatchExists = Boolean(needleKey) && candidates.some(tool => identity(tool).provider === needleKey);",
    "const rank = tool => { const { wire, logicalName, provider } = identity(tool); const combined = provider ? `${provider}_${logicalName}` : logicalName; const summary = (tool.description || \"\").split(/\\n\\nexec tool declaration:/i)[0].toLowerCase(); if (!needle) return 0; if (wire === needle || combined === needleKey) return 0; if (exactNamespaceMatchExists && provider === needleKey) return 0; if (!exactNamespaceMatchExists && logicalName === needleKey) return 0; if (logicalName === needleKey) return 1; if (logicalName.includes(needleKey) || combined.includes(needleKey)) return 2; if (provider.includes(needleKey)) return 3; if (summary.includes(needle)) return 4; return 5; };",
    "const matches = candidates.map((tool, index) => ({ tool, index, rank: rank(tool) })).filter(item => !needle || item.rank < 5).sort((left, right) => left.rank - right.rank || left.tool.name.localeCompare(right.tool.name) || left.index - right.index);",
    "const bestRank = matches[0]?.rank ?? 5;",
    "const selected = needle && bestRank === 0 ? matches.filter(item => item.rank === 0) : matches;",
    `const page = selected.slice(${offset}, ${offset + limit});`,
    `const descriptionBudget = Math.min(${DEFERRED_TOOL_DESCRIPTION_MAX_BUDGET}, Math.max(600, Math.floor(${DEFERRED_TOOL_DESCRIPTION_TOTAL_BUDGET} / Math.max(1, page.length))));`,
    `const schemaBudget = Math.min(${DEFERRED_TOOL_SCHEMA_MAX_BUDGET}, Math.max(1024, Math.floor(${DEFERRED_TOOL_SCHEMA_TOTAL_BUDGET} / Math.max(1, page.length))));`,
    `const includeSchema = ${includeSchema ? "true" : "false"};`,
    "const payload = { total: selected.length, tools: page.map(({ tool, rank }) => { const full = tool.description || \"\"; const declarationMatch = /exec tool declaration:\\s*```ts\\s*([\\s\\S]*?)```/i.exec(full); const description = full.split(/\\n\\nexec tool declaration:/i)[0].slice(0, descriptionBudget); const freeform = /\\bFREEFORM tool\\b/i.test(full); const declaration = declarationMatch?.[1]; const schemaError = includeSchema && !freeform ? (!declaration ? \"exec tool declaration not found in deferred tool description\" : declaration.length > schemaBudget ? `exec tool declaration exceeds ${schemaBudget}-character schema budget; narrow the query or lower limit` : undefined) : undefined; return { name: tool.name, description, freeform, rank, ...(includeSchema && !schemaError && declaration ? { declaration } : {}), ...(schemaError ? { schema_error: schemaError } : {}) }; }) };",
    `text(${JSON.stringify(CODEX_TOOL_INVENTORY_MARKER)} + JSON.stringify(payload));`,
  ].join("\n");
}

function toolResultText(value: unknown): string {
  const texts: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      texts.push(candidate);
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record.text === "string") texts.push(record.text);
    if (record.content !== undefined) visit(record.content);
    if (record.structuredContent !== undefined) visit(record.structuredContent);
  };
  visit(value);
  return texts.join("\n");
}

export function parseGatewayToolInventory(value: unknown): { total: number; tools: GatewayDiscoveredTool[] } {
  const text = toolResultText(value);
  const markerIndex = text.indexOf(CODEX_TOOL_INVENTORY_MARKER);
  if (markerIndex < 0) throw new Error("Codex exec gateway did not return its nested tool inventory");
  const payload = JSON.parse(text.slice(markerIndex + CODEX_TOOL_INVENTORY_MARKER.length).trim()) as {
    total?: unknown;
    tools?: unknown;
  };
  if (!Number.isSafeInteger(payload.total) || (payload.total as number) < 0 || !Array.isArray(payload.tools)) {
    throw new Error("Codex exec gateway returned an invalid nested tool inventory");
  }
  const tools: GatewayDiscoveredTool[] = [];
  for (const candidate of payload.tools) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    const description = typeof record.description === "string" ? record.description : "";
    const freeform = record.freeform === true;
    const rank = Number.isSafeInteger(record.rank) && (record.rank as number) >= 0 && (record.rank as number) <= 4
      ? record.rank as number
      : 5;
    let parameters: Record<string, unknown> | undefined;
    let schemaError = typeof record.schema_error === "string" && record.schema_error
      ? record.schema_error.slice(0, 500)
      : undefined;
    if (!schemaError && !freeform && typeof record.declaration === "string" && record.declaration) {
      try {
        parameters = nestedToolParameters(record.declaration);
      } catch (error) {
        schemaError = error instanceof Error ? error.message : String(error);
      }
    }
    tools.push({
      wireName: record.name,
      description,
      freeform,
      rank,
      ...(parameters ? { parameters } : {}),
      ...(schemaError ? { schemaError } : {}),
    });
  }
  return { total: payload.total as number, tools };
}
