/**
 * llm-core.ts — provider-agnostic LLM request/response shaping (pure, testable).
 *
 * One switch, several providers. Claude uses its *native* Messages API
 * (`/v1/messages`, `x-api-key`, `anthropic-version`) — never an OpenAI-compatible
 * shim. GPT / DeepSeek / MiniMax / GLM (Zhipu) all speak the OpenAI
 * `/chat/completions` shape, so they share one adapter that differs only by
 * base URL + model. Everything here is pure so it can be unit-tested without a
 * network; the actual HTTP call lives in llm.ts (Obsidian `requestUrl`).
 */

export type ProviderId = "anthropic" | "openai" | "deepseek" | "minimax" | "glm" | "custom";
type Kind = "anthropic" | "openai";

export interface ProviderPreset {
  kind: Kind;
  label: string;
  baseUrl: string;
  model: string;
}

/**
 * Defaults per provider. `baseUrl` and `model` are overridable in settings —
 * endpoints and model ids drift, so treat these as starting points, not gospel.
 * (Claude defaults to Opus 4.8; switch the model to `claude-haiku-4-5` in
 * settings if you want a cheaper per-day parse.)
 */
export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  anthropic: { kind: "anthropic", label: "Claude (Anthropic)", baseUrl: "https://api.anthropic.com", model: "claude-opus-4-8" },
  openai: { kind: "openai", label: "GPT (OpenAI)", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { kind: "openai", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  minimax: { kind: "openai", label: "MiniMax", baseUrl: "https://api.minimaxi.com/v1", model: "MiniMax-Text-01" },
  glm: { kind: "openai", label: "GLM / 智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  custom: { kind: "openai", label: "Custom (OpenAI-compatible)", baseUrl: "", model: "" },
};

export interface LlmSettings {
  provider: ProviderId;
  apiKey: string;
  /** Override the preset model id (empty = use preset default). */
  model: string;
  /** Override the preset base URL (empty = use preset default). */
  baseUrl: string;
}

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

const MAX_TOKENS = 8000;

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Resolve a settings object into a concrete (kind, baseUrl, model). */
export function resolveProvider(s: LlmSettings): { kind: Kind; baseUrl: string; model: string } {
  const preset = PROVIDERS[s.provider] || PROVIDERS.custom;
  return {
    kind: preset.kind,
    baseUrl: trimSlash(s.baseUrl?.trim() || preset.baseUrl),
    model: s.model?.trim() || preset.model,
  };
}

/** Build the HTTP request for a single-shot completion. Pure — no network. */
export function buildRequest(prompt: string, s: LlmSettings): HttpRequest {
  const { kind, baseUrl, model } = resolveProvider(s);
  if (!s.apiKey) throw new Error("未配置 API key");
  if (!baseUrl) throw new Error("未配置 baseUrl");
  if (!model) throw new Error("未配置 model");

  if (kind === "anthropic") {
    return {
      url: `${baseUrl}/v1/messages`,
      method: "POST",
      headers: {
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    };
  }

  // OpenAI-compatible: GPT / DeepSeek / MiniMax / GLM / custom
  return {
    url: `${baseUrl}/chat/completions`,
    method: "POST",
    headers: {
      authorization: `Bearer ${s.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      stream: false,
    }),
  };
}

/** Parse a provider response body into { text, usage }. Pure — no network. */
export function parseResponse(provider: ProviderId, json: any): LlmResult {
  const kind = (PROVIDERS[provider] || PROVIDERS.custom).kind;
  if (kind === "anthropic") {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
    if (!text) throw new Error("Anthropic 响应中没有文本内容");
    const u = json?.usage || {};
    return { text, usage: { model: json?.model || "", inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 } };
  }
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text) throw new Error("OpenAI 兼容响应中没有 choices[0].message.content");
  const u = json?.usage || {};
  return { text, usage: { model: json?.model || "", inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0 } };
}

/** Tolerant JSON extraction: strip markdown fences, grab the outermost object. */
export function parseJsonLoose(text: string): any {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = t.indexOf("{");
  const j = t.lastIndexOf("}");
  if (i === -1 || j === -1 || j < i) throw new Error("LLM 输出中找不到 JSON 对象");
  return JSON.parse(t.slice(i, j + 1));
}
