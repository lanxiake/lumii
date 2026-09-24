#!/usr/bin/env node
/**
 * K7-1: 删除未用 import —— 文本拼接版
 *
 * 设计约束（踩过两次坑之后定的）：
 *   1. 只做文本拼接：AST 只用来算"要删的字节范围"，其余字节一个不动。
 *      （旧版用 ts.createPrinter 重印整个文件 → 全文重排 + 行尾 LF→CRLF，127 文件被无意义改写）
 *   2. 删除范围**按 import 声明成组计算**：把连续被删的 specifier 合并成一个范围。
 *      （逐条算会撞车：删最后一个元素时吃它前面的逗号，删倒数第二个时又吃它后面的逗号，
 *        同一个逗号被两条范围覆盖，逆序 splice 后坐标漂移，会把 `}` 一起吃掉）
 *   3. 写回前必须能**重新解析**（parseDiagnostics 为空），否则整文件拒绝写入并报错。
 *      （两道防线里这条是最硬的：语法坏了就没得商量）
 *   4. 格式审计：行尾类型不变、无悬空 \r、尾部换行不变、连续空行不变多。
 *
 * 范围：只处理位置落在 ImportDeclaration 内的 TS6133 / TS6196 / TS6192。
 *      其余（未用参数、未用局部、私有死声明）打印为 out-of-scope，交后续批次。
 *
 * 用法：node verify/k7-1-remove-unused-imports.mjs < tsc-output.txt [--dry-run]
 */

import fs from 'fs';
import ts from 'typescript';

const DRY = process.argv.includes('--dry-run');

function parseIssues(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/);
    if (!m) continue;
    const nameM = m[5].match(/'([^']+)'/);
    out.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], name: nameM ? nameM[1] : null, raw: line });
  }
  return out;
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/** 找包含该位置的最内层 ImportDeclaration */
function findImportAt(sf, pos) {
  let found = null;
  (function walk(node) {
    if (pos < node.getFullStart() || pos >= node.getEnd()) return;
    if (ts.isImportDeclaration(node)) found = node;
    ts.forEachChild(node, walk);
  })(sf);
  return found;
}

/** 整条 import 语句 + 行尾换行 */
function wholeDeclRange(sf, decl) {
  const text = sf.text;
  let end = decl.getEnd();
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  if (text[end] === '\r' && text[end + 1] === '\n') end += 2;
  else if (text[end] === '\n') end += 1;
  return [decl.getStart(sf), end];
}

/**
 * 一段连续被删的 specifier [from..to]（索引闭区间）→ 一个删除范围。
 * 段后还有元素：吃「段尾元素之后的逗号」+ 空白（跨行时连换行与缩进一起）。
 * 段已到末尾：吃「段首元素之前的逗号」+ 段。
 * 两种情况吃的是**不同的逗号**（段间必有保留元素隔着），所以范围天然互不重叠。
 */
function runRange(sf, els, from, to) {
  const text = sf.text;
  if (to < els.length - 1) {
    const start = els[from].getStart(sf);
    let j = els[to].getEnd();
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
    if (text[j] !== ',') return [start, els[to].getEnd()]; // 不该发生
    let k = j + 1;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    if (text[k] === '\r' && text[k + 1] === '\n') k += 2;
    else if (text[k] === '\n') k += 1;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    return [start, k];
  }
  const end = els[to].getEnd();
  let i = els[from].getStart(sf) - 1;
  let guard = 0;
  while (i >= 0 && guard++ < 200 && /\s/.test(text[i])) i--;
  if (i >= 0 && text[i] === ',') return [i, end];
  return [els[from].getStart(sf), end];
}

/** 一条 import 声明里，要删掉 names 这些本地名 → 一组不重叠的删除范围 */
function rangesForDecl(sf, decl, names) {
  const clause = decl.importClause;
  if (!clause) return { ranges: [wholeDeclRange(sf, decl)], matched: 0 };

  // 整条语句未用
  if (names.has('__WHOLE__')) return { ranges: [wholeDeclRange(sf, decl)], matched: names.size };

  let matched = 0;
  const ranges = [];

  // 默认导入
  const keepDefault = !(clause.name && names.has(clause.name.text));
  if (clause.name && !keepDefault) matched++;

  // 命名空间导入
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    if (names.has(clause.namedBindings.name.text)) {
      return { ranges: [wholeDeclRange(sf, decl)], matched: matched + 1 };
    }
    return { ranges, matched };
  }

  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    const els = clause.namedBindings.elements;
    const removed = els.map((e, i) => (names.has(e.name.text) ? i : -1)).filter((i) => i >= 0);
    matched += removed.length;

    if (removed.length === els.length) {
      // 全部命名导入都要删
      if (keepDefault && clause.name) {
        ranges.push([clause.name.getEnd(), clause.namedBindings.getEnd()]);
      } else {
        return { ranges: [wholeDeclRange(sf, decl)], matched };
      }
    } else if (removed.length > 0) {
      // 连续段合并
      let i = 0;
      while (i < removed.length) {
        let j = i;
        while (j + 1 < removed.length && removed[j + 1] === removed[j] + 1) j++;
        ranges.push(runRange(sf, els, removed[i], removed[j]));
        i = j + 1;
      }
    }
  }

  if (!keepDefault && clause.name) {
    // 默认导入被删：有命名导入就只吃 "Name, "，否则整条删
    if (clause.namedBindings) {
      ranges.push([clause.name.getStart(sf), clause.namedBindings.getStart(sf)]);
    } else {
      ranges.push(wholeDeclRange(sf, decl));
    }
  }

  return { ranges, matched };
}

function main() {
  const input = fs.readFileSync(0).toString('utf8');
  const issues = parseIssues(input);

  const byFile = new Map();
  for (const it of issues) {
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(it);
  }

  const report = [];
  const outOfScope = [];
  const failures = [];
  const unmatchedIssues = [];
  let applied = 0;
  let bytesRemoved = 0;
  let coveredTotal = 0;

  for (const [file, list] of byFile) {
    if (!fs.existsSync(file)) { failures.push(`缺少文件 ${file}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));

    // 按 import 声明归组
    const declMap = new Map(); // decl -> Set<name>
    const inScope = []; // 落在 import 内的 issue（可能算出范围，也可能算不出）
    for (const issue of list) {
      const pos = sf.getPositionOfLineAndCharacter(issue.line - 1, issue.col - 1);
      const decl = findImportAt(sf, pos);
      if (!decl) { outOfScope.push(issue); continue; }
      inScope.push(issue);
      if (!declMap.has(decl)) declMap.set(decl, new Set());
      const bucket = declMap.get(decl);
      if (issue.code === 'TS6192' || !issue.name) bucket.add('__WHOLE__');
      else bucket.add(issue.name);
    }

    const ranges = [];
    for (const [decl, names] of declMap) {
      const { ranges: rs } = rangesForDecl(sf, decl, names);
      for (const r of rs) ranges.push(r);
    }
    if (ranges.length === 0) { unmatchedIssues.push(...inScope); continue; }

    // 硬校验：范围必须两两不重叠、且不越过文件边界
    ranges.sort((a, b) => a[0] - b[0]);
    let ok = true;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i][0] < 0 || ranges[i][1] > text.length || ranges[i][0] >= ranges[i][1]) {
        failures.push(`范围越界: ${file} [${ranges[i]}]`); ok = false; break;
      }
      if (i > 0 && ranges[i][0] < ranges[i - 1][1]) {
        failures.push(`范围重叠: ${file} [${ranges[i - 1]}] ∩ [${ranges[i]}]`); ok = false; break;
      }
    }
    if (!ok) continue;

    // 逆序 splice
    let next = text;
    for (let i = ranges.length - 1; i >= 0; i--) {
      next = next.slice(0, ranges[i][0]) + next.slice(ranges[i][1]);
    }

    // 硬门禁：改完必须还能解析
    const reparsed = ts.createSourceFile(file, next, ts.ScriptTarget.Latest, true, scriptKind(file));
    if (reparsed.parseDiagnostics && reparsed.parseDiagnostics.length > 0) {
      const d = reparsed.parseDiagnostics[0];
      failures.push(`语法坏掉，拒绝写入: ${file} — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} @ ${d.start}`);
      continue;
    }

    // 格式审计
    const hasCrlf = (s) => /\r\n/.test(s);
    const strayCr = (s) => (s.match(/\r(?!\n)/g) || []).length;
    const blanks = (s) => (s.match(/\n[ \t]*\n[ \t]*\n/g) || []).length;
    const tail = (s) => s.length - s.replace(/\n+$/, '').length;
    if (hasCrlf(text) !== hasCrlf(next) || strayCr(next) > strayCr(text)
        || tail(text) !== tail(next) || blanks(next) > blanks(text)) {
      failures.push(`格式漂移: ${file}`);
      continue;
    }

    if (next !== text) {
      if (!DRY) fs.writeFileSync(file, next, 'utf8');
      applied += ranges.length;
      bytesRemoved += text.length - next.length;
      coveredTotal += inScope.length;
      report.push({ file, n: ranges.length, bytes: text.length - next.length });
    }
  }

  for (const r of report) console.log(`✓ ${r.file}  (−${r.n} 个范围, ${r.bytes} 字节)`);
  console.log(`\n处理完成：${report.length} 文件改写，${applied} 个删除范围，共 ${bytesRemoved} 字节`);
  console.log(`对账：输入 ${issues.length} 条 = 覆盖 ${coveredTotal} + 超范围 ${outOfScope.length} + 未匹配 ${unmatchedIssues.length} + 失败 ${failures.length}`);
  if (unmatchedIssues.length) {
    console.log('\n未匹配（在 import 内但没算出范围）：');
    for (const u of unmatchedIssues.slice(0, 20)) console.log('  ' + u.raw);
    if (unmatchedIssues.length > 20) console.log(`  …另 ${unmatchedIssues.length - 20} 条`);
  }
  if (outOfScope.length) {
    const byCode = {};
    for (const o of outOfScope) byCode[o.code] = (byCode[o.code] || 0) + 1;
    console.log(`\n超出本批范围（非 import 位置）${outOfScope.length} 条：` +
      Object.entries(byCode).map(([k, v]) => `${k}×${v}`).join('  '));
  }
  if (failures.length) {
    console.log(`\n⚠ 失败/跳过 ${failures.length} 条：`);
    for (const f of failures) console.log('  ' + f);
    process.exitCode = 2;
  }
  if (DRY) console.log('\n[DRY RUN] 未写入');
}

main();
