// Bound routing overhead without changing any of the context sent to OpenAI.
export const CODEX_ROUTING_CONTEXT_CHARS = 64_000;

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const marker = "\n[... omitted from routing context ...]\n";
  if (limit <= marker.length) return text.slice(0, Math.max(0, limit));
  const remaining = Math.max(0, limit - marker.length);
  return text.slice(0, Math.floor(remaining / 3)) + marker + text.slice(text.length - Math.ceil(remaining * 2 / 3));
}

// Keep textual history, file excerpts, tool results and project instructions. Jev
// accepts text, so represent media by type and never send base64 or image URLs.
function routingText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(routingText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (/image|audio|video/.test(value.type ?? "")) return `[${value.type}: content unavailable to text-only router]`;
  if (value.type === "additional_tools") return routingText(value.tools);
  if (value.role) return `[${value.role}]\n${routingText(value.content)}`;
  if (typeof value.text === "string") return value.text;
  if (value.type === "function_call_output" || value.type === "custom_tool_call_output") {
    return `[tool result ${value.call_id ?? ""}]\n${routingText(value.output)}`;
  }
  if (value.type === "function_call" || value.type === "custom_tool_call") {
    return `[tool call ${value.name ?? ""}]\n${routingText(value.arguments ?? value.input)}`;
  }
  if (value.name || value.function) {
    const tool = value.function ?? value;
    return `[tool ${tool.name ?? ""}] ${tool.description ?? ""}`;
  }
  return "";
}

export function codexRoutingContext(body, maxChars = CODEX_ROUTING_CONTEXT_CHARS) {
  const instructions = routingText(body.instructions);
  const conversation = routingText(body.input);
  const tools = routingText(body.tools);
  const instructionLimit = Math.min(instructions.length, Math.floor(maxChars / 4));
  const toolLimit = Math.min(tools.length, Math.floor(maxChars / 8));
  const conversationLimit = maxChars - instructionLimit - toolLimit;
  const result = {
    scope: "Context already assembled by Codex; files not read or attached are not included.",
    instructions: excerpt(instructions, instructionLimit),
    conversation: excerpt(conversation, conversationLimit),
    tools: excerpt(tools, toolLimit),
    original_chars: instructions.length + conversation.length + tools.length,
  };
  result.included_chars = result.instructions.length + result.conversation.length + result.tools.length;
  result.truncated = result.original_chars > result.included_chars;
  return result;
}
