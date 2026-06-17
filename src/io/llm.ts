/**
 * llm.ts — the one network-touching function. Everything shapeable is in
 * llm-core.ts (pure, tested); this just sends the request via Obsidian's
 * `requestUrl`, which runs server-side in Electron and so bypasses CORS (the
 * reason we don't use the browser SDKs here).
 */
import { requestUrl } from "obsidian";
import { buildRequest, parseResponse, type LlmResult, type LlmSettings } from "./llm-core";

export async function callLLM(prompt: string, settings: LlmSettings): Promise<LlmResult> {
  const req = buildRequest(prompt, settings);
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    throw: false,
  });
  if (res.status >= 400) {
    const detail = (res.text || "").slice(0, 500);
    throw new Error(`LLM 请求失败 (HTTP ${res.status}): ${detail}`);
  }
  return parseResponse(settings.provider, res.json);
}
