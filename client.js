/**
 * Client half of dsh-session-git.
 *
 * 注册成会话内的一个 View 页签（slot `conversation.view`，id = 'git'）：
 * 每个会话各有一份，仓库默认取该会话自己的工作目录；
 * 左侧是带 lane 曲线的提交历史，右侧是提交详情 / diff / 工作区变更，
 * 上方是仓库选择器与分支、标签操作。所有数据都走 Host 的 /git-panel/api，
 * 请求统一带 `session=<sessionId>`，由 Host 侧解析成该会话的仓库。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-git',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'gitPanel'
    const VIEW_ID = 'git'
    const API = '/git-panel/api'
    /** 每个会话各自记住自己的仓库；key 后面拼 sessionId。 */
    const REPO_PREFIX = 'dsh-git-panel:repo'
    const ROW_H = 30
    const LANE_W = 13
    const LANE_PAD = 10
    /**
     * 泳道图最多画几列。all-refs 打开时分支多到几十条，图宽会吃掉整个列表宽度
     * （实测 34 列 = 449px，把 subject 挤成 15px），超出部分折叠成一条提示。
     */
    const LANE_MAX = 12

    /** lane 调色板：固定取模，保证同一列颜色稳定。 */
    const LANE_COLORS = [
      '#4f9cf9',
      '#f0a94c',
      '#5fc98b',
      '#d47ef0',
      '#f0746b',
      '#3fc2c9',
      '#e8d24d',
      '#8f9bd4',
    ]

    const en = {
      panel: 'Git',
      title: 'Git history',
      repo: 'Repository',
      browse: 'Browse',
      refresh: 'Refresh',
      history: 'History',
      workingTree: 'Working tree',
      branches: 'Branches',
      tags: 'Tags',
      stashes: 'Stashes',
      search: 'Filter message or author',
      allRefs: 'All refs',
      more: 'Load more',
      noRepo: 'Pick a repository',
      autoRepos: 'Repositories found in this session workspace',
      autoPick: 'Repositories in this workspace',
      rescan: 'Rescan',
      clean: 'Working tree clean',
      dirty: 'Uncommitted changes',
      emptyRepo: 'No commits yet',
      staged: 'staged',
      unstaged: 'unstaged',
      untracked: 'untracked',
      files: 'files',
      commit: 'Commit',
      author: 'Author',
      parents: 'Parents',
      noChanges: 'No file changes',
      pickFile: 'Select a file to see the diff',
      noDiff: 'No differences',
      loading: 'Loading…',
      current: 'current',
      checkout: 'Checkout',
      newBranch: 'New branch',
      newTag: 'New tag',
      remove: 'Delete',
      cancel: 'Cancel',
      create: 'Create',
      name: 'Name',
      message: 'Message',
      optional: 'optional',
      confirmDelete: 'Delete this ref?',
      checkoutDetached: 'Checkout detached',
      stash: 'Stash changes',
      popStash: 'Pop stash',
      noStashes: 'No stashes',
      copySha: 'Copy SHA',
      copied: 'Copied',
      path: 'Path',
      up: 'Up',
      reposHere: 'Repositories in this folder',
      usePath: 'Use this path',
      binary: 'binary',
      close: 'Close',
      commitAction: 'Commit',
      refreshHint: 'Reload repository state',
      filterHint: 'Substring match on message / author',
      commitMessage: 'Commit message',
      amend: 'Amend',
      stageAllHint: 'Stage all before commit',
      stage: 'Stage',
      unstage: 'Unstage',
      discard: 'Discard',
      confirmDiscard: 'Discard the unstaged changes of this file?',
      revert: 'Revert',
      revertHint: 'Create a new commit that undoes this one',
      confirmRevert: 'Revert this commit (creates a new commit)?',
      cherryPick: 'Cherry-pick',
      cherryHint: 'Apply this commit onto the current branch',
      merge: 'Merge',
      diffTitle: 'Changes',
      notRepoHere: 'Not a repository',
    }

    const zh = {
      panel: 'Git',
      title: 'Git 历史',
      repo: '仓库',
      browse: '浏览',
      refresh: '刷新',
      history: '历史',
      workingTree: '工作区',
      branches: '分支',
      tags: '标签',
      stashes: '暂存',
      search: '筛选提交信息或作者',
      allRefs: '所有引用',
      more: '加载更多',
      noRepo: '请选择仓库',
      autoRepos: '本会话工作区里找到的仓库',
      autoPick: '这个工作区里的仓库',
      rescan: '重扫',
      clean: '工作区干净',
      dirty: '存在未提交更改',
      emptyRepo: '还没有提交',
      staged: '已暂存',
      unstaged: '未暂存',
      untracked: '未跟踪',
      files: '个文件',
      commit: '提交',
      author: '作者',
      parents: '父提交',
      noChanges: '没有文件变更',
      pickFile: '选择左侧文件查看差异',
      noDiff: '没有差异',
      loading: '加载中…',
      current: '当前',
      checkout: '切换',
      newBranch: '新建分支',
      newTag: '新建标签',
      remove: '删除',
      cancel: '取消',
      create: '创建',
      name: '名称',
      message: '说明',
      optional: '可选',
      confirmDelete: '确认删除该引用？',
      checkoutDetached: '游离检出',
      stash: '暂存改动',
      popStash: '取出暂存',
      noStashes: '没有暂存记录',
      copySha: '复制 SHA',
      copied: '已复制',
      path: '路径',
      up: '上级',
      reposHere: '该目录下的仓库',
      usePath: '使用此路径',
      binary: '二进制',
      close: '关闭',
      commitAction: '提交',
      refreshHint: '重新读取仓库状态',
      filterHint: '按提交信息或作者子串过滤',
      commitMessage: '提交信息',
      amend: '修补上次提交',
      stageAllHint: '提交前暂存全部',
      stage: '暂存',
      unstage: '取消暂存',
      discard: '丢弃',
      confirmDiscard: '丢弃该文件未暂存的改动？',
      revert: '回滚',
      revertHint: '生成一个反向提交，撤销该提交的改动',
      confirmRevert: '回滚该提交（会生成新提交）？',
      cherryPick: '拣选',
      cherryHint: '把该提交应用到当前分支',
      merge: '合并',
      diffTitle: '改动内容',
      notRepoHere: '当前目录不是仓库',
    }

    function GitIcon({ size }) {
      const edge = size ?? 20
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('circle', { cx: 7, cy: 5, r: 2.1 }),
        h('circle', { cx: 7, cy: 19, r: 2.1 }),
        h('circle', { cx: 17, cy: 9, r: 2.1 }),
        h('path', { d: 'M7 7.1v9.8' }),
        h('path', { d: 'M17 11.1c0 4.2-3.4 4.6-7.6 5.3' }),
      )
    }

    const css = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 13,
      },
      topbar: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        // 嵌在会话视图里，不要自己糊一层底色，跟随会话背景。
        flexShrink: 0,
        flexWrap: 'wrap',
      },
      // 会话视图宽度跟着对话区走：两列都允许收缩，窄屏靠 ellipsis 撑住。
      body: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
      col: { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 },
      listCol: {
        flex: '1 1 55%',
        minWidth: 220,
        minHeight: 0,
      },
      detailCol: {
        flex: '1 1 45%',
        minWidth: 220,
        minHeight: 0,
        borderLeft: '1px solid var(--dsw-alias-border-l1)',
      },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      btnPrimary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        // brand-primary 在深色主题下偏亮，文字用底色反色才看得见。
        color: 'var(--dsw-alias-bg-base)',
        cursor: 'pointer',
        fontSize: 12,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      },
      input: {
        padding: '4px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '18px',
        outline: 'none',
        minWidth: 0,
      },
      tab: {
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: 12,
      },
      tabActive: {
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontSize: 12,
      },
      scroll: { flex: 1, minHeight: 0, overflow: 'auto' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px 0 0',
        height: ROW_H,
        cursor: 'pointer',
        borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)',
      },
      subject: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      meta: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap' },
      /** 固定宽度的作者/时间列：给 ellipsis 留出确定的空间，避免被右侧裁掉。 */
      authorCell: {
        flex: '0 0 auto',
        width: 76,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        textAlign: 'right',
      },
      timeCell: {
        flex: '0 0 auto',
        width: 84,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      },
      iconBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 18,
        padding: '0 6px',
        borderRadius: 5,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
      },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 17,
        padding: '0 6px',
        borderRadius: 9,
        fontSize: 11,
        lineHeight: '17px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      section: {
        padding: '8px 12px',
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      },
      item: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        fontSize: 12,
        cursor: 'pointer',
        minHeight: 22,
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        padding: '1px 5px',
        borderRadius: 4,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        lineHeight: '17px',
        whiteSpace: 'pre',
        overflow: 'auto',
        flex: 1,
        minHeight: 0,
      },
      modal: {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      },
      modalCard: {
        width: 'min(680px, 92vw)',
        maxHeight: '78vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        boxShadow: '0 18px 48px rgba(0,0,0,0.35)',
        overflow: 'hidden',
      },
      toast: {
        position: 'absolute',
        bottom: 14,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '6px 12px',
        borderRadius: 7,
        fontSize: 12,
        color: '#fff',
        zIndex: 70,
        maxWidth: '80%',
      },
    }

    /**
     * 把逆拓扑序提交分配到 lane 列，并记录每行进出 lane，
     * 供 SVG 片段绘制。
     */
    function layoutGraph(commits) {
      let lanes = []
      const rows = []
      let maxLane = 0
      for (const commit of commits) {
        let lane = lanes.indexOf(commit.sha)
        if (lane < 0) {
          lane = lanes.indexOf(null)
          if (lane < 0) {
            lane = lanes.length
            lanes.push(null)
          }
          lanes[lane] = commit.sha
        }
        const incoming = lanes.slice()
        lanes[lane] = commit.parents[0] ?? null
        const parentLanes = []
        for (const parent of commit.parents) {
          let slot = lanes.indexOf(parent)
          if (slot < 0) {
            slot = lanes.indexOf(null)
            if (slot < 0) {
              slot = lanes.length
              lanes.push(null)
            }
            lanes[slot] = parent
          }
          parentLanes.push({ sha: parent, lane: slot })
        }
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()
        const outgoing = lanes.slice()
        maxLane = Math.max(maxLane, incoming.length, outgoing.length)
        rows.push({ commit, lane, incoming, outgoing, parentLanes })
      }
      return { rows, laneCount: Math.max(1, maxLane) }
    }

    const laneX = (lane) => LANE_PAD + lane * LANE_W + LANE_W / 2

    /** 单行图元：直通线 + 节点 + 到父提交的连线。 */
    function GraphCell({ row, laneCount }) {
      // 列数封顶：超出的部分挤在一起画，宁可图形失真也不要把标题压没。
      const lanes = Math.min(laneCount, LANE_MAX)
      const width = LANE_PAD * 2 + lanes * LANE_W
      const mid = ROW_H / 2
      const parts = []
      const clamped = (lane) => (lane >= lanes ? lanes - 1 : lane)
      const count = Math.max(row.incoming.length, row.outgoing.length)
      for (let i = 0; i < count; i += 1) {
        if (i === row.lane) continue
        const incoming = row.incoming[i] != null
        const outgoing = row.outgoing[i] != null
        if (!incoming && !outgoing) continue
        const x = laneX(clamped(i))
        const y1 = incoming ? 0 : mid
        const y2 = outgoing ? ROW_H : mid
        parts.push(
          h('line', {
            key: `lane-${i}`,
            x1: x,
            y1,
            x2: x,
            y2,
            stroke: LANE_COLORS[i % LANE_COLORS.length],
            strokeWidth: 1.6,
            strokeOpacity: 0.75,
            strokeLinecap: 'round',
          }),
        )
      }
      parts.push(
        h('line', {
          key: 'stem',
          x1: laneX(clamped(row.lane)),
          y1: 0,
          x2: laneX(clamped(row.lane)),
          y2: mid,
          stroke: LANE_COLORS[row.lane % LANE_COLORS.length],
          strokeWidth: 1.6,
          strokeOpacity: 0.75,
        }),
      )
      for (const parent of row.parentLanes) {
        const x1 = laneX(clamped(row.lane))
        const x2 = laneX(clamped(parent.lane))
        if (x2 === x1) {
          parts.push(
            h('line', {
              key: `p-${parent.sha}`,
              x1,
              y1: mid,
              x2,
              y2: ROW_H,
              stroke: LANE_COLORS[parent.lane % LANE_COLORS.length],
              strokeWidth: 1.6,
              strokeOpacity: 0.75,
            }),
          )
        } else {
          parts.push(
            h('path', {
              key: `p-${parent.sha}`,
              d: `M ${x1} ${mid} C ${x1} ${mid + 9}, ${x2} ${ROW_H - 9}, ${x2} ${ROW_H}`,
              fill: 'none',
              stroke: LANE_COLORS[parent.lane % LANE_COLORS.length],
              strokeWidth: 1.6,
              strokeOpacity: 0.75,
            }),
          )
        }
      }
      parts.push(
        h('circle', {
          key: 'node',
          cx: laneX(clamped(row.lane)),
          cy: mid,
          r: 3.8,
          fill: 'var(--dsw-alias-bg-base)',
          stroke: LANE_COLORS[row.lane % LANE_COLORS.length],
          strokeWidth: 2,
        }),
      )
      return h(
        'svg',
        {
          width,
          height: ROW_H,
          viewBox: `0 0 ${width} ${ROW_H}`,
          style: { flex: '0 0 auto', display: 'block' },
          'aria-hidden': true,
        },
        parts,
      )
    }

    const pad2 = (value) => String(value).padStart(2, '0')

    function fmtTime(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
        date.getHours(),
      )}:${pad2(date.getMinutes())}`
    }

    /** 短日期：列表列宽有限，老提交只留 MM-DD HH:mm。 */
    function fmtShort(ms) {
      if (!ms) return ''
      const date = new Date(ms)
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(
        date.getMinutes(),
      )}`
    }

    /** 相对时间：只给最近的时间用，老时间仍显示日期。 */
    function fmtRelative(ms, locale) {
      if (!ms) return ''
      const diff = Date.now() - ms
      const minute = 60_000
      const hour = 60 * minute
      const day = 24 * hour
      if (locale === 'zh') {
        if (diff < minute) return '刚刚'
        if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
        if (diff < day) return `${Math.floor(diff / hour)} 小时前`
        if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`
        return fmtShort(ms)
      }
      if (diff < minute) return 'just now'
      if (diff < hour) return `${Math.floor(diff / minute)}m ago`
      if (diff < day) return `${Math.floor(diff / hour)}h ago`
      if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`
      return fmtShort(ms)
    }

    async function callJson(method, path, body) {
      const init = { method, headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(`${API}${path}`, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = { ok: false, error: `HTTP ${response.status}` }
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `HTTP ${response.status}`)
      }
      return payload
    }

    const refColor = (kind) => {
      if (kind === 'tag') return 'var(--dsw-alias-state-warn-primary)'
      if (kind === 'remote') return 'var(--dsw-alias-label-secondary)'
      if (kind === 'head') return 'var(--dsw-alias-state-success-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function RefChip({ item }) {
      return h(
        'span',
        {
          style: {
            ...css.chip,
            color: refColor(item.kind),
            borderColor: 'color-mix(in srgb, currentColor 40%, transparent)',
          },
          title: item.name,
        },
        item.head ? '◉ ' : '',
        item.name,
      )
    }

    /** 差异行着色。 */
    const diffLineStyle = (line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return { color: 'var(--dsw-alias-label-secondary)' }
      }
      if (line.startsWith('@@')) return { color: 'var(--dsw-alias-brand-primary)' }
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file')) {
        return { color: 'var(--dsw-alias-label-secondary)' }
      }
      if (line.startsWith('+')) {
        return { background: 'color-mix(in srgb, #3ecf8e 16%, transparent)', color: '#8fe3b8' }
      }
      if (line.startsWith('-')) {
        return { background: 'color-mix(in srgb, #f0746b 16%, transparent)', color: '#f5a09a' }
      }
      return undefined
    }

    function DiffView({ text, t }) {
      const lines = useMemo(() => String(text ?? '').split('\n'), [text])
      if (!lines.length || (lines.length === 1 && !lines[0])) {
        return h('div', { style: { ...css.meta, padding: '14px 12px' } }, t('noDiff'))
      }
      return h(
        'pre',
        { style: css.pre },
        lines.map((line, index) =>
          h('div', { key: index, style: diffLineStyle(line) }, line === '' ? ' ' : line),
        ),
      )
    }

    /** 顶栏状态徽标：把 staged/unstaged/untracked 三段计数写成短句。 */
    function dirtyLabel(counts, t) {
      if (!counts) return ''
      const parts = []
      if (counts.staged) parts.push(`${counts.staged} ${t('staged')}`)
      if (counts.unstaged) parts.push(`${counts.unstaged} ${t('unstaged')}`)
      if (counts.untracked) parts.push(`${counts.untracked} ${t('untracked')}`)
      return parts.length ? parts.join(' · ') : t('dirty')
    }

    function Panel({ t, sessionId }) {
      const locale = typeof navigator !== 'undefined' && navigator.language?.startsWith('zh') ? 'zh' : 'en'
      const localeRef = useRef(locale)
      localeRef.current = locale

      /** 该会话专属的仓库记忆 key；没有 sessionId 时退化成全局 key。 */
      const repoKey = sessionId ? `${REPO_PREFIX}:${sessionId}` : REPO_PREFIX
      /** 给 API 路径补上会话参数，Host 用它解析出该会话的工作目录。 */
      const withSession = useCallback(
        (path) => {
          if (!sessionId) return path
          const joiner = path.includes('?') ? '&' : '?'
          return `${path}${joiner}session=${encodeURIComponent(sessionId)}`
        },
        [sessionId],
      )

      const [info, setInfo] = useState(null)
      const [repo, setRepo] = useState('')
      const [status, setStatus] = useState(null)
      const [log, setLog] = useState({ commits: [], hasMore: false })
      const [refs, setRefs] = useState({ branches: [], tags: [], current: '' })
      const [stashes, setStashes] = useState([])
      const [tab, setTab] = useState('history')
      const [allRefs, setAllRefs] = useState(true)
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState('')
      const [detail, setDetail] = useState(null)
      const [diff, setDiff] = useState(null)
      const [diffPath, setDiffPath] = useState('')
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState(null)
      const [picker, setPicker] = useState(null)
      const [form, setForm] = useState(null)
      const [working, setWorking] = useState(null)
      const [commitMessage, setCommitMessage] = useState('')
      const [stageAll, setStageAll] = useState(true)

      const toastRef = useRef(null)
      const notify = useCallback((text, kind) => {
        setToast({ text, kind: kind ?? 'info' })
        if (toastRef.current) clearTimeout(toastRef.current)
        toastRef.current = setTimeout(() => setToast(null), 3600)
      }, [])

      /**
       * 会话视图区的高度是内容撑开的（.viewArea 是 flex:1 0 auto），
       * 面板里又有自己的滚动容器，不夹住就会把整页顶长、底部被输入框盖住。
       * 这里按视口算出可用高度，自己锁死，让内部列表滚动。
       */
      const rootRef = useRef(null)
      const [fitHeight, setFitHeight] = useState(0)
      const measure = useCallback(() => {
        const node = rootRef.current
        if (!node) return
        const top = node.getBoundingClientRect().top
        // 输入框浮在会话底部，遮住面板下沿，需要把它算进来。
        const seat = document.querySelector('[class*="composerSeat"]')
        const seatTop = seat ? seat.getBoundingClientRect().top : window.innerHeight
        const available = Math.min(window.innerHeight, seatTop) - top - 8
        setFitHeight(Math.max(220, Math.round(available)))
      }, [])

      useEffect(() => {
        measure()
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
        if (observer && rootRef.current) observer.observe(rootRef.current)
        window.addEventListener('resize', measure)
        // 布局稳定后再量一次，首帧可能还没拿到会话头部高度。
        const timer = setTimeout(measure, 120)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', measure)
          clearTimeout(timer)
        }
      }, [measure, sessionId])

      const fail = useCallback(
        (error) => notify(String(error?.message ?? error), 'error'),
        [notify],
      )

      const loadCore = useCallback(
        async (target) => {
          const args = target ? `?repo=${encodeURIComponent(target)}` : ''
          const data = await callJson('GET', withSession(`/status${args}`))
          setRepo(data.repo)
          setStatus(data)
          const refQuery = `?repo=${encodeURIComponent(data.repo)}`
          const [branchData, logData, stashData] = await Promise.all([
            callJson('GET', withSession(`/branches${refQuery}`)).catch(() => ({
              branches: [],
              tags: [],
              current: '',
            })),
            callJson(
              'GET',
              withSession(
                `/log${refQuery}&limit=400${allRefs ? '&all=1' : ''}${
                  query ? `&grep=${encodeURIComponent(query)}` : ''
                }`,
              ),
            ).catch(() => ({ commits: [], hasMore: false })),
            callJson('GET', withSession(`/stashes${refQuery}`))
              .then((payload) => payload.stashes ?? [])
              .catch(() => []),
          ])
          setRefs(branchData)
          setLog(logData)
          setStashes(stashData)
          return { data, logData }
        },
        [allRefs, query, withSession],
      )

      const boot = useCallback(async () => {
        setBusy(true)
        // 换会话时先把上一份仓库状态清干净，避免短暂显示别人的仓库。
        setRepo('')
        setStatus(null)
        setSelected('')
        setDetail(null)
        setDiff(null)
        setDiffPath('')
        try {
          const meta = await callJson('GET', withSession(''))
          setInfo(meta)
          // 仓库选择顺序：本会话上次选中的 > 该会话工作目录探测到的仓库 > 空态。
          // 不读全局旧 key，否则一个会话选过的仓库会串到别的会话里。
          let remembered = ''
          try {
            remembered = window.localStorage?.getItem(repoKey) ?? ''
          } catch {
            remembered = ''
          }
          const target = remembered || meta.defaultRepo
          if (target) {
            try {
              await loadCore(target)
            } catch (error) {
              if (!remembered) throw error
              // 记住的路径失效了（移动/删除），退回空态并清掉缓存。
              try {
                window.localStorage?.removeItem(repoKey)
              } catch {
                /* 隐私模式下 localStorage 会抛，忽略 */
              }
              setRepo('')
              notify(String(error?.message ?? error), 'error')
            }
          }
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
      }, [fail, loadCore, notify, repoKey, withSession])

      useEffect(() => {
        void boot()
        // 会话号变了等于换了仓库上下文：清空上一份状态再重新探测。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      useEffect(() => {
        if (!repo) return
        let cancelled = false
        void (async () => {
          try {
            const data = await callJson(
              'GET',
              withSession(
                `/log?repo=${encodeURIComponent(repo)}&limit=400${allRefs ? '&all=1' : ''}${
                  query ? `&grep=${encodeURIComponent(query)}` : ''
                }`,
              ),
            )
            if (!cancelled) setLog(data)
          } catch (error) {
            if (!cancelled) fail(error)
          }
        })()
        return () => {
          cancelled = true
        }
        // repo 变化由 loadCore 负责
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [allRefs, query])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          await loadCore(repo)
          if (selected) await openCommit(selected)
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [loadCore, repo, selected, fail])

      /**
       * 重新扫一遍会话工作区。工作区里新 clone 了仓库、或刚才还没建仓库时用，
       * 顺便把下拉里的候选刷新掉，不用整页刷新。
       */
      const rescan = useCallback(async () => {
        setBusy(true)
        try {
          const meta = await callJson('GET', withSession(''))
          setInfo(meta)
          const target = repo || meta.defaultRepo
          if (target) await loadCore(target)
        } catch (error) {
          fail(error)
        } finally {
          setBusy(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [fail, loadCore, repo, withSession])

      const openCommit = useCallback(
        async (sha) => {
          setSelected(sha)
          setTab('history')
          setDiff(null)
          setDiffPath('')
          try {
            const data = await callJson(
              'GET',
              withSession(
                `/commit?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}`,
              ),
            )
            setDetail(data)
            if (data.files?.length) {
              const first = data.files[0].path
              setDiffPath(first)
              const patch = await callJson(
                'GET',
                withSession(
                  `/diff?repo=${encodeURIComponent(repo)}&sha=${encodeURIComponent(sha)}&path=${encodeURIComponent(
                    first,
                  )}`,
                ),
              )
              setDiff(patch)
            }
          } catch (error) {
            fail(error)
          }
        },
        [fail, repo, withSession],
      )

      const openFileDiff = useCallback(
        async (path, mode, sha) => {
          setDiffPath(path)
          setDiff(null)
          try {
            const params = new URLSearchParams({ repo, path, mode: mode ?? 'commit' })
            if (sha) params.set('sha', sha)
            if (sessionId) params.set('session', sessionId)
            const patch = await callJson('GET', `/diff?${params.toString()}`)
            setDiff(patch)
          } catch (error) {
            fail(error)
          }
        },
        [fail, repo, sessionId],
      )

      const loadWorking = useCallback(async () => {
        try {
          const data = await callJson(
            'GET',
            withSession(`/working?repo=${encodeURIComponent(repo)}`),
          )
          setWorking(data)
        } catch (error) {
          fail(error)
        }
      }, [fail, repo, withSession])

      useEffect(() => {
        if (!repo) return
        if (tab === 'working') void loadWorking()
      }, [tab, loadWorking, repo])

      const act = useCallback(
        async (type, payload) => {
          setBusy(true)
          try {
            const result = await callJson('POST', '/action', {
              repo,
              session: sessionId || undefined,
              type,
              ...(payload ?? {}),
            })
            notify(result.output ? String(result.output).split('\n')[0] : 'ok', 'success')
            setDetail(null)
            setDiff(null)
            // 提交成功后清空输入框，避免重复提交同一条消息。
            if (type === 'commit') setCommitMessage('')
            await loadCore(repo)
            if (tab === 'working') {
              await loadWorking()
              // 刚提交掉的文件不再存在，把右侧 diff 一起清掉，免得留着一条幽灵改动。
              setDiffPath('')
              setDiff(null)
            }
          } catch (error) {
            fail(error)
          } finally {
            setBusy(false)
          }
        },
        [fail, loadCore, loadWorking, notify, repo, sessionId, tab],
      )

      const openPicker = useCallback(async (startPath) => {
        try {
          const base = startPath || (status?.repo ?? info?.sessionCwd ?? info?.home ?? '')
          const data = await callJson('GET', `/fs?path=${encodeURIComponent(base)}`)
          const repos = await callJson('GET', `/repos?path=${encodeURIComponent(base)}&depth=2`).catch(
            () => ({ repos: [] }),
          )
          setPicker({ ...data, repos: repos.repos ?? [] })
        } catch (error) {
          fail(error)
        }
      }, [fail, info, status])

      const chooseRepo = useCallback(
        async (path) => {
          setPicker(null)
          setBusy(true)
          try {
            await loadCore(path)
            try {
              window.localStorage?.setItem(repoKey, path)
            } catch {
              /* 存不下就算了，选择在本次会话内有效 */
            }
            setSelected('')
            setDetail(null)
            setDiff(null)
          } catch (error) {
            fail(error)
          } finally {
            setBusy(false)
          }
        },
        [fail, loadCore, repoKey],
      )

      const graph = useMemo(() => layoutGraph(log.commits ?? []), [log.commits])

      const dirty = status && !status.status?.clean
      const nothingPicked = !repo
      // Host 按会话工作目录扫出来的候选仓库：多于一个时顶栏给个下拉，空态里也直接列出来。
      const autoRepos = Array.isArray(info?.autoRepos) ? info.autoRepos : []

      /** 提交列表。 */
      const historyList = h(
        'div',
        { style: css.scroll },
        (log.commits ?? []).length === 0
          ? h(
              'div',
              { style: { padding: '16px 14px' } },
              h(
                'div',
                { style: { ...css.meta, marginBottom: autoRepos.length ? 8 : 0 } },
                status?.empty ? t('emptyRepo') : t('noRepo'),
              ),
              // 没有仓库时把自动扫到的仓库直接铺成可点列表，不用先开浏览框。
              autoRepos.length
                ? h(
                    'div',
                    null,
                    h('div', { style: css.section }, t('autoPick')),
                    autoRepos.map((item) =>
                      h(
                        'div',
                        {
                          key: item,
                          style: { ...css.item, padding: '4px 0', cursor: 'pointer' },
                          title: item,
                          onClick: () => void chooseRepo(item),
                        },
                        h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, '◈'),
                        h(
                          'span',
                          {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          item,
                        ),
                      ),
                    ),
                  )
                : null,
            )
          : graph.rows.map((row) =>
              h(
                'div',
                {
                  key: row.commit.sha,
                  style: {
                    ...css.row,
                    background:
                      selected === row.commit.sha ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  },
                  onClick: () => void openCommit(row.commit.sha),
                  title: `${row.commit.short} ${row.commit.subject}`,
                },
                h(GraphCell, { row, laneCount: graph.laneCount }),
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      flex: '0 0 auto',
                      maxWidth: '30%',
                      overflow: 'hidden',
                    },
                  },
                  row.commit.refs.slice(0, 3).map((item, index) =>
                    h(RefChip, { key: `${item.kind}-${item.name}-${index}`, item }),
                  ),
                ),
                h('div', { style: css.subject }, row.commit.subject),
                h('div', { style: css.authorCell, title: row.commit.author }, row.commit.author),
                h(
                  'div',
                  { style: css.timeCell, title: fmtTime(row.commit.commitTime) },
                  fmtRelative(row.commit.commitTime, localeRef.current),
                ),
              ),
            ),
        log.hasMore
          ? h(
              'div',
              { style: { padding: '10px 14px' } },
              h('button', { style: css.btn, onClick: () => void refresh() }, t('more')),
            )
          : null,
      )

      /** 工作区列表：每行带 暂存 / 取消暂存 / 丢弃 三个行内动作。 */
      const workingList = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        // 提交区常驻在列表上方：写消息 → 提交。
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '10px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
            },
          },
          h('textarea', {
            style: { ...css.input, minHeight: 52, resize: 'vertical', fontFamily: 'inherit' },
            placeholder: t('commitMessage'),
            value: commitMessage,
            onChange: (event) => setCommitMessage(event.target.value),
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'button',
              {
                style: css.btnPrimary,
                disabled: busy || !commitMessage.trim(),
                onClick: () => void act('commit', { message: commitMessage, stageAll }),
              },
              t('commitAction'),
            ),
            h(
              'button',
              {
                style: css.btn,
                disabled: busy || !commitMessage.trim(),
                onClick: () => void act('commit', { message: commitMessage, amend: true, stageAll }),
              },
              t('amend'),
            ),
            h(
              'label',
              { style: { ...css.meta, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: stageAll,
                onChange: (event) => setStageAll(event.target.checked),
              }),
              t('stageAllHint'),
            ),
            h('span', { style: { ...css.meta, flex: 1, textAlign: 'right' } },
              `${t('staged')} ${working?.staged ?? 0} · ${t('unstaged')} ${working?.unstaged ?? 0} · ${t('untracked')} ${working?.untracked ?? 0}`),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '8px 12px', flexWrap: 'wrap' } },
          h('button', { style: css.btn, onClick: () => void loadWorking() }, t('refresh')),
          h(
            'button',
            { style: css.btn, onClick: () => void act('stash'), disabled: !working?.entries?.length },
            t('stash'),
          ),
          h(
            'button',
            { style: css.btn, onClick: () => setTab('refs') },
            `${t('stashes')} (${stashes.length})`,
          ),
        ),
        h(
          'div',
          { style: css.scroll },
          !working
            ? h('div', { style: { ...css.meta, padding: '18px 14px' } }, t('loading'))
            : working.entries.length === 0
              ? h('div', { style: { ...css.meta, padding: '18px 14px' } }, t('clean'))
              : working.entries.map((entry, index) => {
                  const filePath = entry.path.includes(' -> ') ? entry.path.split(' -> ')[1] : entry.path
                  const untracked = entry.index === '?'
                  const stagedOnly = entry.index !== ' ' && entry.index !== '?' && entry.worktree === ' '
                  return h(
                    'div',
                    {
                      key: `${entry.path}-${index}`,
                      style: {
                        ...css.item,
                        gap: 8,
                        borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 45%, transparent)',
                        background:
                          diffPath === filePath && tab === 'working'
                            ? 'var(--dsw-alias-bg-layer-2)'
                            : 'transparent',
                      },
                      onClick: () =>
                        void openFileDiff(filePath, untracked || entry.index === ' ' ? 'working' : 'staged'),
                    },
                    h(
                      'span',
                      {
                        style: { ...css.code, minWidth: 26, textAlign: 'center' },
                        title: `${entry.index}${entry.worktree}`,
                      },
                      `${entry.index}${entry.worktree}`.trim() || '?',
                    ),
                    h(
                      'span',
                      { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
                      entry.path,
                    ),
                    h(
                      'span',
                      {
                        style: css.iconBtn,
                        title: t('stage'),
                        onClick: (event) => {
                          event.stopPropagation()
                          void act('stage', { path: filePath })
                        },
                      },
                      t('stage'),
                    ),
                    stagedOnly
                      ? h(
                          'span',
                          {
                            style: css.iconBtn,
                            title: t('unstage'),
                            onClick: (event) => {
                              event.stopPropagation()
                              void act('unstage', { path: filePath })
                            },
                          },
                          t('unstage'),
                        )
                      : h(
                          'span',
                          {
                            style: { ...css.iconBtn, color: 'var(--dsw-alias-state-error-primary)' },
                            title: t('discard'),
                            onClick: (event) => {
                              event.stopPropagation()
                              if (typeof window.confirm === 'function' && !window.confirm(t('confirmDiscard'))) return
                              void act('discard', { path: filePath })
                            },
                          },
                          t('discard'),
                        ),
                  )
                }),
        ),
      )

      /** 右侧详情。 */
      const detailPane = (() => {
        if (tab === 'working') {
          return h(
            'div',
            { style: css.col },
            h(
              'div',
              {
                style: {
                  padding: '8px 12px',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11,
                  color: 'var(--dsw-alias-label-secondary)',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                title: diffPath,
              },
              diffPath || t('diffTitle'),
            ),
            diff
              ? h(DiffView, { text: diff.diff, t })
              : h('div', { style: { ...css.meta, padding: '14px 12px' } }, t('pickFile')),
          )
        }
        if (!detail) {
          return h(
            'div',
            { style: { ...css.meta, padding: '18px 14px' } },
            busy ? t('loading') : t('pickFile'),
          )
        }
        return h(
          'div',
          { style: { ...css.col, height: '100%' } },
          h(
            'div',
            { style: { padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            h('div', { style: { fontSize: 14, fontWeight: 600, wordBreak: 'break-word' } }, detail.subject),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
              h('span', { style: css.code }, detail.short),
              h('span', { style: css.meta }, `${detail.author} <${detail.authorEmail}>`),
              h('span', { style: css.meta }, fmtTime(detail.commitTime)),
              h(
                'span',
                {
                  style: { ...css.chip, color: 'var(--dsw-alias-state-success-primary)' },
                  title: t('copySha'),
                  onClick: () => {
                    void navigator.clipboard?.writeText(detail.sha).then(
                      () => notify(t('copied'), 'success'),
                      () => undefined,
                    )
                  },
                },
                // 纯二进制提交的 numstat 合计恒为 0，显示 +0 −0 会误读成「没改动」。
                detail.files.length > 0 && detail.files.every((file) => file.binary)
                  ? t('binary')
                  : `+${detail.additions} −${detail.deletions}`,
              ),
            ),
            detail.body
              ? h(
                  'div',
                  { style: { ...css.meta, marginTop: 6, whiteSpace: 'pre-wrap' } },
                  detail.body.slice(0, 600),
                )
              : null,
            // 提交级动作：游离检出、在此建分支、在此打标签、回滚、拣选。
            h(
              'div',
              { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
              h(
                'button',
                {
                  style: css.btn,
                  disabled: busy,
                  onClick: () => void act('checkout-detach', { ref: detail.sha }),
                },
                t('checkoutDetached'),
              ),
              h(
                'button',
                {
                  style: css.btn,
                  disabled: busy,
                  onClick: () =>
                    setForm({ kind: 'branch', name: '', at: detail.sha }),
                },
                t('newBranch'),
              ),
              h(
                'button',
                {
                  style: css.btn,
                  disabled: busy,
                  onClick: () =>
                    setForm({ kind: 'tag', name: '', message: '', at: detail.sha }),
                },
                t('newTag'),
              ),
              h(
                'button',
                {
                  style: css.btn,
                  disabled: busy,
                  title: t('revertHint'),
                  onClick: () => {
                    if (typeof window.confirm === 'function' && !window.confirm(t('confirmRevert'))) return
                    void act('revert', { sha: detail.sha, mainline: detail.parents.length > 1 ? 1 : undefined })
                  },
                },
                t('revert'),
              ),
              h(
                'button',
                {
                  style: css.btn,
                  disabled: busy,
                  title: t('cherryHint'),
                  onClick: () => void act('cherry-pick', { sha: detail.sha }),
                },
                t('cherryPick'),
              ),
            ),
          ),
          detail.files.length === 0
            ? h('div', { style: { ...css.meta, padding: '12px 14px' } }, t('noChanges'))
            : h(
                'div',
                { style: { maxHeight: 176, overflow: 'auto', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
                detail.files.map((file) =>
                  h(
                    'div',
                    {
                      key: file.path,
                      style: {
                        ...css.item,
                        gap: 8,
                        background:
                          diffPath === file.path ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      },
                      onClick: () => void openFileDiff(file.path, 'commit', detail.sha),
                    },
                    h(
                      'span',
                      {
                        style: {
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontSize: 11.5,
                        },
                      },
                      file.path,
                    ),
                    file.binary
                      ? h('span', { style: css.meta }, t('binary'))
                      : h(
                          'span',
                          { style: { ...css.meta, fontFamily: 'ui-monospace, monospace' } },
                          `+${file.additions} −${file.deletions}`,
                        ),
                  ),
                ),
              ),
          h(
            'div',
            { style: { padding: '6px 12px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
            diffPath,
          ),
          diff
            ? h(DiffView, { text: diff.diff, t })
            : h('div', { style: { ...css.meta, padding: '10px 12px' } }, t('loading')),
        )
      })()

      /** 分支/标签面板（右侧上方按钮区常驻）。 */
      const sidebarBranchList = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h(
          'div',
          { style: { display: 'flex', gap: 6, padding: '8px 12px', flexWrap: 'wrap' } },
          h(
            'button',
            { style: css.btn, onClick: () => setForm({ kind: 'branch', name: '', at: selected || 'HEAD' }) },
            `+ ${t('newBranch')}`,
          ),
          h(
            'button',
            { style: css.btn, onClick: () => setForm({ kind: 'tag', name: '', message: '', at: selected || 'HEAD' }) },
            `+ ${t('newTag')}`,
          ),
          h('button', { style: css.btn, onClick: () => void refresh() }, t('refresh')),
        ),
        h('div', { style: css.scroll }, [
          h('div', { key: 'lb', style: css.section }, t('branches')),
          ...(refs.branches ?? []).map((branch) =>
            h(
              'div',
              {
                key: `${branch.remote ? 'r' : 'l'}-${branch.name}`,
                style: {
                  ...css.item,
                  justifyContent: 'space-between',
                  background: branch.head ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                },
              },
              h(
                'div',
                {
                  style: { minWidth: 0, flex: 1, cursor: 'pointer' },
                  title: `${branch.name} → ${branch.sha}\n${branch.subject ?? ''}`,
                  onClick: () => void act('checkout', { ref: branch.name }),
                },
                h(
                  'div',
                  {
                    style: {
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: branch.remote ? 'var(--dsw-alias-label-secondary)' : 'inherit',
                    },
                  },
                  branch.head ? '◉ ' : '○ ',
                  branch.name,
                  branch.upstream
                    ? h('span', { style: { ...css.meta, marginLeft: 6 } }, `→ ${branch.upstream}`)
                    : null,
                ),
                h(
                  'div',
                  {
                    style: {
                      ...css.meta,
                      fontSize: 10.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  `${fmtRelative(branch.time * 1000, localeRef.current)} · ${branch.subject ?? ''}`,
                ),
              ),
              h(
                'span',
                { style: { display: 'flex', gap: 6, alignItems: 'center', flex: '0 0 auto' } },
                branch.head || branch.remote
                  ? null
                  : h(
                      'span',
                      {
                        style: { ...css.meta, cursor: 'pointer' },
                        title: `${t('merge')} ${branch.name}`,
                        onClick: (event) => {
                          event.stopPropagation()
                          void act('merge', { ref: branch.name })
                        },
                      },
                      t('merge'),
                    ),
                branch.head
                  ? h('span', { style: css.meta }, t('current'))
                  : branch.remote
                    ? null
                    : h(
                        'span',
                        {
                          style: { ...css.meta, cursor: 'pointer' },
                          onClick: (event) => {
                            event.stopPropagation()
                            if (typeof window.confirm === 'function' && !window.confirm(t('confirmDelete'))) return
                            void act('delete-branch', { name: branch.name, force: false })
                          },
                        },
                        t('remove'),
                      ),
              ),
            ),
          ),
          h('div', { key: 'tg', style: css.section }, t('tags')),
          (refs.tags ?? []).length === 0
            ? h('div', { key: 'nt', style: { ...css.meta, padding: '0 12px 8px' } }, '—')
            : (refs.tags ?? []).map((tag) =>
                h(
                  'div',
                  {
                    key: tag.name,
                    style: { ...css.item, justifyContent: 'space-between' },
                  },
                  h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `⚑ ${tag.name}`),
                  h(
                    'span',
                    {
                      style: { ...css.meta, cursor: 'pointer' },
                      onClick: () => {
                        if (typeof window.confirm === 'function' && !window.confirm(t('confirmDelete'))) return
                        void act('delete-tag', { name: tag.name })
                      },
                    },
                    t('remove'),
                  ),
                ),
              ),
          h('div', { key: 'st', style: css.section }, t('stashes')),
          (stashes ?? []).length === 0
            ? h('div', { key: 'ns', style: { ...css.meta, padding: '0 12px 8px' } }, t('noStashes'))
            : (stashes ?? []).map((stash) =>
                h(
                  'div',
                  {
                    key: stash.selector,
                    style: { ...css.item, gap: 8 },
                    title: `${stash.selector}: ${stash.subject}`,
                  },
                  h(
                    'span',
                    { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    stash.subject || stash.selector,
                  ),
                  h(
                    'span',
                    {
                      style: { ...css.meta, cursor: 'pointer' },
                      onClick: () => void act('stash-pop', { index: stash.index }),
                    },
                    t('popStash'),
                  ),
                ),
              ),
        ]),
      )

      const modal = picker
        ? h(
            'div',
            { style: css.modal, onClick: () => setPicker(null) },
            h(
              'div',
              { style: css.modalCard, onClick: (event) => event.stopPropagation() },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  },
                },
                h('strong', { style: { fontSize: 13 } }, t('repo')),
                h('span', { style: { ...css.meta, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, picker.path),
                h(
                  'button',
                  { style: css.btn, onClick: () => setPicker(null) },
                  t('close'),
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 6, padding: '8px 14px' } },
                h(
                  'button',
                  { style: css.btn, disabled: !picker.parent, onClick: () => void openPicker(picker.parent) },
                  t('up'),
                ),
                h(
                  'button',
                  {
                    // 当前目录不是仓库时直接禁用，避免点了才报「不是 Git 仓库」。
                    style: picker.isRepo
                      ? css.btnPrimary
                      : { ...css.btnPrimary, opacity: 0.45, cursor: 'not-allowed' },
                    disabled: !picker.isRepo,
                    title: picker.isRepo ? picker.path : t('notRepoHere'),
                    onClick: picker.isRepo ? () => void chooseRepo(picker.path) : undefined,
                  },
                  picker.isRepo ? t('usePath') : t('notRepoHere'),
                ),
              ),
              picker.repos?.length
                ? h(
                    'div',
                    { style: { padding: '0 14px 6px' } },
                    h('div', { style: css.section }, t('reposHere')),
                    picker.repos.map((item) =>
                      h(
                        'div',
                        {
                          key: item.path,
                          style: { ...css.item, padding: '4px 0' },
                          onClick: () => void chooseRepo(item.path),
                        },
                        h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, '◈'),
                        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, item.path),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { style: { ...css.scroll, borderTop: '1px solid var(--dsw-alias-border-l1)' } },
                picker.entries.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.path,
                      style: { ...css.item, padding: '5px 14px' },
                      onClick: () => void openPicker(entry.path),
                      onDoubleClick: entry.isRepo ? () => void chooseRepo(entry.path) : undefined,
                    },
                    h('span', { style: { opacity: 0.65 } }, entry.isRepo ? '◈' : '▸'),
                    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, entry.name),
                  ),
                ),
              ),
            ),
          )
        : null

      const formModal = form
        ? h(
            'div',
            { style: css.modal, onClick: () => setForm(null) },
            h(
              'div',
              {
                style: { ...css.modalCard, width: 'min(420px, 92vw)' },
                onClick: (event) => event.stopPropagation(),
              },
              h(
                'div',
                { style: { padding: '12px 14px', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontWeight: 600 } },
                form.kind === 'branch' ? t('newBranch') : t('newTag'),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px' } },
                h('label', { style: css.meta }, t('name')),
                h('input', {
                  style: css.input,
                  value: form.name,
                  autoFocus: true,
                  onChange: (event) => setForm({ ...form, name: event.target.value }),
                }),
                form.kind === 'tag'
                  ? [
                      h('label', { key: 'l', style: css.meta }, `${t('message')} (${t('optional')})`),
                      h('input', {
                        key: 'i',
                        style: css.input,
                        value: form.message ?? '',
                        onChange: (event) => setForm({ ...form, message: event.target.value }),
                      }),
                    ]
                  : null,
                h('label', { style: css.meta }, `at: ${form.at}`),
              ),
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px' } },
                h('button', { style: css.btn, onClick: () => setForm(null) }, t('cancel')),
                h(
                  'button',
                  {
                    style: css.btnPrimary,
                    disabled: !form.name.trim(),
                    onClick: () => {
                      const payload = { name: form.name.trim(), at: form.at, message: form.message }
                      const type = form.kind === 'branch' ? 'create-branch' : 'create-tag'
                      setForm(null)
                      void act(type, payload)
                    },
                  },
                  t('create'),
                ),
              ),
            ),
          )
        : null

      return h(
        'div',
        {
          ref: rootRef,
          style: {
            ...css.wrap,
            position: 'relative',
            height: fitHeight || '100%',
            maxHeight: fitHeight || '100%',
            overflow: 'hidden',
          },
        },
        h(
          'div',
          { style: css.topbar },
          h(
            'div',
            { style: { display: 'flex', gap: 0, alignItems: 'center', flexShrink: 0 } },
            h(
              'button',
              {
                style: tab === 'history' ? css.tabActive : css.tab,
                onClick: () => {
                  setTab('history')
                  // 切页时清掉上一页遗留的文件 diff，避免右侧显示不属于本页的内容。
                  setDiffPath('')
                  setDiff(null)
                },
              },
              t('history'),
            ),
            h(
              'button',
              {
                style: tab === 'working' ? css.tabActive : css.tab,
                onClick: () => {
                  setTab('working')
                  setDiffPath('')
                  setDiff(null)
                },
              },
              t('workingTree'),
            ),
            h(
              'button',
              {
                style: tab === 'refs' ? css.tabActive : css.tab,
                onClick: () => {
                  setTab('refs')
                  setDiffPath('')
                  setDiff(null)
                },
              },
              t('branches'),
            ),
          ),
          h(
            'div',
            {
              style: {
                flex: 1,
                minWidth: 80,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                overflow: 'hidden',
              },
              title: nothingPicked ? info?.sessionCwd ?? '' : repo,
            },
            h(GitIcon, { size: 14 }),
            h(
              'span',
              {
                style: {
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 11.5,
                  color: nothingPicked
                    ? 'var(--dsw-alias-label-secondary)'
                    : 'var(--dsw-alias-label-primary)',
                },
              },
              nothingPicked ? t('noRepo') : repo,
            ),
            status?.branch
              ? h('span', { style: css.chip }, `⎇ ${status.branch}`)
              : null,
            status && (status.ahead || status.behind)
              ? h(
                  'span',
                  { style: { ...css.chip, color: 'var(--dsw-alias-state-warn-primary)' } },
                  `↑${status.ahead ?? 0} ↓${status.behind ?? 0}`,
                )
              : null,
            status
              ? h(
                  'span',
                  {
                    style: {
                      ...css.chip,
                      color: dirty ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)',
                    },
                  },
                  dirty ? dirtyLabel(status.status, t) : t('clean'),
                )
              : null,
          ),
          // 会话工作区里扫到多个仓库时，直接给下拉切换，省得每次都开浏览框。
          autoRepos.length > 1
            ? h(
                'select',
                {
                  style: { ...css.input, width: 'auto', maxWidth: 180, cursor: 'pointer' },
                  title: t('autoRepos'),
                  value: repo,
                  onChange: (event) => void chooseRepo(event.target.value),
                },
                // 手动选过、又不在扫描结果里的仓库也要能显示成当前项。
                (repo && !autoRepos.includes(repo) ? [repo, ...autoRepos] : autoRepos).map((item) =>
                  h('option', { key: item, value: item }, item.split('/').filter(Boolean).pop() ?? item),
                ),
              )
            : null,
          // 一个都没扫到时留个重扫入口：新 clone 的仓库不用刷新整页。
          h(
            'button',
            { style: css.btn, title: t('rescan'), onClick: () => void rescan() },
            t('rescan'),
          ),
          h(
            'button',
            { style: css.btn, onClick: () => void openPicker(status?.repo ?? '') },
            t('browse'),
          ),
          h(
            'button',
            { style: css.btn, onClick: () => void refresh(), disabled: busy },
            busy ? t('loading') : t('refresh'),
          ),
        ),
        // 搜索与「所有引用」单独一行：会话视图宽度有限，挤在一行会把路径压没。
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              flexShrink: 0,
              flexWrap: 'wrap',
            },
          },
          h('input', {
            style: { ...css.input, flex: 1, minWidth: 120 },
            placeholder: t('search'),
            title: t('filterHint'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'label',
            {
              style: { ...css.meta, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' },
              title: t('allRefs'),
            },
            h('input', {
              type: 'checkbox',
              checked: allRefs,
              onChange: (event) => setAllRefs(event.target.checked),
            }),
            t('allRefs'),
          ),
        ),
        h(
          'div',
          { style: css.body },
          h(
            'div',
            { style: { ...css.col, ...(tab === 'refs' ? { flex: 1 } : css.listCol) } },
            tab === 'refs' ? sidebarBranchList : tab === 'working' ? workingList : historyList,
          ),
          // 分支页不需要详情列，整块让给列表。
          tab === 'refs' ? null : h('div', { style: { ...css.col, ...css.detailCol } }, detailPane),
        ),
        modal,
        formModal,
        toast
          ? h(
              'div',
              {
                style: {
                  ...css.toast,
                  background:
                    toast.kind === 'error'
                      ? 'var(--dsw-alias-state-error-primary)'
                      : toast.kind === 'success'
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-label-primary)',
                },
              },
              toast.text,
            )
          : null,
      )
    }

    return {
      name: 'dsh-session-git',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'git-panel: dictionaries')
        const t = ctx.locale.bind(NS)
        // 会话内的 View 页签：每个会话各一份，组件从 props.sessionId 拿当前会话。
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: 40,
              locale: NS,
              label: () => t('panel'),
            },
            Panel,
          ),
        )
      },
    }
  },
})
