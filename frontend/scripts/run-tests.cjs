/* eslint-disable */
// 测试运行器：为 tsc 产物补上 CJS 声明与「@/」路径别名，然后运行全部 *.test.js
const fs = require('fs')
const path = require('path')
const Module = require('module')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '.test-build')
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(outDir, request.slice(2))
  }
  return origResolve.call(this, request, ...rest)
}

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.name.endsWith('.test.js')) files.push(full)
  }
  return files
}

for (const file of walk(outDir)) {
  console.log(`\n--- ${path.relative(outDir, file)} ---`)
  require(file)
}
