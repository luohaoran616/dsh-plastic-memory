/** 列表读取的共用状态机：按查询参数取一页，本地的增删改就地反映，不整页重拉。 */
import { useCallback, useEffect, useState } from 'react'
import { useGateway } from '../gateway.tsx'
import type { GatewayError, RecordQuery, RecordPage, RecordView } from '../gateway.impl.ts'

export interface RecordsState {
  status: 'loading' | 'ready' | 'error'
  records: RecordView[]
  page: Omit<RecordPage, 'records'> | undefined
  error: GatewayError | undefined
  /** 重新读取当前页（同名参数，nonce 变化触发）。 */
  reload: () => void
  /** 就地换掉一条（编辑保存、恢复之后）。 */
  patch: (record: RecordView) => void
  /** 就地去掉一条（软删之后）。 */
  drop: (id: string) => void
}

/** 查询参数只收原始值：effect 的依赖必须是字面量，不能是每次渲染都新建的对象。 */
export interface RecordsInput {
  scope?: string
  q?: string
  status?: 'active' | 'deleted'
  limit?: number
  offset?: number
  /** 外部要求重读时加一（与 internalNonce 相加）。 */
  nonce?: number
}

export function useRecords(input: RecordsInput): RecordsState {
  const gateway = useGateway()
  const { scope, q, status, limit, offset = 0, nonce = 0 } = input
  const [internalNonce, setInternalNonce] = useState(0)
  const [state, setState] = useState<{ status: RecordsState['status']; page?: RecordPage; error?: GatewayError }>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState(previous => ({ status: 'loading', ...(previous.page === undefined ? {} : { page: previous.page }) }))
    const query: RecordQuery = {
      ...(scope === undefined ? {} : { scope }),
      ...(q === undefined || q === '' ? {} : { q }),
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      offset,
    }
    void (async () => {
      const result = await gateway.listRecords(query)
      if (cancelled) return
      if (!result.ok) {
        setState({ status: 'error', error: result.error })
        return
      }
      setState({ status: 'ready', page: result.value })
    })()
    return () => { cancelled = true }
  }, [gateway, scope, q, status, limit, offset, nonce, internalNonce])

  const reload = useCallback(() => { setInternalNonce(value => value + 1) }, [])
  const patch = useCallback((record: RecordView) => {
    setState(previous => previous.page === undefined
      ? previous
      : { ...previous, page: { ...previous.page, records: previous.page.records.map(item => (item.id === record.id ? record : item)) } })
  }, [])
  const drop = useCallback((id: string) => {
    setState(previous => previous.page === undefined
      ? previous
      : { ...previous, page: { ...previous.page, records: previous.page.records.filter(item => item.id !== id) } })
  }, [])

  return {
    status: state.status,
    records: state.page?.records ?? [],
    page: state.page === undefined ? undefined : { limit: state.page.limit, offset: state.page.offset, hasMore: state.page.hasMore },
    error: state.error,
    reload,
    patch,
    drop,
  }
}
