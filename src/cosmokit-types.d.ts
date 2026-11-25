// 声明产物要把 Config 推断类型里的 cosmokit 类型按包名引用；这里按包名取一次别名，tsc 才不再报 TS2742。
// 只有类型、没有运行时代码，编译产物里不落这个文件。
import type { Dict } from '@deepseek-ai/cosmokit'

/** 仅供声明产物命名：`@deepseek-ai/cosmokit` 的 Dict（Config 的 customTypes、scenes 字段）。 */
export type CosmokitDict<T> = Dict<T>
