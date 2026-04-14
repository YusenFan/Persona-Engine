/**
 * onboarding/generator.ts — USER.md 生成器
 *
 * 将问卷答案 + 目录扫描结果发送给 LLM，生成初始 USER.md。
 */

import { generateText } from "ai";
import { createLlmModel } from "./llm.js";
import type { OnboardingAnswers } from "./questionnaire.js";
import type { DirectoryScanResult } from "./scanner.js";

const SYSTEM_PROMPT = `You are a persona generator for a personal behavioral modeling system.
Your task is to create an initial USER.md — a structured persona file for the user.

Rules:
1. Follow the exact template structure provided below.
2. Fill in all sections based on the user's answers and directory analysis.
3. Infer Identity Tags (Roles, Skills, Learning, Interests) from both the user's stated info AND what you observe in their directories and documents.
4. Behavioral Patterns and Current Context can have brief initial guesses, but mark them as inferred.
5. Keep the file concise — under 3000 tokens.
6. Write in English. Use markdown formatting.
7. Do NOT add sections that aren't in the template.
8. Output ONLY the markdown content, no explanations or wrapping.

## Template Structure

# USER.md — About You

_Learn about yourself through your digital footprint. Updated over time._

- **Name:**
- **Birthday:**
- **Pronouns:**
- **Timezone:**
- **Occupation:**

## Identity Tags
<!-- multi-dimensional tagging, agent-managed -->
- Roles: []
- Skills: []
- Learning: []
- Interests: []

## Behavioral Patterns
_(Initial observations — will be refined by the dreaming agent)_

## Current Context
_(Initial snapshot — will be updated by the dreaming agent)_

## Notes

---
The more you know, the better you can help.
But remember — you're learning about a person, not building a dossier.`;

/**
 * 构建发送给 LLM 的用户信息 prompt。
 */
function buildUserPrompt(
  answers: OnboardingAnswers,
  scanResults: DirectoryScanResult[]
): string {
  const parts: string[] = [];

  // 用户基本信息
  parts.push("## User Information");
  parts.push(`- Name: ${answers.name}`);
  if (answers.birthday) parts.push(`- Birthday: ${answers.birthday}`);
  if (answers.pronouns) parts.push(`- Pronouns: ${answers.pronouns}`);
  parts.push(`- Timezone: ${answers.timezone}`);
  parts.push(`- Occupation: ${answers.occupation}`);
  if (answers.interests.length > 0) {
    parts.push(`- Interests: ${answers.interests.join(", ")}`);
  }

  // 社交媒体
  const { socials } = answers;
  const socialLinks: string[] = [];
  if (socials.linkedin) socialLinks.push(`LinkedIn: ${socials.linkedin}`);
  if (socials.x) socialLinks.push(`X (Twitter): ${socials.x}`);
  if (socials.instagram) socialLinks.push(`Instagram: ${socials.instagram}`);
  for (const url of socials.other) {
    socialLinks.push(`Other: ${url}`);
  }
  if (socialLinks.length > 0) {
    parts.push("\n### Social Profiles");
    for (const link of socialLinks) {
      parts.push(`- ${link}`);
    }
  }

  // 目录扫描结果
  if (scanResults.length > 0) {
    parts.push("\n## Directory Analysis");

    for (const result of scanResults) {
      parts.push(`\n### ${result.path}`);

      // 文件类型统计
      const topTypes = Object.entries(result.fileTypeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([ext, count]) => `${ext}: ${count}`)
        .join(", ");
      if (topTypes) {
        parts.push(`File types: ${topTypes}`);
      }

      // 关键文件
      for (const kf of result.keyFiles) {
        parts.push(`\n#### ${kf.name}`);
        parts.push("```");
        parts.push(kf.content);
        parts.push("```");
      }

      // 文档文件
      if (result.documents.length > 0) {
        parts.push("\n#### Documents found");
        for (const doc of result.documents) {
          parts.push(`- [${doc.type}] ${doc.title} (${doc.relativePath})`);
        }
      }

      // 目录树
      if (result.tree) {
        parts.push("\n#### Directory structure");
        parts.push("```");
        parts.push(result.tree);
        parts.push("```");
      }
    }
  }

  parts.push(
    "\n\nBased on the above, generate the initial USER.md following the template."
  );
  return parts.join("\n");
}

/**
 * 调用 LLM 生成初始 USER.md 内容。
 *
 * 支持带反馈的重新生成：传入上一版内容和用户反馈，
 * LLM 会基于反馈修改 USER.md。
 */
export async function generateUserMd(
  answers: OnboardingAnswers,
  scanResults: DirectoryScanResult[],
  llmConfig: { provider: string; model: string; apiKey: string },
  previousContent?: string,
  userFeedback?: string
): Promise<string> {
  const model = createLlmModel(llmConfig);
  let userPrompt = buildUserPrompt(answers, scanResults);

  // 如果有上一版内容和用户反馈，附加到 prompt
  if (previousContent && userFeedback) {
    userPrompt += `\n\n## Previous Version\nHere is the previous USER.md that the user wants to improve:\n\`\`\`\n${previousContent}\n\`\`\``;
    userPrompt += `\n\n## User Feedback\nThe user wants these changes:\n${userFeedback}`;
    userPrompt += `\n\nPlease regenerate the USER.md incorporating the user's feedback while keeping the same template structure.`;
  }

  const { text } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTokens: 4000,
    temperature: 0.7,
  });

  return text.trim();
}
