/**
 * dreaming/classifier.ts — 内容分类器
 *
 * 使用 LLM 对 pending 事件进行内容分类。
 * 核心设计：
 *   - 基于内容（excerpt）分类，不基于 URL/域名
 *   - 受控标签词汇表：每次分类都传入已有的全部标签，LLM 优先复用
 *   - 分批处理：每批最多 20 个事件，避免超出 LLM 上下文
 *   - 事件 ID 映射由代码处理，LLM 只返回按索引排列的标签数组
 */

import { generateText } from "ai";
import { createLlmModel, type LlmClientOptions } from "../onboarding/llm.js";
import type { EventRow } from "../db/events.js";

/** 单个事件的分类结果 */
export interface ClassificationResult {
  event_id: number;
  tags: string[];
  confidence: number;
  reasoning: string;
}

/** 分类器的完整输出 */
export interface ClassifierOutput {
  classifications: ClassificationResult[];
  new_tags: Array<{ tag: string; justification: string }>;
}

/** LLM 返回的单个分类（按数组索引对应事件） */
interface LlmClassificationItem {
  tags: string[];
  confidence: number;
  reasoning: string;
}

/** LLM 返回的原始 JSON 结构 */
interface LlmClassifierResponse {
  classifications: LlmClassificationItem[];
  new_tags: Array<{ tag: string; justification: string }>;
}

/** 每批处理的最大事件数 */
const BATCH_SIZE = 20;

/**
 * 构建分类 system prompt。
 * 包含受控标签词汇表，确保 LLM 优先复用已有标签。
 */
function buildClassificationPrompt(existingTags: string[]): string {
  const tagsJson =
    existingTags.length > 0
      ? JSON.stringify(existingTags)
      : "[] (no existing tags yet — create initial ones)";

  return `You are a classification agent for a personal behavioral modeling system.

## Existing Tags
${tagsJson}

## Rules
1. Classify each event based on its CONTENT (excerpt and title), not its URL or domain.
2. Reuse existing tags whenever possible. Do NOT create synonyms.
3. If no existing tag fits, propose a new tag and explain why.
4. Each event can have 1-3 tags.
5. Tags should use category/topic format (e.g., "coding/rust", "research/ai-agents", "interests/photography").
6. For events with no excerpt or very little content, classify based on the title.
7. Return valid JSON only. No markdown wrapping, no explanations outside JSON.
8. IMPORTANT: Return classifications as an array in the SAME ORDER as the input events.
   The array length MUST equal the number of input events. Each item corresponds to the event at the same index.

## Output Format
{
  "classifications": [
    { "tags": ["coding/rust", "learning"], "confidence": 0.92, "reasoning": "Article about Tokio runtime" },
    { "tags": ["research/ai-agents"], "confidence": 0.85, "reasoning": "Paper on multi-agent systems" }
  ],
  "new_tags": [
    { "tag": "devops/docker", "justification": "Multiple events about Docker, not covered by existing tags" }
  ]
}`;
}

/**
 * 构建事件列表的 user prompt。
 * 事件用数字编号（1-indexed），LLM 按相同顺序返回分类。
 */
function buildEventsPrompt(events: EventRow[]): string {
  const items = events.map((e, i) => ({
    index: i + 1,
    title: e.title || "(no title)",
    excerpt: e.excerpt ? e.excerpt.slice(0, 800) : "(no content)",
    dwell_time_sec: e.dwell_time_sec,
    event_type: e.event_type,
  }));

  return `Classify the following ${events.length} events. Return classifications in the SAME ORDER (one per event):\n\n${JSON.stringify(items, null, 2)}`;
}

/**
 * 对一批事件执行分类，用代码做 index → event_id 映射。
 */
async function classifyBatch(
  events: EventRow[],
  existingTags: string[],
  llmConfig: LlmClientOptions
): Promise<ClassifierOutput> {
  const model = createLlmModel(llmConfig);
  const systemPrompt = buildClassificationPrompt(existingTags);
  const userPrompt = buildEventsPrompt(events);

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 4000,
    temperature: 0.3,
  });

  // 解析 LLM 输出
  const jsonStr = text.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim();
  const raw = JSON.parse(jsonStr) as LlmClassifierResponse;

  // 按索引映射回 event_id — LLM 不需要知道任何 ID
  const classifications: ClassificationResult[] = [];
  for (let i = 0; i < events.length; i++) {
    const llmItem = raw.classifications[i];
    classifications.push({
      event_id: events[i].id,
      tags: llmItem?.tags ?? ["uncategorized"],
      confidence: llmItem?.confidence ?? 0,
      reasoning: llmItem?.reasoning ?? "no classification returned",
    });
  }

  return {
    classifications,
    new_tags: raw.new_tags ?? [],
  };
}

/**
 * 对所有 pending 事件执行分类。
 * 自动分批，合并结果，更新受控词汇表。
 *
 * @param events       待分类的事件
 * @param existingTags 已有的标签词汇表
 * @param llmConfig    LLM 配置
 * @param onProgress   进度回调（当前批次 / 总批次）
 */
export async function classifyEvents(
  events: EventRow[],
  existingTags: string[],
  llmConfig: LlmClientOptions,
  onProgress?: (current: number, total: number) => void
): Promise<ClassifierOutput> {
  if (events.length === 0) {
    return { classifications: [], new_tags: [] };
  }

  const allClassifications: ClassificationResult[] = [];
  const allNewTags: Array<{ tag: string; justification: string }> = [];
  // 动态更新标签表 — 前一批新增的标签，后一批可以复用
  const runningTags = [...existingTags];

  const totalBatches = Math.ceil(events.length / BATCH_SIZE);

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    onProgress?.(batchNum, totalBatches);

    const result = await classifyBatch(batch, runningTags, llmConfig);

    allClassifications.push(...result.classifications);

    // 新标签加入运行时词汇表
    for (const nt of result.new_tags) {
      if (!runningTags.includes(nt.tag)) {
        runningTags.push(nt.tag);
        allNewTags.push(nt);
      }
    }
  }

  return {
    classifications: allClassifications,
    new_tags: allNewTags,
  };
}
