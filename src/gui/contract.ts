// 搬家垫片：契约本体在 @plastic/core（storage/schema.ts 依赖它就搬过去了；core 不得反向依赖插件包）。
// 插件里 30+ 处 `../gui/contract.ts` 与浏览器半侧 20+ 处 `../../src/gui/contract.ts` 由这里解析，一个不用改。
export * from '@plastic/core/gui/contract.ts'
