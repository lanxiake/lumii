/**
 * 清理构建产物
 *
 * 用法: node scripts/clean-build.js
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

const dirs = ['out', 'release', 'node_modules/.cache']

for (const dir of dirs) {
  const fullPath = path.resolve(ROOT, dir)
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true })
    console.log(`\x1b[32m✓\x1b[0m 已清理 ${dir}/`)
  }
}

console.log('\n清理完成')
