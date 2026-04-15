/**
 * dreaming/scheduler.ts — Cron 定时调度器
 *
 * 使用 node-cron 在用户配置的时间（默认每晚 23:00）自动触发 dreaming。
 * 集成到 daemon 启动流程中。
 */

import cron from "node-cron";
import { runDreaming, type DreamingProgress } from "./index.js";

/** 调度器实例 — 用于停止 */
let scheduledTask: cron.ScheduledTask | null = null;

/**
 * 启动 dreaming cron 调度器。
 *
 * @param schedule    cron 表达式（如 "0 23 * * *"）
 * @param onProgress  进度回调（传给 runDreaming）
 */
export function startScheduler(
  schedule: string,
  onProgress?: (progress: DreamingProgress) => void
): void {
  if (scheduledTask) {
    scheduledTask.stop();
  }

  if (!cron.validate(schedule)) {
    throw new Error(`Invalid cron schedule: "${schedule}"`);
  }

  scheduledTask = cron.schedule(schedule, async () => {
    try {
      await runDreaming(undefined, onProgress);
    } catch (err) {
      // 调度触发的 dreaming 失败不应该崩溃 daemon
      onProgress?.({
        stage: "error",
        message: `Scheduled dreaming failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

/**
 * 停止 cron 调度器。daemon shutdown 时调用。
 */
export function stopScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

/**
 * 获取调度器是否在运行。
 */
export function isSchedulerRunning(): boolean {
  return scheduledTask !== null;
}
