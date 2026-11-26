#!/usr/bin/env node
// 把 package.json 改写成发布形状（唯一定义，host-common.sh 打包前调用；与 publishConfig 的结果一致）：
//   main 与 exports 取 publishConfig（main 没给时是 lib/index.js）；files 白名单取包自己的 files，没有时用插件的那份
//   （lib/locale/插件图标/cordis.patch.yml/README/第三方许可声明）；其余字段（含 scripts、devDependencies、
//   packageManager、prepublishOnly）原样保留供贡献者使用；只删掉依赖私有 e2e/ 的脚本。
//   optionalDependencies（@node-rs/jieba）原样保留；--without-optional 去掉它，供 host-smoke 验证「可选依赖没装上」的安装形状。
//   npm pack 不读 publishConfig，所以由这里代劳；根包与 @plastic/core（packages/core）走同一个脚本。
//   --core-tgz <path>：把 dependencies 里的 @plastic/core（workspace:*）指向一份本地 tarball。npm pack 原样保留
//   workspace 协议，宿主的 `plugin add` 在 workspace 之外解析不了它；pnpm publish 会把它改写成版本号，本地 tarball 顶替的就是这一步。
// 用法：node scripts/publish-shape.cjs <in package.json> <out package.json> [--without-optional] [--core-tgz <path>]
const fs = require('fs')
const path = require('path')

const USAGE = 'usage: publish-shape.cjs <in package.json> <out package.json> [--without-optional] [--core-tgz <path>]'

function fail(message) {
  console.error(message)
  console.error(USAGE)
  process.exit(2)
}

const args = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--without-optional') flags.set(arg, true)
  else if (arg === '--core-tgz') {
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) fail('--core-tgz 需要一个 tarball 路径')
    flags.set(arg, value)
    i += 1
  } else if (arg.startsWith('--')) fail(`未知参数：${arg}`)
  else positional.push(arg)
}
if (positional.length !== 2) fail(USAGE)
const [input, output] = positional

const p = JSON.parse(fs.readFileSync(input, 'utf8'))
const publish = p.publishConfig ?? {}
const out = {
  ...p,
  main: publish.main ?? 'lib/index.js',
  exports: publish.exports,
  files: p.files ?? ['lib', 'locale', 'assets/icon.svg', 'cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md'],
}
out.scripts = Object.fromEntries(Object.entries(p.scripts ?? {}).filter(([k]) => !k.includes('e2e')))
if (flags.has('--without-optional')) delete out.optionalDependencies
const coreTgz = flags.get('--core-tgz')
if (coreTgz !== undefined) {
  if (out.dependencies?.['@plastic/core'] === undefined) fail('--core-tgz：这个包不依赖 @plastic/core')
  out.dependencies['@plastic/core'] = `file:${path.resolve(coreTgz)}`
}
fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n')
