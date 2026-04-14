/**
 * onboarding/questionnaire.ts — 交互式问卷
 *
 * 使用 @clack/prompts 收集用户基本信息和工作目录。
 * 必填字段空输入时会重新提示，不会终止流程。
 * 目录选择使用系统原生文件夹选择器（macOS）。
 */

import * as p from "@clack/prompts";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface SocialProfiles {
  linkedin: string;
  x: string;
  instagram: string;
  other: string[];
}

export interface OnboardingAnswers {
  name: string;
  birthday: string;
  pronouns: string;
  timezone: string;
  occupation: string;
  interests: string[];
  socials: SocialProfiles;
  llmApiKey: string;
  directories: string[];
}

/**
 * 必填文本输入 — 空输入时重新提示，不终止流程。
 * 返回 null 表示用户按了 Ctrl+C。
 */
async function requiredText(
  message: string,
  placeholder?: string
): Promise<string | null> {
  while (true) {
    const value = await p.text({
      message,
      placeholder,
      validate: (v) => {
        if (!v.trim()) return "This field is required. Please enter a value.";
      },
    });
    if (p.isCancel(value)) return null;
    if (value.trim()) return value.trim();
    // 如果 validate 没拦住空值（某些版本可能有差异），手动重试
    p.log.warn("This field is required. Please enter a value.");
  }
}

/**
 * 必填密码输入 — 空输入时重新提示。
 */
async function requiredPassword(
  message: string,
  allowEmpty: boolean
): Promise<string | null> {
  while (true) {
    const value = await p.password({
      message,
      validate: (v) => {
        if (!v.trim() && !allowEmpty)
          return "This field is required. Please enter a value.";
      },
    });
    if (p.isCancel(value)) return null;
    if (value.trim() || allowEmpty) return value.trim();
    p.log.warn("This field is required. Please enter a value.");
  }
}

/**
 * 运行交互式问卷，收集用户信息。
 * 用户按 Ctrl+C 时返回 null。
 */
export async function runQuestionnaire(
  existingApiKey?: string
): Promise<OnboardingAnswers | null> {
  p.intro("Welcome to Persona Engine — let's get to know you.");

  const name = await requiredText(
    "What should I call you?",
    "e.g. Alex"
  );
  if (name === null) return null;

  const birthday = await p.text({
    message: "Birthday (optional)",
    placeholder: "e.g. 1995-03-15",
    defaultValue: "",
  });
  if (p.isCancel(birthday)) return null;

  const pronouns = await p.select({
    message: "Pronouns (optional)",
    options: [
      { value: "", label: "Skip" },
      { value: "he/him", label: "he/him" },
      { value: "she/her", label: "she/her" },
      { value: "they/them", label: "they/them" },
    ],
  });
  if (p.isCancel(pronouns)) return null;

  const detectedTz =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timezone = await p.text({
    message: `Timezone (detected: ${detectedTz})`,
    placeholder: detectedTz,
    defaultValue: detectedTz,
  });
  if (p.isCancel(timezone)) return null;

  const occupation = await requiredText(
    "What do you do? (occupation / role)",
    "e.g. Software Engineer, Designer, Student"
  );
  if (occupation === null) return null;

  const interestsRaw = await p.text({
    message: "What are your interests? (comma-separated)",
    placeholder: "e.g. AI, photography, climbing, Rust",
    defaultValue: "",
  });
  if (p.isCancel(interestsRaw)) return null;

  const interests = interestsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Social media profiles
  const socials = await collectSocialProfiles();
  if (socials === null) return null;

  // OpenAI API key
  const apiKeyMessage = existingApiKey
    ? "OpenAI API key (press Enter to keep existing)"
    : "OpenAI API key (for generating your persona)";

  const llmApiKey = await requiredPassword(apiKeyMessage, !!existingApiKey);
  if (llmApiKey === null) return null;

  const finalApiKey = llmApiKey || existingApiKey || "";

  // Directories — use system folder picker
  const directories = await collectDirectories();
  if (directories === null) return null;

  return {
    name,
    birthday: (birthday as string).trim(),
    pronouns: pronouns as string,
    timezone,
    occupation,
    interests,
    socials,
    llmApiKey: finalApiKey,
    directories,
  };
}

/**
 * 收集用户的社交媒体链接。
 * 所有字段都是可选的，用户按 Enter 跳过。
 */
async function collectSocialProfiles(): Promise<SocialProfiles | null> {
  p.log.info("Social profiles (optional — helps build a richer persona)");

  const linkedin = await p.text({
    message: "LinkedIn profile URL",
    placeholder: "e.g. https://linkedin.com/in/yourname",
    defaultValue: "",
  });
  if (p.isCancel(linkedin)) return null;

  const x = await p.text({
    message: "X (Twitter) profile URL",
    placeholder: "e.g. https://x.com/yourhandle",
    defaultValue: "",
  });
  if (p.isCancel(x)) return null;

  const instagram = await p.text({
    message: "Instagram profile URL",
    placeholder: "e.g. https://instagram.com/yourhandle",
    defaultValue: "",
  });
  if (p.isCancel(instagram)) return null;

  const other: string[] = [];
  const otherRaw = await p.text({
    message: "Other social/portfolio URLs (comma-separated, or Enter to skip)",
    placeholder: "e.g. https://github.com/you, https://yourblog.com",
    defaultValue: "",
  });
  if (p.isCancel(otherRaw)) return null;

  if ((otherRaw as string).trim()) {
    other.push(
      ...(otherRaw as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  return {
    linkedin: (linkedin as string).trim(),
    x: (x as string).trim(),
    instagram: (instagram as string).trim(),
    other,
  };
}

/**
 * 使用系统原生文件夹选择器（macOS）选择要扫描的目录。
 * 用户可以添加多个目录。
 */
async function collectDirectories(): Promise<string[] | null> {
  const dirs: string[] = [];
  const isMac = process.platform === "darwin";

  p.log.info("Select directories to scan (projects, documents, notes, etc.)");

  while (true) {
    const action = await p.select({
      message: dirs.length === 0
        ? "Add a directory to scan"
        : `${dirs.length} directory(s) added. Add more?`,
      options: [
        {
          value: "pick",
          label: isMac ? "Open folder picker" : "Enter path manually",
        },
        {
          value: "done",
          label: dirs.length === 0 ? "Skip — no directories" : "Done — continue",
        },
      ],
    });
    if (p.isCancel(action)) return null;

    if (action === "done") {
      if (dirs.length === 0) {
        p.log.warn("No directories selected. You can add them later via config.");
      }
      break;
    }

    // 选择目录
    const dir = isMac ? await pickFolderMac() : await pickFolderManual();
    if (dir === null) continue; // 用户取消了选择器，继续循环

    if (dirs.includes(dir)) {
      p.log.warn(`Already added: ${dir}`);
      continue;
    }

    dirs.push(dir);
    p.log.success(`Added: ${dir}`);
  }

  return dirs;
}

/**
 * macOS 原生文件夹选择器 — 弹出 Finder 对话框让用户选择文件夹。
 * 返回 null 表示用户取消了选择。
 */
function pickFolderMac(): Promise<string | null> {
  try {
    const result = execSync(
      `osascript -e 'POSIX path of (choose folder with prompt "Select a directory to scan")'`,
      { encoding: "utf-8", timeout: 60000 }
    ).trim();

    // osascript 返回的路径末尾有 /，去掉
    const dir = result.replace(/\/$/, "");

    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      p.log.error(`Invalid directory: ${dir}`);
      return Promise.resolve(null);
    }

    return Promise.resolve(dir);
  } catch {
    // 用户点了取消
    p.log.info("Folder picker cancelled.");
    return Promise.resolve(null);
  }
}

/**
 * 手动输入路径选择目录（非 macOS 回退方案）。
 */
async function pickFolderManual(): Promise<string | null> {
  const dir = await p.text({
    message: "Enter directory path",
    placeholder: "e.g. /home/you/projects",
  });
  if (p.isCancel(dir)) return null;

  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    p.log.error(`Directory not found: ${resolved}`);
    return null;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    p.log.error(`Not a directory: ${resolved}`);
    return null;
  }

  return resolved;
}
