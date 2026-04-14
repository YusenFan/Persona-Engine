/**
 * onboarding/scanner.ts — 目录扫描器
 *
 * 扫描用户指定的目录，提取结构和关键文件内容。
 * 支持代码项目和普通文件夹（文档、笔记等）。
 * 对 PDF/Word/Excel/Apple 文档只读取文件名作为标题信号。
 */

import fs from "node:fs";
import path from "node:path";

export interface DirectoryScanResult {
  path: string;
  tree: string;
  keyFiles: KeyFileExcerpt[];
  fileTypeCounts: Record<string, number>;
  documents: DocumentInfo[];
}

interface KeyFileExcerpt {
  name: string;
  content: string;
}

interface DocumentInfo {
  relativePath: string;
  type: "pdf" | "word" | "excel" | "pages" | "numbers" | "keynote" | "presentation";
  title: string;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode",
  "coverage",
  ".cache",
]);

const KEY_FILES = [
  "README.md",
  "package.json",
  ".gitignore",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
];

const DOC_EXTENSIONS: Record<string, DocumentInfo["type"]> = {
  ".pdf": "pdf",
  ".doc": "word",
  ".docx": "word",
  ".xls": "excel",
  ".xlsx": "excel",
  ".ppt": "presentation",
  ".pptx": "presentation",
  // Apple iWork
  ".pages": "pages",
  ".numbers": "numbers",
  ".keynote": "keynote",
};

const EXCERPT_MAX_CHARS = 500;

export function scanDirectories(dirs: string[]): DirectoryScanResult[] {
  return dirs.map((dir) => scanSingleDirectory(dir));
}

function scanSingleDirectory(dirPath: string): DirectoryScanResult {
  const tree = buildTree(dirPath, 0, 2);
  const keyFiles = readKeyFiles(dirPath);
  const fileTypeCounts = countFileTypes(dirPath, 0, 2);
  const documents = collectDocuments(dirPath, dirPath, 0, 2);

  return { path: dirPath, tree, keyFiles, fileTypeCounts, documents };
}

function buildTree(dirPath: string, depth: number, maxDepth: number): string {
  if (depth >= maxDepth) return "";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return "";
  }

  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;

    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      const subtree = buildTree(
        path.join(dirPath, entry.name),
        depth + 1,
        maxDepth
      );
      if (subtree) lines.push(subtree);
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }

  return lines.join("\n");
}

function readKeyFiles(dirPath: string): KeyFileExcerpt[] {
  const excerpts: KeyFileExcerpt[] = [];

  for (const fileName of KEY_FILES) {
    const filePath = path.join(dirPath, fileName);
    if (!fs.existsSync(filePath)) continue;

    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      let content: string;

      if (fileName === "package.json") {
        const pkg = JSON.parse(raw);
        content = JSON.stringify(
          {
            name: pkg.name,
            description: pkg.description,
            dependencies: pkg.dependencies
              ? Object.keys(pkg.dependencies)
              : undefined,
            devDependencies: pkg.devDependencies
              ? Object.keys(pkg.devDependencies)
              : undefined,
          },
          null,
          2
        );
      } else {
        content = raw.slice(0, EXCERPT_MAX_CHARS);
        if (raw.length > EXCERPT_MAX_CHARS) {
          content += "\n... (truncated)";
        }
      }

      excerpts.push({ name: fileName, content });
    } catch {
      // 读取失败跳过
    }
  }

  return excerpts;
}

/**
 * 收集文档文件信息（PDF, Word, Excel, Apple iWork 等）。
 * 用文件名作为标题信号——不解析文件内容。
 */
function collectDocuments(
  rootPath: string,
  dirPath: string,
  depth: number,
  maxDepth: number
): DocumentInfo[] {
  if (depth >= maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const docs: DocumentInfo[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      docs.push(...collectDocuments(rootPath, fullPath, depth + 1, maxDepth));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const docType = DOC_EXTENSIONS[ext];
      if (docType) {
        docs.push({
          relativePath: path.relative(rootPath, fullPath),
          type: docType,
          title: path.basename(entry.name, ext),
        });
      }
    }
  }

  return docs;
}

function countFileTypes(
  dirPath: string,
  depth: number,
  maxDepth: number
): Record<string, number> {
  const counts: Record<string, number> = {};
  if (depth >= maxDepth) return counts;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return counts;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;

    if (entry.isDirectory()) {
      const sub = countFileTypes(
        path.join(dirPath, entry.name),
        depth + 1,
        maxDepth
      );
      for (const [ext, count] of Object.entries(sub)) {
        counts[ext] = (counts[ext] || 0) + count;
      }
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext) {
        counts[ext] = (counts[ext] || 0) + 1;
      }
    }
  }

  return counts;
}
