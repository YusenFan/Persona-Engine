/**
 * dreaming/compressor.ts — USER.md 压缩器
 *
 * 当 USER.md 超出 token 预算时，使用 LLM 进行压缩。
 * 压缩策略：
 *   - 移除/缩短低 decay_weight 的条目
 *   - 合并相似条目
 *   - 保留最近、最频繁强化的内容
 *   - 保持模板结构完整
 */

import { generateText } from "ai";
import { createLlmModel, type LlmClientOptions } from "../onboarding/llm.js";
import { USER_MD_PATH } from "../config.js";
import { getStaleMemories } from "./decay.js";
import fs from "node:fs";

/**
 * 粗略估算文本的 token 数。
 * 英文约 4 字符/token，中文约 2 字符/token。
 * 这里用保守估计：3 字符/token。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * 检查并压缩 USER.md（如果超出预算）。
 *
 * @param tokenBudget  token 预算（默认 3000）
 * @param llmConfig    LLM 配置
 * @returns 是否执行了压缩
 */
export async function compressUserMdIfNeeded(
  tokenBudget: number,
  llmConfig: LlmClientOptions
): Promise<{ compressed: boolean; beforeTokens: number; afterTokens: number }> {
  const content = fs.readFileSync(USER_MD_PATH, "utf-8");
  const currentTokens = estimateTokens(content);

  if (currentTokens <= tokenBudget) {
    return { compressed: false, beforeTokens: currentTokens, afterTokens: currentTokens };
  }

  // 获取 stale memories 列表，辅助 LLM 决定删减什么
  const staleMemories = getStaleMemories();

  const model = createLlmModel(llmConfig);

  const { text: compressed } = await generateText({
    model,
    system: `You are a persona compression agent. The USER.md below exceeds the token budget of ${tokenBudget} tokens (current: ~${currentTokens} tokens).

## Rules
1. Remove or shorten items that are likely stale or less important.
2. Merge similar items (e.g., multiple related skills into one line).
3. Keep the most recent and frequently mentioned items.
4. Preserve the template structure (all sections must remain).
5. Current Context section should always reflect the last 1-2 weeks.
6. Output the compressed USER.md in full. No explanations.

## Stale Memory Files (low decay weight — safe to de-prioritize)
${staleMemories.length > 0 ? staleMemories.join("\n") : "(none)"}`,
    prompt: content,
    maxTokens: 4000,
    temperature: 0.3,
  });

  const result = compressed.trim();
  fs.writeFileSync(USER_MD_PATH, result + "\n", "utf-8");

  return {
    compressed: true,
    beforeTokens: currentTokens,
    afterTokens: estimateTokens(result),
  };
}
