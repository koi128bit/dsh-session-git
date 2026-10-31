/**
 * Host half of dsh-session-git.
 *
 * 在 DSH Web 同源下挂一组只读为主、写操作显式放行的 Git API：
 *   GET  /git-panel/api/status     仓库摘要（分支、ahead/behind、工作区计数）
 *   GET  /git-panel/api/log        提交列表（父提交、refs、作者、时间、标题）
 *   GET  /git-panel/api/branches   本地/远程分支 + 标签 + HEAD
 *   GET  /git-panel/api/commit     单提交详情（元信息 + 文件级增删行数）
 *   GET  /git-panel/api/diff       单提交或工作区某文件的 unified diff
 *   GET  /git-panel/api/working    工作区/暂存区变更清单
 *   GET  /git-panel/api/fs         目录浏览，用于仓库选择器
 *   GET  /git-panel/api/repos      在目录下递归找工作树
 *   POST /git-panel/api/action     checkout / branch / tag / merge / stash …
 *
 * 所有命令都走 ctx.subprocess（缺失时退回 node:child_process），
 * 不接受任何来自前端的 shell 字符串拼装：参数一律走 argv。
 *
 * 仓库解析顺序：显式 `repo` 参数 → 插件配置 repoRoot → 会话工作目录（`session` 参数）
 * → Host 默认目录 → 进程 cwd。`session` 由客户端视图从 props.sessionId 透传，
 * 所以每个会话看到的是它自己的工作目录仓库。
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-git'

const BASE = '/git-panel/api'
const GIT_TIMEOUT_MS = 30_000
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const MAX_LOG_BYTES = 8 * 1024 * 1024

const DEFAULTS = {
  repoRoot: '',
  allowedRoots: [],
  maxCommits: 400,
  allowWrite: true,
}

export let Config

try {
  const z = (await import('@deepseek-ai/schemastery')).default
  Config = z.object({
    repoRoot: z.string().description('默认仓库路径；留空用会话工作目录').default(''),
    allowedRoots: z
      .array(z.string())
      .description('允许访问的根目录白名单；留空表示不限')
      .default([]),
    maxCommits: z.number().description('单次提交列表上限').default(400),
    allowWrite: z.boolean().description('允许 checkout / 建分支 / stash 等写操作').default(true),
  })
} catch {
  Config = undefined
}

/** 进程内状态：git 可执行文件路径只解析一次。 */
const runtime = { gitPath: '', lastError: '' }

/**
 * 工作区扫描结果缓存。面板一次刷新会打 4 个请求，
 * 不缓存就会把同一个目录反复 readdir 好几遍。
 */
const scanCache = new Map()
const SCAN_TTL_MS = 8000

/** 取一个可选 Service；未声明或未加载时返回 undefined 而不是抛错。 */
function service(ctx, key) {
  try {
    return ctx.get(key)
  } catch {
    return undefined
  }
}

const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s']
const LOG_FORMAT = `${LOG_FIELDS.join('%x1f')}%x1e`

/** 不应透传给人看的 git 前缀噪声。 */
function cleanGitMessage(text) {
  return String(text ?? '')
    .replace(/^fatal:\s*/i, '')
    .replace(/^error:\s*/i, '')
    .trim()
}

/** 找一个能跑 git 的可执行文件。 */
async function resolveGit(ctx) {
  if (runtime.gitPath) return runtime.gitPath
  const subprocess = service(ctx, 'subprocess')
  if (subprocess?.resolveExecutable) {
    try {
      runtime.gitPath = await subprocess.resolveExecutable('git')
      return runtime.gitPath
    } catch {
      /* 落到下面的直连路径 */
    }
  }
  runtime.gitPath = 'git'
  return runtime.gitPath
}

/** 直连 git：ctx.subprocess 缺席时的退路。 */
function execGitDirect(cwd, args, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_LOG_BYTES,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(Object.assign(error, { stderr: String(stderr ?? '') }))
          return
        }
        resolvePromise(String(stdout ?? ''))
      },
    )
    if (input != null && child.stdin) {
      child.stdin.end(input)
    }
  })
}

/**
 * 跑一条 git 命令，返回 stdout。非 0 退出抛错并带上 stderr。
 * @param ctx - Host 上下文。
 * @param cwd - 仓库工作目录。
 * @param args - argv，不含 `git` 本身。
 * @param input - 可选 stdin 内容。
 */
async function runGit(ctx, cwd, args, input) {
  const subprocess = service(ctx, 'subprocess')
  if (!subprocess?.spawn) return execGitDirect(cwd, args, input)

  const git = await resolveGit(ctx)
  let handle
  try {
    handle = subprocess.spawn({
      argv: [git, '--no-pager', ...args],
      cwd,
      stdio: {
        stdin: input != null ? { data: input } : 'ignore',
        stdout: { maxBytes: MAX_LOG_BYTES },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 4000,
    })
  } catch (error) {
    runtime.lastError = String(error?.message ?? error)
    return execGitDirect(cwd, args, input)
  }

  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
  if (outcome.exitCode !== 0) {
    const error = new Error(cleanGitMessage(stderr) || `git ${args[0]} 退出码 ${outcome.exitCode}`)
    error.exitCode = outcome.exitCode
    error.stderr = stderr
    throw error
  }
  return stdout
}

/** 读请求体（JSON）。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function isSameSite(req) {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return false
  return true
}

/** 展开 ~ 并解析为绝对路径。 */
function expandPath(input) {
  if (!input) return ''
  let value = String(input).trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/')) value = join(homedir(), value.slice(2))
  return isAbsolute(value) ? resolve(value) : resolve(value)
}

/** 白名单校验：空数组表示不限。 */
function withinAllowed(path, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) return true
  return allowedRoots.some((root) => {
    const base = expandPath(root)
    if (!base) return false
    if (path === base) return true
    const rel = relative(base, path)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
}

/**
 * 会话自己的工作目录。先查内存里的 Session（workingDirectory projection），
 * 再退回持久化元信息里的 cwd —— 面板刷新后旧会话可能只剩磁盘记录。
 * @param ctx - Host 插件上下文。
 * @param sessionId - 前端传上来的会话 id，可为空。
 * @returns 该会话的工作目录；完全查不到时返回空串。
 */
async function resolveSessionCwd(ctx, sessionId) {
  const id = String(sessionId ?? '').trim()
  if (!id) return ''
  const sessions = service(ctx, 'sessions')
  const session = sessions?.get?.(id)
  if (session) {
    const dir = service(ctx, 'workingDirectory')?.get?.(session)
    if (dir) return String(dir)
  }
  const controller = service(ctx, 'sessionController')
  if (controller?.inspect) {
    try {
      const inspection = await controller.inspect(id)
      const cwd = inspection?.meta?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    } catch {
      /* 会话已归档或被删，交给后续候选 */
    }
  }
  return ''
}

/** 解析并校验仓库路径。 */
async function resolveRepo(ctx, config, requestPath, sessionId) {
  let candidate = expandPath(requestPath) || expandPath(config.repoRoot)
  if (!candidate) {
    // 没显式指定仓库时按会话自动探测：会话目录本身、其子目录里的仓库都算。
    const detected = await detectRepos(ctx, config, sessionId)
    candidate =
      detected.repo || expandPath(service(ctx, 'workingDirectory')?.defaultDirectory ?? '') || process.cwd()
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`目录不存在：${candidate}`)
  }
  if (!withinAllowed(candidate, config.allowedRoots)) {
    throw new Error(`目录不在允许范围内：${candidate}`)
  }
  let top
  try {
    top = (await runGit(ctx, candidate, ['rev-parse', '--show-toplevel'])).trim()
  } catch (error) {
    throw new Error(`不是 Git 仓库：${cleanGitMessage(error?.message ?? error)}`)
  }
  return top || candidate
}

/**
 * 在会话工作区里找一个仓库：先看工作目录本身，再往下扫几层子目录。
 * 会话目录常常是「多个项目并列」的容器（例如 ~/code 下有 a、b 两个仓库），
 * 不放宽到子目录就永远只能看到「请选择仓库」。
 * @param root - 会话工作目录。
 * @param depth - 向下扫描的层数，0 表示只看当前目录。
 * @returns 命中的仓库根列表（离 root 近的排前面）。
 */
async function scanRepos(root, depth = 2) {
  const cacheKey = `${root}\u0000${depth}`
  const hit = scanCache.get(cacheKey)
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit.repos
  const found = []
  const seen = new Set()
  const skip = new Set([
    'node_modules',
    '.git',
    'Library',
    '.Trash',
    'Applications',
    'System',
    'target',
    'dist',
    'build',
    '.cache',
  ])
  const walk = async (dir, level) => {
    if (found.length >= 40 || level > depth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (existsSync(join(dir, '.git'))) {
      const top = dir
      if (!seen.has(top)) {
        seen.add(top)
        found.push(top)
      }
      // 仓库内部不再往下找（submodule 除外，这里不追）。
      return
    }
    const subdirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name))
      .map((entry) => join(dir, entry.name))
    await Promise.all(subdirs.map((sub) => walk(sub, level + 1)))
  }
  await walk(root, 0)
  // 排序：离根目录近的优先，同层按最近一次提交时间倒序，最后按名字。
  // 容器目录（~/Desktop 这种）底下仓库很多，按字母序会永远落到同一个不相干的仓库，
  // 按 mtime 排更接近「我最近在动哪个」，同时保证结果稳定。
  const stamps = new Map()
  await Promise.all(
    found.map(async (dir) => {
      try {
        stamps.set(dir, statSync(join(dir, '.git')).mtimeMs)
      } catch {
        stamps.set(dir, 0)
      }
    }),
  )
  found.sort((a, b) => {
    const da = relative(root, a).split(sep).filter(Boolean).length
    const db = relative(root, b).split(sep).filter(Boolean).length
    return da - db || (stamps.get(b) ?? 0) - (stamps.get(a) ?? 0) || a.localeCompare(b)
  })
  scanCache.set(cacheKey, { at: Date.now(), repos: found })
  if (scanCache.size > 64) {
    // 简单收缩，避免长时间运行后按目录无上限堆积。
    for (const key of [...scanCache.keys()].slice(0, scanCache.size - 32)) scanCache.delete(key)
  }
  return found
}

/**
 * 探测当前会话该打开哪个仓库，并列出候选。
 *
 * 顺序：会话工作目录本身 → 会话工作目录下扫描出的子仓库 → 配置 repoRoot
 * → Host 默认目录。扫描这一步是为了「工作区是个容器目录」的情形：
 * 会话 cwd 不是仓库但它下面挂着若干仓库时，直接取第一个可见仓库，
 * 同时把全部候选回给前端，让用户能一键切换而不是每次都手动浏览。
 * @returns `{ repo, repos, source }`，都没有时 repo 为空串。
 */
async function detectRepos(ctx, config, sessionId) {
  const sessionCwd = expandPath(await resolveSessionCwd(ctx, sessionId))
  const fallbacks = [
    expandPath(config.repoRoot),
    expandPath(service(ctx, 'workingDirectory')?.defaultDirectory ?? ''),
  ].filter(Boolean)

  const candidates = []
  if (sessionCwd && existsSync(sessionCwd) && statSync(sessionCwd).isDirectory()) {
    // 先问 git 自己：会话目录可能是仓库里的某个子目录（比如 <repo>/src），
    // 这种情况 rev-parse 能一路找到仓库根，比只看 .git 存在与否准。
    try {
      const top = (await runGit(ctx, sessionCwd, ['rev-parse', '--show-toplevel'])).trim()
      if (top) candidates.push({ repo: top, source: 'session-root' })
    } catch {
      /* 不在仓库里，继续往下扫 */
    }
    const scanned = await scanRepos(sessionCwd, 2)
    for (const repo of scanned) {
      if (candidates.some((item) => item.repo === repo)) continue
      candidates.push({ repo, source: 'session-child' })
    }
  }
  for (const dir of fallbacks) {
    if (candidates.some((item) => item.repo === dir)) continue
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    try {
      const top = (await runGit(ctx, dir, ['rev-parse', '--show-toplevel'])).trim()
      if (top) candidates.push({ repo: top, source: dir === fallbacks[0] ? 'config' : 'default' })
    } catch {
      /* 不是仓库 */
    }
  }

  const repos = []
  for (const item of candidates) if (!repos.includes(item.repo)) repos.push(item.repo)
  const head = candidates[0]
  return { repo: head?.repo ?? '', repos, source: head?.source ?? '', sessionCwd }
}

/**
 * 兼容旧名：只要仓库路径。
 */
async function detectDefaultRepo(ctx, config, sessionId) {
  const { repo } = await detectRepos(ctx, config, sessionId)
  return repo
}

/** 把 git log 的机器格式转成结构化提交。 */
function parseLog(text) {
  const commits = []
  for (const record of String(text ?? '').split('\x1e')) {
    const row = record.replace(/^\n/, '')
    if (!row.trim()) continue
    const f = row.split('\x1f')
    if (f.length < 10) continue
    commits.push({
      sha: f[0],
      short: f[0].slice(0, 8),
      parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
      author: f[2],
      authorEmail: f[3],
      authorTime: Number(f[4]) * 1000,
      committer: f[5],
      committerEmail: f[6],
      commitTime: Number(f[7]) * 1000,
      decoration: f[8],
      subject: f[9],
    })
  }
  return commits
}

/** `%D` 装饰串拆成 ref 列表。 */
function splitDecoration(text) {
  if (!text) return []
  return String(text)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      // 用 --decorate=full：本地分支是 refs/heads/x，远程是 refs/remotes/o/x。
      // 不能靠「含斜杠」判断远程，本地分支也常带 feature/ 前缀。
      const strip = (value) => value.replace(/^refs\/(heads|remotes|tags)\//, '')
      if (item.startsWith('HEAD -> ')) {
        return { kind: 'head', name: strip(item.slice(8)), head: true }
      }
      if (item === 'HEAD') return { kind: 'head', name: 'HEAD', head: true }
      if (item.startsWith('tag: ')) return { kind: 'tag', name: strip(item.slice(5)) }
      if (item.startsWith('refs/remotes/')) return { kind: 'remote', name: strip(item) }
      if (item.startsWith('refs/heads/')) return { kind: 'branch', name: strip(item) }
      return { kind: 'branch', name: strip(item) }
    })
}

/** 解析 `git status --porcelain=v1 -z`。 */
function parseStatus(text, config) {
  const entries = []
  const parts = String(text ?? '').split('\x00')
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i]
    if (!line || line.length < 4) continue
    const x = line[0]
    const y = line[1]
    let path = line.slice(3)
    // 重命名/复制条目后面紧跟原路径，吃掉一条。
    if (x === 'R' || x === 'C') {
      const from = parts[i + 1]
      if (from) {
        i += 1
        path = `${from} -> ${path}`
      }
    }
    entries.push({ index: x, worktree: y, path })
  }
  const staged = entries.filter((entry) => entry.index !== ' ' && entry.index !== '?').length
  const unstaged = entries.filter((entry) => entry.worktree !== ' ' && entry.worktree !== '?').length
  const untracked = entries.filter((entry) => entry.index === '?' && entry.worktree === '?').length
  return { entries, staged, unstaged, untracked, clean: entries.length === 0 }
}

/** 从 `## main...origin/main [ahead 2]` 提取分支信息。 */
function parseBranchLine(line) {
  // 空仓库的分支行是 `## No commits yet on main`，去掉前缀只留分支名。
  const raw = String(line ?? '')
    .replace(/^##\s*/, '')
    .replace(/^No commits yet on\s+/, '')
  if (!raw) return { branch: '', ahead: 0, behind: 0, upstream: '' }
  const bracket = /\[(.+)\]$/.exec(raw)
  const head = bracket ? raw.slice(0, bracket.index).trim() : raw
  const [localRaw, upstream = ''] = head.split('...')
  const ahead = bracket ? Number((/ahead (\d+)/.exec(bracket[1]) ?? [])[1] ?? 0) : 0
  const behind = bracket ? Number((/behind (\d+)/.exec(bracket[1]) ?? [])[1] ?? 0) : 0
  return { branch: localRaw.trim(), upstream: upstream.trim(), ahead, behind }
}

/** for-each-ref：一次拿全部分支与标签。 */
function parseRefs(text) {
  const branches = []
  const tags = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const [refName, sha, time, upstream, head, subject] = line.split('\t')
    if (!refName) continue
    const fullName = refName
    const ref = {
      name: refName,
      sha: sha ?? '',
      time: Number(time ?? 0) * 1000,
      upstream: upstream ?? '',
      head: head === '*',
      subject: subject ?? '',
    }
    if (fullName.startsWith('refs/tags/')) tags.push({ ...ref, name: fullName.slice(10) })
    else
      branches.push({
        ...ref,
        name: fullName.replace(/^refs\/(heads|remotes)\//, ''),
        remote: fullName.startsWith('refs/remotes/'),
      })
  }
  branches.sort((a, b) => Number(b.head) - Number(a.head) || a.name.localeCompare(b.name))
  tags.sort((a, b) => b.time - a.time)
  return { branches, tags }
}

/** 触发一次 `git fetch` 之外的写操作，统一错误包装。 */
async function writeAction(ctx, repo, args, input) {
  const out = await runGit(ctx, repo, args, input)
  return out.trim()
}

/** 允许的动作表：既要留审计面，也防前端随手拼参数。 */
const ACTIONS = {
  checkout: (payload) => ['checkout', ...(payload.force ? ['-f'] : []), String(payload.ref ?? '')],
  'checkout-detach': (payload) => ['checkout', '--detach', String(payload.ref ?? '')],
  'create-branch': (payload) => ['switch', '-c', String(payload.name ?? ''), String(payload.at ?? 'HEAD')],
  'delete-branch': (payload) => ['branch', payload.force ? '-D' : '-d', String(payload.name ?? '')],
  'create-tag': (payload) =>
    payload.message
      ? ['tag', '-a', String(payload.name ?? ''), '-m', String(payload.message), String(payload.at ?? 'HEAD')]
      : ['tag', String(payload.name ?? ''), String(payload.at ?? 'HEAD')],
  'delete-tag': (payload) => ['tag', '-d', String(payload.name ?? '')],
  merge: (payload) => ['merge', ...(payload.noFf ? ['--no-ff'] : []), String(payload.ref ?? '')],
  'merge-abort': () => ['merge', '--abort'],
  // 合并提交必须指定 mainline，前端不传时默认取第一父。
  revert: (payload) =>
    ['revert', '--no-edit', ...(payload.mainline != null ? ['-m', String(payload.mainline)] : []), String(payload.sha ?? '')],
  'cherry-pick': (payload) =>
    ['cherry-pick', ...(payload.mainline != null ? ['-m', String(payload.mainline)] : []), String(payload.sha ?? '')],
  stash: (payload) =>
    payload.message ? ['stash', 'push', '-m', String(payload.message)] : ['stash', 'push'],
  'stash-pop': (payload) => ['stash', 'pop', ...(payload.index != null ? [String(payload.index)] : [])],
  'stash-list': () => ['stash', 'list'],
  // 工作区三件套：暂存 / 取消暂存 / 丢弃未暂存改动。
  stage: (payload) => ['add', '--', ...toPaths(payload)],
  unstage: (payload) => ['reset', '--', ...toPaths(payload)],
  discard: (payload) => ['checkout', '--', ...toPaths(payload)],
  // 在面板里直接提交：先 add 指定路径（或全部），再 commit -m。
  commit: (payload) => ['commit', '--no-gpg-sign', ...(payload.amend ? ['--amend'] : []), '-m', String(payload.message ?? '')],
  fetch: () => ['fetch', '--all', '--prune'],
  pull: (payload) => ['pull', ...(payload.ff ? ['--ff-only'] : [])],
  push: (payload) => ['push', ...(payload.setUpstream ? ['-u'] : []), ...(payload.force ? ['--force-with-lease'] : [])],
}

/** 把 payload 里的 path / paths 规整成 argv 路径列表。 */
function toPaths(payload) {
  const list = Array.isArray(payload.paths) ? payload.paths : payload.path ? [payload.path] : []
  const cleaned = list.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (cleaned.length === 0) throw new Error('缺少路径')
  return cleaned
}

/**
 * 插件入口。
 * @param ctx - Host 上下文。
 * @param config - 补丁里声明的 config。
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }

  // 只硬依赖 webServer；subprocess / workingDirectory 走 ctx.get 可选访问，缺失时各自降级。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []
      let closed = false

      const sendJson = (res, status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      }

      /** 统一的 GET 包装：解析 repo、跑 loader、兜错误。 */
      const route = (path, loader) => {
        disposers.push(
          host.webServer.register({
            kind: 'exact',
            path: `${BASE}${path}`,
            handler: async (req, res) => {
              if (closed) {
                sendJson(res, 503, { ok: false, error: 'plugin disposed' })
                return
              }
              if (!isSameSite(req)) {
                sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
                return
              }
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              try {
                const payload = await loader(url.searchParams, req)
                sendJson(res, 200, { ok: true, ...payload })
              } catch (error) {
                runtime.lastError = String(error?.message ?? error)
                sendJson(res, 400, { ok: false, error: cleanGitMessage(runtime.lastError) })
              }
            },
          }),
        )
      }

      /** 需要仓库上下文的 GET；`session` 参数让仓库跟着会话走。 */
      const repoRoute = (path, loader) =>
        route(path, async (params, req) => {
          const repo = await resolveRepo(
            ctx,
            resolved,
            params.get('repo') ?? '',
            params.get('session') ?? '',
          )
          return loader(repo, params, req)
        })

      route('', async (params) => {
        const sessionId = params.get('session') ?? ''
        const detected = await detectRepos(ctx, resolved, sessionId)
        return {
          mounted: `${BASE}`,
          allowWrite: resolved.allowWrite,
          sessionCwd: detected.sessionCwd,
          defaultRepo: detected.repo,
          autoRepos: detected.repos,
          autoSource: detected.source,
          home: homedir(),
          allowedRoots: (resolved.allowedRoots ?? []).map(expandPath).filter(Boolean),
        }
      })

      repoRoute('/status', async (repo) => {
        const [statusText, headSha] = await Promise.all([
          runGit(ctx, repo, ['status', '--porcelain=v1', '-z', '--branch']),
          runGit(ctx, repo, ['rev-parse', 'HEAD']).catch(() => ''),
        ])
        const first = statusText.split('\x00')[0] ?? ''
        const branchInfo = parseBranchLine(first)
        const rest = statusText.slice(first.length + 1)
        const status = parseStatus(rest, resolved)
        const remotes = await runGit(ctx, repo, ['remote', '-v']).catch(() => '')
        const isRepo = true
        const empty = !headSha.trim()
        return {
          repo,
          name: repo.split(sep).filter(Boolean).pop() ?? repo,
          ...branchInfo,
          head: headSha.trim(),
          empty,
          isRepo,
          status,
          remotes: Array.from(
            new Set(
              remotes
                .split('\n')
                .map((line) => line.split('\t')[0]?.trim())
                .filter(Boolean),
            ),
          ),
        }
      })

      repoRoute('/log', async (repo, params) => {
        const limit = Math.min(Math.max(Number(params.get('limit') ?? resolved.maxCommits) || 50, 1), 2000)
        const skip = Math.max(Number(params.get('skip') ?? 0) || 0, 0)
        const args = ['log', '--no-color', '--decorate=full', '--date-order', `--pretty=format:${LOG_FORMAT}`, '-n', String(limit)]
        if (skip > 0) args.push('--skip', String(skip))
        if (params.get('all') === '1') args.push('--all')
        const grep = params.get('grep')
        if (grep) args.push('--grep', grep, '-i')
        const author = params.get('author')
        if (author) args.push('--author', author)
        const since = params.get('since')
        if (since) args.push('--since', since)
        const filePath = params.get('path')
        if (filePath) args.push('--', filePath)
        // 空仓库时 git log 会非 0 退出，这里按空列表处理。
        const text = await runGit(ctx, repo, args).catch((error) => {
          const message = String(error?.message ?? '')
          if (/does not have any commits|unknown revision|bad default revision/i.test(message)) return ''
          throw error
        })
        const commits = parseLog(text).map((commit) => ({
          ...commit,
          refs: splitDecoration(commit.decoration),
        }))
        return { commits, limit, skip, hasMore: commits.length === limit }
      })

      repoRoute('/stashes', async (repo) => {
        const text = await runGit(ctx, repo, ['stash', 'list']).catch(() => '')
        const items = String(text ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line, index) => {
            const [selector, ...rest] = line.split(': ')
            return { index, selector: selector ?? `stash@{${index}}`, subject: rest.join(': ') }
          })
        return { stashes: items }
      })

      repoRoute('/branches', async (repo) => {
        const text = await runGit(ctx, repo, [
          'for-each-ref',
          '--format=%(refname)\t%(objectname)\t%(committerdate:unix)\t%(upstream:short)\t%(HEAD)\t%(subject)',
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ])
        const parsed = parseRefs(text)
        return { ...parsed, current: parsed.branches.find((branch) => branch.head)?.name ?? '' }
      })

      repoRoute('/commit', async (repo, params) => {
        const sha = String(params.get('sha') ?? '').trim()
        if (!sha) throw new Error('缺少 sha')
        const metaText = await runGit(ctx, repo, ['show', '-s', '--no-color', '--decorate=full', `--pretty=format:${LOG_FORMAT}`, sha])
        const meta = parseLog(metaText)[0]
        if (!meta) throw new Error(`提交不存在：${sha}`)
        // 合并提交不带 -m/--first-parent 时 git show 默认不输出任何 diff，
        // 统一按「相对第一父」展示，普通提交不受影响。
        const numstat = await runGit(ctx, repo, [
          'show',
          '--no-color',
          '--format=',
          '--numstat',
          '--find-renames=50%',
          '-m',
          '--first-parent',
          sha,
        ]).catch(() => '')
        const files = numstat
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [adds, dels, ...rest] = line.split('\t')
            return {
              additions: adds === '-' ? null : Number(adds),
              deletions: dels === '-' ? null : Number(dels),
              path: rest.join('\t'),
              binary: adds === '-',
            }
          })
        const body = await runGit(ctx, repo, ['show', '-s', '--no-color', '--pretty=format:%b', sha]).catch(() => '')
        return {
          ...meta,
          refs: splitDecoration(meta.decoration),
          files,
          body: body.trim(),
          additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        }
      })

      repoRoute('/diff', async (repo, params) => {
        const sha = String(params.get('sha') ?? '').trim()
        const filePath = String(params.get('path') ?? '').trim()
        const mode = String(params.get('mode') ?? 'commit')
        let args
        if (mode === 'working') args = ['diff', '--no-color']
        else if (mode === 'staged') args = ['diff', '--cached', '--no-color']
        else if (sha)
          args = ['show', '--no-color', '--format=', '--patch', '--find-renames=50%', '-m', '--first-parent', sha]
        else throw new Error('缺少 sha 或 mode')
        if (filePath) args.push('--', filePath)
        const text = await runGit(ctx, repo, args)
        const trimmed = text.length > MAX_DIFF_BYTES ? `${text.slice(0, MAX_DIFF_BYTES)}\n… 已截断` : text
        return { diff: trimmed, truncated: text.length > MAX_DIFF_BYTES, path: filePath, mode }
      })

      repoRoute('/working', async (repo) => {
        const statusText = await runGit(ctx, repo, ['status', '--porcelain=v1', '-z', '--branch'])
        const first = statusText.split('\x00')[0] ?? ''
        const branchInfo = parseBranchLine(first)
        const status = parseStatus(statusText.slice(first.length + 1), resolved)
        return { ...branchInfo, ...status }
      })

      route('/fs', async (params) => {
        const target = expandPath(params.get('path') ?? '') || homedir()
        if (!withinAllowed(target, resolved.allowedRoots)) throw new Error(`目录不在允许范围内：${target}`)
        if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`目录不存在：${target}`)
        const entries = await readdir(target, { withFileTypes: true })
        const dirs = []
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          if (entry.name === 'node_modules' || entry.name === 'Library') continue
          const full = join(target, entry.name)
          dirs.push({
            name: entry.name,
            path: full,
            isRepo: existsSync(join(full, '.git')),
          })
        }
        dirs.sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name))
        const parent = resolve(target, '..')
        return {
          path: target,
          parent: parent === target ? '' : parent,
          isRepo: existsSync(join(target, '.git')),
          entries: dirs.slice(0, 400),
        }
      })

      route('/repos', async (params) => {
        const root = expandPath(params.get('path') ?? '') || expandPath(resolved.repoRoot) || homedir()
        if (!withinAllowed(root, resolved.allowedRoots)) throw new Error(`目录不在允许范围内：${root}`)
        const depth = Math.min(Math.max(Number(params.get('depth') ?? 2) || 2, 1), 4)
        const found = []
        const skip = new Set(['node_modules', '.git', 'Library', '.Trash', 'Applications', 'System'])
        const walk = async (dir, level) => {
          if (found.length >= 200 || level > depth) return
          let entries
          try {
            entries = await readdir(dir, { withFileTypes: true })
          } catch {
            return
          }
          if (existsSync(join(dir, '.git'))) {
            found.push({ path: dir, name: dir.split(sep).filter(Boolean).pop() ?? dir })
            return
          }
          await Promise.all(
            entries
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name))
              .map((entry) => walk(join(dir, entry.name), level + 1)),
          )
        }
        await walk(root, 0)
        found.sort((a, b) => a.path.localeCompare(b.path))
        return { root, repos: found, truncated: found.length >= 200 }
      })

      // 写操作统一入口：一次一个动作，失败原样回吐 git 的 stderr。
      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: `${BASE}/action`,
          handler: async (req, res) => {
            if (closed) {
              sendJson(res, 503, { ok: false, error: 'plugin disposed' })
              return
            }
            if (!isSameSite(req)) {
              sendJson(res, 403, { ok: false, error: 'cross-site request rejected' })
              return
            }
            if (!resolved.allowWrite) {
              sendJson(res, 403, { ok: false, error: '写操作已在插件配置里关闭' })
              return
            }
            try {
              const payload = await readJson(req)
              const type = String(payload.type ?? '')
              const builder = ACTIONS[type]
              if (!builder) throw new Error(`不支持的动作：${type}`)
              const repo = await resolveRepo(
                ctx,
                resolved,
                payload.repo ?? '',
                payload.session ?? '',
              )
              if (type === 'push' || type === 'pull' || type === 'fetch') {
                throw new Error(`${type} 需要在终端里执行：本面板只做本地历史操作`)
              }
              let output = ''
              // 提交是复合动作：默认先把全部改动加入索引（-A），再 commit。
              if (type === 'commit') {
                const message = String(payload.message ?? '').trim()
                if (!message) throw new Error('提交信息不能为空')
                const skipAdd = payload.stageAll === false
                if (!skipAdd) {
                  const stageArgs =
                    Array.isArray(payload.paths) && payload.paths.length > 0
                      ? ['add', '--', ...payload.paths.map((item) => String(item))]
                      : ['add', '-A']
                  await writeAction(ctx, repo, stageArgs)
                }
                output = await writeAction(ctx, repo, builder(payload))
              } else {
                output = await writeAction(ctx, repo, builder(payload))
              }
              sendJson(res, 200, { ok: true, output })
            } catch (error) {
              runtime.lastError = String(error?.message ?? error)
              sendJson(res, 400, { ok: false, error: cleanGitMessage(runtime.lastError) })
            }
          },
        }),
      )

      return () => {
        closed = true
        for (const dispose of disposers.reverse()) {
          try {
            dispose()
          } catch {
            /* 已移除 */
          }
        }
      }
    }, 'git-panel: routes')
  })
}
