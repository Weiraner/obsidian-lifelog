/**
 * llm.ts — the one network/process-touching module. Everything shapeable is in
 * llm-core.ts (pure, tested); this dispatches on provider kind:
 *   - "cli"  → spawn `claude -p` locally (Claude subscription, no API key).
 *   - others → HTTP via Obsidian's `requestUrl`, which runs server-side in
 *     Electron and so bypasses CORS (why we don't use the browser SDKs here).
 */
import { Platform, requestUrl } from "obsidian";
import {
  buildCliInvocation,
  buildRequest,
  parseCliResponse,
  parseResponse,
  resolveProvider,
  type LlmResult,
  type LlmSettings,
} from "./llm-core";

export async function callLLM(prompt: string, settings: LlmSettings): Promise<LlmResult> {
  if (resolveProvider(settings).kind === "cli") return callClaudeCli(prompt, settings);

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

/**
 * Run `claude -p` as a child process, prompt on stdin. Desktop-only — there is
 * no subprocess on Obsidian mobile, so we fail loudly and tell the user to pick
 * an HTTP provider instead. `child_process` is lazy-required so the module still
 * loads on mobile (the require only runs when this provider is actually used).
 */
function callClaudeCli(prompt: string, settings: LlmSettings): Promise<LlmResult> {
  if (!Platform.isDesktopApp) {
    throw new Error("claude -p 只能在桌面端运行;移动端请在设置里改用某个 HTTP provider。");
  }
  const { bin, args } = buildCliInvocation(settings);
  const timeoutMs = (settings.timeoutSec || 300) * 1000;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { spawn } = require("child_process") as typeof import("child_process");

  return new Promise<LlmResult>((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { env: process.env });
    } catch (e) {
      reject(new Error(`无法启动 ${bin}: ${(e as Error).message}`));
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`claude -p 超时(${settings.timeoutSec || 300}s)`));
    }, timeoutMs);

    proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`claude -p 启动失败: ${e.message}(检查二进制路径)`));
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p 退出码 ${code}: ${err.slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseCliResponse(out));
      } catch (e) {
        reject(e);
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}
