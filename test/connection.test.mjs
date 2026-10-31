import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function mount(config = {}, services = {}) {
  const routes = new Map()
  let cleanup
  const host = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    effect(fn) { cleanup = fn() },
  }
  const ctx = {
    get(key) { return services[key] },
    inject(services, fn) {
      assert.deepEqual(services, ['connection'])
      fn(host)
    },
  }
  apply(ctx, config)
  return {
    async request(path, options) {
      const url = new URL(path, 'http://localhost')
      const route = routes.get(url.pathname)
      assert.ok(route, `missing route ${url.pathname}`)
      const request = new Request(url, options)
      assert.ok(route.methods.includes(request.method))
      return route.fetch(request)
    },
    cleanup: () => cleanup(),
    routes,
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

test('registers Connection routes and performs local Git operations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-git-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  await writeFile(join(root, 'file.txt'), 'first\n')
  git(root, 'add', 'file.txt')
  git(root, 'commit', '-m', 'initial')
  await writeFile(join(root, 'file.txt'), 'second\n')

  const app = mount({ allowedRoots: [root] })
  t.after(app.cleanup)
  assert.ok([...app.routes.keys()].every((path) => path.startsWith('/api/git-panel')))

  const query = `?repo=${encodeURIComponent(root)}`
  const status = await (await app.request(`/api/git-panel/status${query}`)).json()
  assert.equal(status.ok, true)
  assert.equal(status.status.unstaged, 1)
  const log = await (await app.request(`/api/git-panel/log${query}`)).json()
  assert.equal(log.commits[0].subject, 'initial')

  const action = await app.request('/api/git-panel/action', {
    method: 'POST',
    body: JSON.stringify({ type: 'commit', repo: root, message: 'second' }),
  })
  assert.equal(action.status, 200)
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'second')
  const oversized = await app.request('/api/git-panel/action', {
    method: 'POST',
    body: JSON.stringify({ type: 'stash', repo: root, message: 'x'.repeat(1024 * 1024) }),
  })
  assert.equal(oversized.status, 400)
  assert.match((await oversized.json()).error, /请求体过大/)
})

test('read-only mode and allowedRoots reject writes and escaped repositories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-git-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside')
  const allowed = join(root, 'allowed')
  await mkdir(outside)
  await mkdir(allowed)
  git(outside, 'init', '-b', 'main')
  await symlink(outside, join(allowed, 'escape'))
  const app = mount({ allowWrite: false, allowedRoots: [allowed] })
  t.after(app.cleanup)

  const response = await app.request(`/api/git-panel/status?repo=${encodeURIComponent(join(allowed, 'escape'))}`)
  assert.equal(response.status, 400)
  const subdirectory = join(outside, 'child')
  await mkdir(subdirectory)
  const nested = mount({ allowedRoots: [subdirectory] })
  t.after(nested.cleanup)
  const parentRepo = await nested.request(`/api/git-panel/status?repo=${encodeURIComponent(subdirectory)}`)
  assert.equal(parentRepo.status, 400)
  const action = await app.request('/api/git-panel/action', {
    method: 'POST',
    body: JSON.stringify({ type: 'stash', repo: outside }),
  })
  assert.equal(action.status, 403)
})

test('session IDs select their own repositories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-git-sessions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await mkdir(first)
  await mkdir(second)
  git(first, 'init', '-b', 'main')
  git(second, 'init', '-b', 'main')
  const app = mount({}, {
    sessions: { get: (id) => ({ id }) },
    workingDirectory: { get: (session) => session.id === 'first' ? first : second },
  })
  t.after(app.cleanup)

  const a = await (await app.request('/api/git-panel?session=first')).json()
  const b = await (await app.request('/api/git-panel?session=second')).json()
  assert.equal(await realpath(a.defaultRepo), await realpath(first))
  assert.equal(await realpath(b.defaultRepo), await realpath(second))
})
