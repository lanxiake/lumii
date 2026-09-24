#!/usr/bin/env node
/**
 * K7-1: 删除 apps/windows 下的 208 条未用 import
 *
 * 输入：tsc --noEmit --noUnusedLocals 的输出（从 stdin 或文件）
 * 输出：AST 改写文件，删除：
 *   - TS6133: 'X' is declared but its value is never read (import 语句里的条目)
 *   - TS6192: All imports in import declaration are unused (整行删)
 *
 * 复用 K5-1 架构：
 *   1. 按文件聚合
 *   2. 逐文件 AST 改写（删 import 条目或整行）
 *   3. dry-run 自检：改写 → tsc 验证
 *
 * 用法：
 *   node verify/k7-1-remove-unused-imports.mjs < /path/to/k7-raw.txt --dry-run
 *   node verify/k7-1-remove-unused-imports.mjs < /path/to/k7-raw.txt
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

// 1. 解析 tsc 输出
function parseTscOutput(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  const byFile = new Map();

  for (const line of lines) {
    // apps/windows/src/main/index.ts(52,20): error TS6133: 'spawn' is declared but its value is never read.
    const match = line.match(/^([^:]+)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
    if (!match) continue;

    const [, filePath, lineStr, colStr, code, message] = match;
    const lineNum = parseInt(lineStr);
    const col = parseInt(colStr);

    if (!byFile.has(filePath)) {
      byFile.set(filePath, []);
    }

    byFile.get(filePath).push({
      line: lineNum,
      col,
      code,
      message,
      raw: line
    });
  }

  return byFile;
}

// 2. 提取未用的 import 名
function extractUnusedName(message, code) {
  if (code === 'TS6192') {
    // All imports in import declaration are unused.
    return null; // 需要删整行
  }

  if (code === 'TS6133' || code === 'TS6196') {
    // 'spawn' is declared but its value is never read.
    // 'LocalStreamingParaformerAsr' is declared but never used.
    const match = message.match(/'([^']+)' is declared but/);
    return match ? match[1] : null;
  }

  return null;
}

// 3. AST 改写：删除 import 条目或整行
function removeUnusedImports(sourceFile, issues) {
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.CarriageReturnLineFeed,
    removeComments: false
  });

  // 按行号聚合
  const byLine = new Map();
  for (const issue of issues) {
    if (!byLine.has(issue.line)) {
      byLine.set(issue.line, []);
    }
    byLine.get(issue.line).push(issue);
  }

  // 收集要删除的节点
  const nodesToRemove = new Set();
  const importNamesToRemove = new Map(); // node -> Set<names>

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const issuesOnLine = byLine.get(line) || [];

      for (const issue of issuesOnLine) {
        if (issue.code === 'TS6192') {
          // 整行删
          nodesToRemove.add(node);
          break;
        }

        if (issue.code === 'TS6133' || issue.code === 'TS6196') {
          const unusedName = extractUnusedName(issue.message, issue.code);
          if (unusedName) {
            if (!importNamesToRemove.has(node)) {
              importNamesToRemove.set(node, new Set());
            }
            importNamesToRemove.get(node).add(unusedName);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Transformer
  const transformer = (context) => {
    return (rootNode) => {
      function visitNode(node) {
        if (nodesToRemove.has(node)) {
          return undefined; // 删除整个节点
        }

        if (ts.isImportDeclaration(node) && importNamesToRemove.has(node)) {
          const namesToRemove = importNamesToRemove.get(node);
          const clause = node.importClause;

          if (!clause) return node;

          let newDefaultBinding = clause.name;
          let newNamedBindings = clause.namedBindings;

          // 处理默认导入
          if (clause.name && namesToRemove.has(clause.name.text)) {
            newDefaultBinding = undefined;
          }

          // 处理命名导入
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            const elements = clause.namedBindings.elements.filter(el => {
              const name = el.name.text;
              return !namesToRemove.has(name);
            });

            if (elements.length === 0) {
              newNamedBindings = undefined;
            } else {
              newNamedBindings = ts.factory.updateNamedImports(
                clause.namedBindings,
                elements
              );
            }
          }

          // 如果都删光了，删整行
          if (!newDefaultBinding && !newNamedBindings) {
            return undefined;
          }

          // 有剩余，更新节点
          return ts.factory.updateImportDeclaration(
            node,
            node.modifiers,
            ts.factory.updateImportClause(
              clause,
              clause.isTypeOnly,
              newDefaultBinding,
              newNamedBindings
            ),
            node.moduleSpecifier,
            node.attributes
          );
        }

        return ts.visitEachChild(node, visitNode, context);
      }
      return ts.visitNode(rootNode, visitNode);
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const transformedSourceFile = result.transformed[0];
  result.dispose();

  return printer.printFile(transformedSourceFile);
}

// 4. 处理单个文件
function processFile(filePath, issues) {
  const fullPath = path.join(REPO_ROOT, filePath);

  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠ 文件不存在，跳过: ${filePath}`);
    return { filePath, issueCount: issues.length, changed: false, skipped: true };
  }

  const sourceText = fs.readFileSync(fullPath, 'utf-8');

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );

  const newText = removeUnusedImports(sourceFile, issues);

  if (!DRY_RUN && newText !== sourceText) {
    fs.writeFileSync(fullPath, newText, 'utf-8');
  }

  return {
    filePath,
    issueCount: issues.length,
    changed: newText !== sourceText
  };
}

// 5. 主流程
async function main() {
  console.log(`[K7-1] 删除未用 import - ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // 从 stdin 读取
  let tscOutput = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    tscOutput = Buffer.concat(chunks).toString('utf-8');
  } else {
    console.error('错误：需要从 stdin 读取 tsc 输出');
    console.error('用法：node verify/k7-1-remove-unused-imports.mjs < /path/to/k7-raw.txt --dry-run');
    process.exit(1);
  }

  const byFile = parseTscOutput(tscOutput);

  const totalIssues = [...byFile.values()].reduce((s, v) => s + v.length, 0);
  console.log(`解析到 ${byFile.size} 个文件，共 ${totalIssues} 条问题`);

  // 只处理 TS6133 和 TS6192
  const filtered = new Map();
  for (const [filePath, issues] of byFile) {
    const relevant = issues.filter(i =>
      i.code === 'TS6133' || i.code === 'TS6192' || i.code === 'TS6196'
    );
    if (relevant.length > 0) {
      filtered.set(filePath, relevant);
    }
  }

  const filteredIssues = [...filtered.values()].reduce((s, v) => s + v.length, 0);
  console.log(`过滤后 ${filtered.size} 个文件，${filteredIssues} 条未用 import\n`);

  const results = [];
  for (const [filePath, issues] of filtered) {
    const result = processFile(filePath, issues);
    if (!result.skipped) {
      results.push(result);
      console.log(`${result.changed ? '✓' : '·'} ${filePath} (${result.issueCount} 条)`);
    }
  }

  const changedCount = results.filter(r => r.changed).length;
  const totalProcessed = results.reduce((s, r) => s + r.issueCount, 0);

  console.log(`\n处理完成: ${changedCount} 文件改写，${totalProcessed} 条问题清除`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] 未实际写入文件');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
