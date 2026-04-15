/**
 * dreaming/updater.ts — USER.md + memory/ 更新器
 *
 * 根据 inferrer 的输出：
 *   1. 更新 USER.md（使用 LLM 重写，保持模板结构）
 *   2. 创建/更新 memory/ 文件（带 YAML frontmatter）
 *
 * USER.md 更新策略：整体重写而非正则替换，
 * 因为自然语言段落不适合结构化 patch。
 */

import fs from "node:fs";
import path from "node:path";
import { generateText } from "ai";
import { createLlmModel, type LlmClientOptions } from "../onboarding/llm.js";
import { DATA_DIR, USER_MD_PATH } from "../config.js";
import type { InferrerOutput, MemoryUpdate } from "./inferrer.js";

/** memory/ 根目录 */
export const MEMORY_DIR = path.join(DATA_DIR, "memory");

/**
 * 确保 memory/ 目录及 meta/ 子目录存在。
 */
export function ensureMemoryDir(): void {
  const metaDir = path.join(MEMORY_DIR, "meta");
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }
}

/**
 * 使用 LLM 重写 USER.md。
 *
 * 将当前内容 + inferrer 的更新建议一起发给 LLM，
 * 由 LLM 生成更新后的完整 USER.md。
 */
export async function updateUserMd(
  currentContent: string,
  inference: InferrerOutput,
  llmConfig: LlmClientOptions
): Promise<string> {
  const model = createLlmModel(llmConfig);

  const systemPrompt = `You are a persona updater for a personal behavioral modeling system.
Your task is to update the USER.md file based on new behavioral patterns detected.

## Rules
1. Keep the EXACT template structure (all section headers must remain).
2. Integrate the suggested updates naturally into the existing content.
3. For Identity Tags: add new items, remove suggested ones. Keep the bracket list format.
4. For Behavioral Patterns: merge new observations with existing ones. Keep it concise.
5. For Current Context: update to reflect the latest activity. This should always be recent.
6. Do NOT add new sections. Do NOT remove existing sections.
7. Keep the file under 3000 tokens.
8. Output ONLY the markdown content, no explanations.`;

  const userPrompt = `## Current USER.md
${currentContent}

## Updates to Apply
### Patterns Detected
${JSON.stringify(inference.patterns, null, 2)}

### Identity Tag Changes
Add: ${JSON.stringify(inference.user_md_updates.identity_tags.add)}
Remove: ${JSON.stringify(inference.user_md_updates.identity_tags.remove)}

### Behavioral Pattern Updates
${inference.user_md_updates.behavioral_patterns.join("\n")}

### Current Context
Recent focus: ${inference.user_md_updates.current_context.recent_focus}
${inference.user_md_updates.current_context.active_projects ? `Active projects: ${inference.user_md_updates.current_context.active_projects.join(", ")}` : ""}

Please output the updated USER.md incorporating these changes.`;

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 4000,
    temperature: 0.4,
  });

  const updated = text.trim();

  // 写入文件
  fs.writeFileSync(USER_MD_PATH, updated + "\n", "utf-8");
  return updated;
}

/**
 * 读取当前 USER.md 内容。
 */
export function readUserMd(): string {
  if (!fs.existsSync(USER_MD_PATH)) {
    return "";
  }
  return fs.readFileSync(USER_MD_PATH, "utf-8");
}

/**
 * 根据 inferrer 的建议创建/更新 memory/ 文件。
 *
 * 每个 memory 文件格式：
 * ---
 * tags: [coding/rust, learning]
 * last_updated: 2026-04-11T23:02:00Z
 * decay_weight: 1.0
 * created: 2026-04-11T23:02:00Z
 * source_events: [1042, 1043]
 * ---
 * # Title
 * content...
 */
export async function updateMemoryFiles(
  memoryUpdates: MemoryUpdate[],
  llmConfig: LlmClientOptions
): Promise<string[]> {
  ensureMemoryDir();
  const updatedPaths: string[] = [];

  for (const update of memoryUpdates) {
    const filePath = path.join(MEMORY_DIR, update.path);
    const dir = path.dirname(filePath);

    // 确保子目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();

    if (update.action === "create" || !fs.existsSync(filePath)) {
      // 新建 memory 文件
      const content = buildNewMemoryFile(update, now);
      fs.writeFileSync(filePath, content, "utf-8");
    } else {
      // 更新已有文件 — 用 LLM 合并新旧内容
      const existing = fs.readFileSync(filePath, "utf-8");
      const merged = await mergeMemoryFile(existing, update, now, llmConfig);
      fs.writeFileSync(filePath, merged, "utf-8");
    }

    updatedPaths.push(update.path);
  }

  return updatedPaths;
}

/**
 * 构建新的 memory 文件内容（含 YAML frontmatter）。
 */
function buildNewMemoryFile(update: MemoryUpdate, now: string): string {
  // 从路径中提取标题（如 "coding/rust-learning.md" → "Rust Learning"）
  const basename = path.basename(update.path, ".md");
  const title = basename
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  const frontmatter = [
    "---",
    `tags: [${update.tags.join(", ")}]`,
    `last_updated: ${now}`,
    `decay_weight: 1.0`,
    `created: ${now}`,
    `source_events: [${update.source_events.join(", ")}]`,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n# ${title}\n\n${update.content_summary}\n`;
}

/**
 * 合并已有 memory 文件和新内容。
 * 更新 frontmatter 的 last_updated、source_events、decay_weight。
 * 用 LLM 合并正文内容。
 */
async function mergeMemoryFile(
  existing: string,
  update: MemoryUpdate,
  now: string,
  llmConfig: LlmClientOptions
): Promise<string> {
  // 解析现有 frontmatter
  const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    // 没有 frontmatter，当作新建
    return buildNewMemoryFile(update, now);
  }

  const existingBody = fmMatch[2].trim();
  const existingFm = fmMatch[1];

  // 提取已有的 source_events
  const eventsMatch = existingFm.match(/source_events:\s*\[([^\]]*)\]/);
  const existingEventIds = eventsMatch
    ? eventsMatch[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : [];
  const mergedEventIds = [...new Set([...existingEventIds, ...update.source_events])];

  // 合并标签
  const tagsMatch = existingFm.match(/tags:\s*\[([^\]]*)\]/);
  const existingTags = tagsMatch
    ? tagsMatch[1].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const mergedTags = [...new Set([...existingTags, ...update.tags])];

  // 用 LLM 合并正文
  const model = createLlmModel(llmConfig);
  const { text: mergedBody } = await generateText({
    model,
    system: `You merge memory notes. Combine the existing content with new observations.
Keep it concise. Output only the merged content (no frontmatter, no wrapping).
Preserve the existing structure and add the new information naturally.`,
    prompt: `## Existing Content\n${existingBody}\n\n## New Observations\n${update.content_summary}\n\nMerge these into one cohesive document.`,
    maxTokens: 2000,
    temperature: 0.3,
  });

  const frontmatter = [
    "---",
    `tags: [${mergedTags.join(", ")}]`,
    `last_updated: ${now}`,
    `decay_weight: 1.0`,
    `created: ${existingFm.match(/created:\s*(.+)/)?.[1] ?? now}`,
    `source_events: [${mergedEventIds.join(", ")}]`,
    "---",
  ].join("\n");

  return `${frontmatter}\n\n${mergedBody.trim()}\n`;
}

/**
 * 获取所有 memory/ 文件路径（相对于 MEMORY_DIR）。
 */
export function listMemoryFiles(): string[] {
  ensureMemoryDir();
  const files: string[] = [];

  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), path.join(prefix, entry.name));
      } else if (entry.name.endsWith(".md")) {
        files.push(path.join(prefix, entry.name));
      }
    }
  }

  walk(MEMORY_DIR, "");
  return files;
}
