/**
 * onboarding/llm.ts — LLM 客户端工厂
 *
 * 根据配置创建 Vercel AI SDK provider 实例。
 * 当前默认使用 OpenAI，后续可扩展其他 provider。
 */

import { createOpenAI } from "@ai-sdk/openai";

export interface LlmClientOptions {
  provider: string;
  model: string;
  apiKey: string;
}

/**
 * 创建 LLM provider 实例。
 * 返回 Vercel AI SDK 兼容的 model 对象，可直接传给 generateText()。
 */
export function createLlmModel(options: LlmClientOptions) {
  const { provider, model, apiKey } = options;

  switch (provider) {
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    default:
      throw new Error(
        `Unsupported LLM provider: "${provider}". Currently supported: openai`
      );
  }
}
