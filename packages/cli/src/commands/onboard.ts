/**
 * commands/onboard.ts — `persona onboard` 命令
 *
 * 完整的 onboarding 流程：
 * 1. 检查是否已 onboard → 提供 reset/update 选项
 * 2. 交互式问卷收集用户信息
 * 3. 扫描用户指定的目录
 * 4. 调用 LLM 生成初始 USER.md
 * 5. 用户审核/编辑 USER.md（可带反馈重新生成）
 * 6. 保存配置和 USER.md
 */

import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { runQuestionnaire } from "../../../daemon/src/onboarding/questionnaire.js";
import { scanDirectories } from "../../../daemon/src/onboarding/scanner.js";
import { generateUserMd } from "../../../daemon/src/onboarding/generator.js";
import {
  loadConfig,
  saveConfig,
  ensureDataDir,
  USER_MD_PATH,
  isOnboarded,
} from "../../../daemon/src/config.js";

export const onboardCommand = new Command("onboard")
  .description("Set up your persona — answer questions, scan directories, generate USER.md")
  .action(async () => {
    // 检查是否已 onboard
    if (isOnboarded()) {
      const action = await p.select({
        message: "You already have a persona. What would you like to do?",
        options: [
          { value: "reset", label: "Start fresh (delete existing and re-create)" },
          { value: "update", label: "Update (re-run onboarding, keep existing as reference)" },
          { value: "cancel", label: "Cancel" },
        ],
      });

      if (p.isCancel(action) || action === "cancel") {
        p.outro("No changes made.");
        return;
      }

      if (action === "reset") {
        fs.unlinkSync(USER_MD_PATH);
        p.log.info("Existing USER.md deleted.");
      }
    }

    // 加载现有配置
    const config = loadConfig();

    // Step 1: 问卷
    const answers = await runQuestionnaire(config.llm.apiKey || undefined);
    if (!answers) {
      p.outro("Onboarding cancelled.");
      return;
    }

    // Step 2: 更新配置（API key + directories）
    config.llm.apiKey = answers.llmApiKey;
    config.llm.provider = "openai";
    config.llm.model = "gpt-5.4";
    config.collection.directories = answers.directories;
    saveConfig(config);
    p.log.success("Configuration saved.");

    // Step 3: 扫描目录
    let scanResults: ReturnType<typeof scanDirectories> = [];
    if (answers.directories.length > 0) {
      const spinner = p.spinner();
      spinner.start(`Scanning ${answers.directories.length} directory(s)...`);
      scanResults = scanDirectories(answers.directories);

      const totalFiles = scanResults.reduce(
        (sum, r) =>
          sum +
          Object.values(r.fileTypeCounts).reduce((a, b) => a + b, 0),
        0
      );
      const totalDocs = scanResults.reduce(
        (sum, r) => sum + r.documents.length,
        0
      );
      spinner.stop(
        `Scanned ${scanResults.length} directory(s): ${totalFiles} files, ${totalDocs} documents found.`
      );
    }

    // Step 4: 生成 USER.md
    const llmOpts = {
      provider: config.llm.provider,
      model: config.llm.model,
      apiKey: config.llm.apiKey,
    };

    const genSpinner = p.spinner();
    genSpinner.start("Generating your persona with AI...");

    let userMdContent: string;
    try {
      userMdContent = await generateUserMd(answers, scanResults, llmOpts);
      genSpinner.stop("Persona generated!");
    } catch (err) {
      genSpinner.stop("Failed to generate persona.");
      p.log.error(
        `LLM error: ${err instanceof Error ? err.message : String(err)}`
      );
      p.outro("Please check your API key and try again.");
      return;
    }

    // Step 5: 审核/编辑循环
    let accepted = false;
    while (!accepted) {
      p.log.info("── Generated USER.md ──────────────────────────");
      console.log(userMdContent);
      p.log.info("────────────────────────────────────────────────");

      const reviewAction = await p.select({
        message: "How does this look?",
        options: [
          { value: "accept", label: "Accept — save this USER.md" },
          { value: "edit", label: "Edit — open in $EDITOR" },
          { value: "regenerate", label: "Regenerate — tell AI what to change" },
        ],
      });

      if (p.isCancel(reviewAction)) {
        p.outro("Onboarding cancelled. No USER.md saved.");
        return;
      }

      if (reviewAction === "accept") {
        accepted = true;
      } else if (reviewAction === "edit") {
        userMdContent = await openInEditor(userMdContent);
      } else if (reviewAction === "regenerate") {
        // 让用户输入修改意见
        const feedback = await p.text({
          message: "What should be changed? (your feedback for AI)",
          placeholder: "e.g. Add more detail about my Python experience, remove the photography interest",
        });
        if (p.isCancel(feedback)) continue;

        const regenSpinner = p.spinner();
        regenSpinner.start("Regenerating with your feedback...");
        try {
          userMdContent = await generateUserMd(
            answers,
            scanResults,
            llmOpts,
            userMdContent,
            feedback
          );
          regenSpinner.stop("Regenerated!");
        } catch (err) {
          regenSpinner.stop("Regeneration failed.");
          p.log.error(
            `LLM error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // Step 6: 保存 USER.md
    ensureDataDir();
    fs.writeFileSync(USER_MD_PATH, userMdContent + "\n", "utf-8");
    p.log.success(`USER.md saved to ${USER_MD_PATH}`);

    // Step 7: 后续步骤提示
    p.log.info("── Next Steps ─────────────────────────────────");
    p.log.step("1. Browser extension setup (coming in Phase 3)");
    p.log.step('2. Start the daemon: persona start');
    p.log.step('3. Trigger dreaming: persona dream');
    p.log.step('4. Chat with your persona: persona chat');

    p.outro("Onboarding complete! Your persona is ready.");
  });

/**
 * 在用户的 $EDITOR 中打开内容进行编辑。
 */
async function openInEditor(content: string): Promise<string> {
  const editor = process.env.EDITOR || process.env.VISUAL || "nano";
  const tmpFile = path.join(os.tmpdir(), `persona-user-md-${Date.now()}.md`);

  fs.writeFileSync(tmpFile, content, "utf-8");

  try {
    execSync(`${editor} ${tmpFile}`, { stdio: "inherit" });
    const edited = fs.readFileSync(tmpFile, "utf-8");
    return edited.trim();
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // 清理失败不影响流程
    }
  }
}
