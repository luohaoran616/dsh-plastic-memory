/**
 * 文案表节选：来自 `client/locales.ts`（仓库根下同一路径）的 `zh` 字典，复制于 2026-11-25。
 * 只取被复制组件（MemoryCard / i18n 的日期格式）真正用到的键——整份字典连同 8 个 locales/*.ts 命名空间
 * 是给 DSH 面板用的，独立 WebUI 用不上（Task 6 context §1：文案表要复制，或抽一份纯文案表）。
 * 上游加键不自动同步；本 SPA 自己的文案在 `webui.ts`，两边合并见 `../locales.ts`。
 */
export const baseZh = {
  'scope.global': '全局',
  'scope.workspace': '本项目',

  'type.profile': '用户画像',
  'type.preference': '行为偏好',
  'type.knowledge': '事实与经验',
  'type.project': '项目信息',
  'type.reference': '参考引用',
  'type.procedure': '可复用流程',
  'type.decision': '决定',
  'type.commitment': '承诺',
  'type.person': '人物',

  'time.justNow': '刚刚',
  'time.monthDay': '{month} 月 {day} 日',
  'time.yearMonthDay': '{year} 年 {month} 月 {day} 日',
  'time.dayTime': '{date} {time}',

  'source.user-explicit': '你明确说的',
  'source.user-behavior': '从你的做法看出',
  'source.environment-observed': '从环境观察到',
  'source.agent-inferred': 'agent 推断',
  'source.agent-action-confirmed': 'agent 操作后确认',
  'source.none': '无出处',
  'memory.expired': '不再带入对话',
  'memory.expand': '展开',
  'memory.collapse': '收起',
  'memory.delegated.pending': '子 agent 写入 · 第 {depth} 层 · 待确认',
  'memory.delegated.main': '子 agent 写入 · 第 {depth} 层 · 主会话已接受',
  'memory.delegated.user': '子 agent 写入 · 第 {depth} 层 · 用户已改',
} as const
