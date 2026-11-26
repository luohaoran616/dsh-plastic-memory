/**
 * Vite 的 `?raw` 导入：把样式文件当字符串读进来（用例里检查令牌是否都有定义）。
 * 宿主主题的 tsconfig 不引 vite/client 类型，这里补一条环境声明。
 */
declare module '*.css?raw' {
  const content: string
  export default content
}
