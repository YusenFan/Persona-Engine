/**
 * dreaming/decay.ts — 时间衰减机制
 *
 * 对 memory/ 文件的 decay_weight 执行指数衰减。
 * 衰减公式：weight = weight × 0.5^(daysSinceUpdate / halfLifeDays)
 *
 * decay_weight 降到阈值以下的 memory 文件会在 USER.md 压缩时被优先移除。
 */

import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR, listMemoryFiles } from "./updater.js";

/** 衰减结果 */
export interface DecayResult {
  file: string;
  oldWeight: number;
  newWeight: number;
  daysSinceUpdate: number;
}

/** memory 文件低于此权重将被标记为可清理 */
const STALE_THRESHOLD = 0.1;

/**
 * 对所有 memory/ 文件执行时间衰减。
 *
 * @param halfLifeDays  半衰期天数（默认 30）
 * @returns 被衰减的文件列表及其权重变化
 */
export function applyDecay(halfLifeDays: number): DecayResult[] {
  const files = listMemoryFiles();
  const results: DecayResult[] = [];
  const now = Date.now();

  for (const relPath of files) {
    // 跳过 meta/ 目录（dreaming-log 等不需要衰减）
    if (relPath.startsWith("meta/") || relPath.startsWith("meta\\")) {
      continue;
    }

    const filePath = path.join(MEMORY_DIR, relPath);
    const content = fs.readFileSync(filePath, "utf-8");

    // 解析 frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const body = fmMatch[2];

    // 提取 last_updated 和 decay_weight
    const updatedMatch = fm.match(/last_updated:\s*(.+)/);
    const weightMatch = fm.match(/decay_weight:\s*([\d.]+)/);

    if (!updatedMatch) continue;

    const lastUpdated = new Date(updatedMatch[1].trim()).getTime();
    const oldWeight = weightMatch ? parseFloat(weightMatch[1]) : 1.0;

    // 计算天数差和新权重
    const daysSinceUpdate = (now - lastUpdated) / (1000 * 60 * 60 * 24);
    const newWeight = oldWeight * Math.pow(0.5, daysSinceUpdate / halfLifeDays);
    const roundedWeight = Math.round(newWeight * 1000) / 1000; // 保留 3 位小数

    // 更新 frontmatter 中的 decay_weight
    const updatedFm = fm.replace(
      /decay_weight:\s*[\d.]+/,
      `decay_weight: ${roundedWeight}`
    );
    const updatedContent = `---\n${updatedFm}\n---\n${body}`;
    fs.writeFileSync(filePath, updatedContent, "utf-8");

    results.push({
      file: relPath,
      oldWeight,
      newWeight: roundedWeight,
      daysSinceUpdate: Math.round(daysSinceUpdate),
    });
  }

  return results;
}

/**
 * 获取所有低于阈值的 stale memory 文件。
 */
export function getStaleMemories(): string[] {
  const files = listMemoryFiles();
  const stale: string[] = [];

  for (const relPath of files) {
    if (relPath.startsWith("meta/") || relPath.startsWith("meta\\")) continue;

    const filePath = path.join(MEMORY_DIR, relPath);
    const content = fs.readFileSync(filePath, "utf-8");
    const weightMatch = content.match(/decay_weight:\s*([\d.]+)/);
    if (weightMatch && parseFloat(weightMatch[1]) < STALE_THRESHOLD) {
      stale.push(relPath);
    }
  }

  return stale;
}
