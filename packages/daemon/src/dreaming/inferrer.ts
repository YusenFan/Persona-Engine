/**
 * dreaming/inferrer.ts — 行为模式推断器
 *
 * 分析已分类的事件，推断行为模式：
 *   - 学习连续性（连续多天关注同一主题）
 *   - 焦点转移（新兴趣出现 / 旧兴趣消退）
 *   - 工作节奏（深度阅读时段、上下文切换频率）
 *
 * 输出结构化的更新建议，交给 updater 执行。
 */

import { generateText } from "ai";
import { createLlmModel, type LlmClientOptions } from "../onboarding/llm.js";
import type { EventRow } from "../db/events.js";

/** 检测到的行为模式 */
export interface Pattern {
  type: string; // "learning_streak" | "focus_shift" | "work_rhythm" | "new_interest" | ...
  description: string;
  confidence: number;
  evidence: number[]; // 支持该模式的 event IDs
}

/** USER.md 更新建议 */
export interface UserMdUpdates {
  identity_tags: {
    add: Record<string, string[]>; // e.g. { "Learning": ["Rust"] }
    remove: Record<string, string[]>;
  };
  behavioral_patterns: string[];
  current_context: {
    recent_focus: string;
    active_projects?: string[];
  };
}

/** memory/ 文件更新建议 */
export interface MemoryUpdate {
  path: string; // e.g. "coding/rust-learning.md"
  action: "create" | "update";
  content_summary: string;
  tags: string[];
  source_events: number[];
}

/** 推断器的完整输出 */
export interface InferrerOutput {
  patterns: Pattern[];
  user_md_updates: UserMdUpdates;
  memory_updates: MemoryUpdate[];
}

/**
 * 运行模式推断。
 *
 * @param classifiedEvents  已分类事件（包含 tags）
 * @param currentUserMd     当前 USER.md 内容
 * @param llmConfig         LLM 配置
 */
export async function inferPatterns(
  classifiedEvents: EventRow[],
  currentUserMd: string,
  llmConfig: LlmClientOptions
): Promise<InferrerOutput> {
  if (classifiedEvents.length === 0) {
    return {
      patterns: [],
      user_md_updates: {
        identity_tags: { add: {}, remove: {} },
        behavioral_patterns: [],
        current_context: { recent_focus: "" },
      },
      memory_updates: [],
    };
  }

  const model = createLlmModel(llmConfig);

  // 构建事件摘要（不传全部字段，只传分类相关的）
  const eventsSummary = classifiedEvents.map((e) => ({
    id: e.id,
    event_type: e.event_type,
    title: e.title || "(no title)",
    excerpt: e.excerpt ? e.excerpt.slice(0, 300) : null,
    tags: e.tags ? JSON.parse(e.tags) : [],
    dwell_time_sec: e.dwell_time_sec,
    created_at: e.created_at,
  }));

  const systemPrompt = `You are a behavioral pattern analyst for a personal modeling system.

## Tasks
1. Identify new behavioral patterns or changes in existing ones.
2. Detect learning streaks, focus shifts, or new interests.
3. Note any changes in work rhythm (deep work hours, context switching frequency).
4. Suggest updates to USER.md sections: Identity Tags, Behavioral Patterns, Current Context.
5. Identify which memory/ files should be created or updated.

## Rules
- Base patterns on EVIDENCE (specific events), not speculation.
- Only suggest Identity Tag changes if there's clear evidence (3+ events on a topic).
- memory/ file paths use category/topic format: "coding/rust-learning.md", "research/ai-agents.md".
- Return valid JSON only. No markdown wrapping.

## Output Format
{
  "patterns": [
    {
      "type": "learning_streak",
      "description": "Rust async programming study — day 4",
      "confidence": 0.88,
      "evidence": [1042, 1043, 1055, 1089]
    }
  ],
  "user_md_updates": {
    "identity_tags": {
      "add": {"Learning": ["Rust"]},
      "remove": {}
    },
    "behavioral_patterns": ["Deep focus on Rust async — 4 consecutive days"],
    "current_context": {
      "recent_focus": "Rust async programming, persona-engine architecture",
      "active_projects": ["persona-engine"]
    }
  },
  "memory_updates": [
    {
      "path": "coding/rust-learning.md",
      "action": "create",
      "content_summary": "Rust async programming study with Tokio runtime focus",
      "tags": ["coding/rust", "learning"],
      "source_events": [1042, 1043, 1055, 1089]
    }
  ]
}`;

  const userPrompt = `## Current USER.md
${currentUserMd}

## Events from recent period (classified)
${JSON.stringify(eventsSummary, null, 2)}

Analyze these events and return pattern analysis with update suggestions.`;

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 4000,
    temperature: 0.5,
  });

  const jsonStr = text.replace(/```json?\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(jsonStr) as InferrerOutput;
}
