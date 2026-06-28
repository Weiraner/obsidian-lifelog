/**
 * llm.test.ts — provider-switch shaping (pure, no network).
 *
 * Proves the one switch routes Claude to its native Messages API and everyone
 * else to the OpenAI-compatible chat/completions shape, and that responses +
 * loose JSON are parsed correctly for both kinds.
 */
import { describe, expect, it } from "vitest";
import { buildCliInvocation, buildRequest, parseCliResponse, parseJsonLoose, parseResponse, resolveProvider, type LlmSettings } from "../src/io/llm-core";

const base = (over: Partial<LlmSettings>): LlmSettings => ({ provider: "anthropic", apiKey: "k", model: "", baseUrl: "", ...over });

describe("resolveProvider", () => {
  it("uses preset defaults when overrides are empty", () => {
    expect(resolveProvider(base({ provider: "deepseek" }))).toEqual({ kind: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" });
  });
  it("applies overrides and strips trailing slashes", () => {
    expect(resolveProvider(base({ provider: "custom", baseUrl: "https://x.test/v1/", model: "m" }))).toEqual({ kind: "openai", baseUrl: "https://x.test/v1", model: "m" });
  });
});

describe("buildRequest — Claude native", () => {
  const req = buildRequest("hi", base({ provider: "anthropic", apiKey: "sk-ant" }));
  it("hits /v1/messages with x-api-key + version header (not an OpenAI shim)", () => {
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers.authorization).toBeUndefined();
  });
  it("sends a messages body with max_tokens and no temperature", () => {
    const body = JSON.parse(req.body);
    expect(body.model).toBe("claude-opus-4-8");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.temperature).toBeUndefined();
  });
});

describe("buildRequest — OpenAI-compatible", () => {
  for (const provider of ["openai", "deepseek", "minimax", "glm"] as const) {
    it(`${provider} hits /chat/completions with Bearer auth`, () => {
      const req = buildRequest("hi", base({ provider, apiKey: "key" }));
      expect(req.url.endsWith("/chat/completions")).toBe(true);
      expect(req.headers.authorization).toBe("Bearer key");
      expect(req.headers["x-api-key"]).toBeUndefined();
      const body = JSON.parse(req.body);
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(body.stream).toBe(false);
    });
  }
});

describe("buildRequest — guards", () => {
  it("throws without an API key", () => {
    expect(() => buildRequest("x", base({ apiKey: "" }))).toThrow(/API key/);
  });
  it("throws on custom provider without baseUrl", () => {
    expect(() => buildRequest("x", base({ provider: "custom", apiKey: "k", model: "m" }))).toThrow(/baseUrl/);
  });
});

describe("parseResponse", () => {
  it("reads Claude content blocks + token usage", () => {
    const r = parseResponse("anthropic", { model: "claude-opus-4-8", content: [{ type: "text", text: "{\"ok\":1}" }], usage: { input_tokens: 10, output_tokens: 4 } });
    expect(r.text).toBe('{"ok":1}');
    expect(r.usage).toEqual({ model: "claude-opus-4-8", inputTokens: 10, outputTokens: 4 });
  });
  it("reads OpenAI choices + token usage", () => {
    const r = parseResponse("deepseek", { model: "deepseek-chat", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(r.text).toBe("hello");
    expect(r.usage).toEqual({ model: "deepseek-chat", inputTokens: 7, outputTokens: 3 });
  });
});

describe("claude -p (CLI provider)", () => {
  it("resolves to the cli kind with the preset model", () => {
    expect(resolveProvider(base({ provider: "claude-cli", apiKey: "" }))).toEqual({ kind: "cli", baseUrl: "", model: "claude-opus-4-8" });
  });
  it("builds `claude -p --output-format json --model <m>` and honors claudeBin override", () => {
    const inv = buildCliInvocation(base({ provider: "claude-cli", apiKey: "", model: "claude-haiku-4-5", claudeBin: "/opt/claude" }));
    expect(inv.bin).toBe("/opt/claude");
    expect(inv.args).toEqual(["-p", "--output-format", "json", "--model", "claude-haiku-4-5"]);
  });
  it("defaults the binary to `claude` on PATH", () => {
    expect(buildCliInvocation(base({ provider: "claude-cli", apiKey: "" })).bin).toBe("claude");
  });
  it("unwraps the JSON envelope into inner result + token usage", () => {
    const r = parseCliResponse(JSON.stringify({ result: '{"blocks":[]}', model: "claude-opus-4-8", usage: { input_tokens: 12, output_tokens: 5 } }));
    expect(r.text).toBe('{"blocks":[]}');
    expect(r.usage).toEqual({ model: "claude-opus-4-8", inputTokens: 12, outputTokens: 5 });
  });
  it("falls back to raw stdout when there is no envelope", () => {
    const r = parseCliResponse('{"blocks":[]}');
    expect(r.text).toBe('{"blocks":[]}');
    expect(r.usage.inputTokens).toBe(0);
  });
});

describe("parseJsonLoose", () => {
  it("extracts an object from a fenced, chatty response", () => {
    expect(parseJsonLoose('```json\n{"blocks": [], "x": 1}\n```')).toEqual({ blocks: [], x: 1 });
  });
  it("grabs the outermost object amid prose", () => {
    expect(parseJsonLoose('Sure!\n{"a": {"b": 2}}\nDone')).toEqual({ a: { b: 2 } });
  });
  it("throws when there is no object", () => {
    expect(() => parseJsonLoose("no json here")).toThrow();
  });
});
