# dsh-session-git

A Git tab inside every DSH conversation.

Each conversation gets its own **Git** tab next to `Chat | Trajectory`, and that tab
opens the repository belonging to *that* session — its working directory, not some
global one. Two sessions on two different projects show two different histories, and
neither remembers what the other picked.

![History view with branch lanes](assets/screenshot-history.png)

## What it does

- **Bound to the session.** The tab is registered on the `conversation.view` slot, so it
  receives the current `sessionId` as a prop. Every request carries `?session=<id>`;
  the host resolves that session's working directory, then runs
  `git rev-parse --show-toplevel` on it. Sessions with no repository, empty
  repositories, and repositories nested under the working directory all have their own
  empty state instead of falling back to a shared panel.
- **Per-session memory.** The repository you pick is stored under
  `dsh-git-panel:repo:<sessionId>`, so one conversation switching projects does not
  change what another conversation is looking at.
- **Branch lanes.** Lanes are assigned incrementally from real parent relationships
  (newest to oldest): a parent already sitting in a column reuses that column, otherwise
  the first free column is taken, and trailing empty columns are trimmed. Linear history
  therefore stays one column wide. Merge commits draw bezier curves across columns, and
  colors come from a fixed palette indexed by column, so a refresh never reshuffles them.
- **Commit detail.** Author, time, short SHA (click to copy), `+adds −dels` totals, file
  list with per-file counts, commit body. Actions: detach checkout, create a branch or a
  tag at that commit, revert, cherry-pick.
- **Diffs.** Line-by-line coloring for added/removed lines and hunk headers, fetched per
  file on demand, truncated at 2 MB.
- **Working tree.** Staged/unstaged/untracked counts, per-file stage / unstage / discard,
  commit with an optional `add -A`, amend the previous commit, `git stash` everything.
- **Refs.** Local and remote branches, tags and stashes in one page. Two-line entries
  (name plus latest commit). Switch, merge, create and delete branches; create and delete
  tags; pop stashes.

![Commit detail with file list and diff](assets/screenshot-commit.png)

## Install

```sh
dsh plugin --profile <profile> add dsh-session-git
```

Or install straight from a checkout:

```sh
git clone <this repository>
dsh plugin --profile <profile> add <path-to-checkout>
```

Reload the web UI and open any conversation: a **Git** tab appears in the conversation
header. Only real conversations get it — a brand-new empty session does not render the
view area at all, so the tab shows up once the conversation has its first message.

The desktop client manages its own profile; use that client's plugin manager instead of
the CLI for it.

## Files

| File | Role |
| --- | --- |
| `index.js` | Host side: mounts `/git-panel/api`, runs `git` through `ctx.subprocess` with argv arrays (never a shell), resolves the repository from the `session` parameter |
| `client.js` | Client side: registers `conversation.view` (id `git`), plain React plus same-origin `fetch` |
| `cordis.patch.yml` | Bundle patch: one `insert` of `git-panel` |
| `locale/*.json` | Title and description shown by plugin storefronts (en / zh) |
| `screenshots.json` | Screenshots used by storefronts |
| `icon.svg`, `assets/icon-*.png` | Plugin icon |
| `assets/screenshot-*.png` | Screenshots shown above |

## API

Same-origin only, with a `sec-fetch-site` check, returning `{ ok, ... }`. Every route
except `/fs` and `/repos` accepts `session=<sessionId>`; the browser attaches it
automatically.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/git-panel/api` | Capability probe: `sessionCwd`, `defaultRepo`, `autoRepos`, `autoSource`, home, allow-list, write flag |
| GET | `/git-panel/api/status` | Branch, upstream, ahead/behind, HEAD, working-tree counts, remotes |
| GET | `/git-panel/api/log` | `limit` `skip` `all` `grep` `author` `since` `path` |
| GET | `/git-panel/api/branches` | Branches and tags in one `for-each-ref` |
| GET | `/git-panel/api/commit` | One commit plus its `--numstat` file table |
| GET | `/git-panel/api/diff` | `mode=commit\|working\|staged` plus `path` |
| GET | `/git-panel/api/working` | Working-tree changes |
| GET | `/git-panel/api/fs` | Directory browser, flags repositories |
| GET | `/git-panel/api/repos` | Recursively find repositories |
| GET | `/git-panel/api/stashes` | Stash list |
| POST | `/git-panel/api/action` | `checkout` `checkout-detach` `create-branch` `delete-branch` `create-tag` `delete-tag` `merge` `merge-abort` `revert` `cherry-pick` `stash` `stash-pop` `stage` `unstage` `discard` `commit` |

`push`, `pull` and `fetch` are deliberately not exposed: they need credentials and
network interaction, and their failures cannot be closed out inside the panel.

### How the repository is resolved

Each request walks this list and takes the first candidate that
`git rev-parse --show-toplevel` accepts:

1. an explicit `?repo=` parameter (something picked in the panel)
2. the plugin's `repoRoot` config
3. automatic detection from the session working directory (below)
4. the host's `workingDirectory.defaultDirectory`
5. `process.cwd()`

### Automatic detection

`GET /git-panel/api?session=<id>` reports the session's working directory and every
repository found in it:

| Field | Meaning |
| --- | --- |
| `sessionCwd` | The session's working directory |
| `autoRepos` | Repositories found there, de-duplicated and ordered |
| `autoSource` | `session-root` (the working directory is a repository), `session-child` (found below it), `config`, or `default` |

Detection takes two steps:

1. Run `git rev-parse --show-toplevel` on the session working directory — conversations
   often start inside a subdirectory of a repository (`<repo>/src`), and this resolves
   straight to the root.
2. Otherwise walk two levels down, keeping a directory as soon as it contains `.git` and
   not descending further. `node_modules`, `target`, `dist`, `build`, `.cache` and
   `Library` are skipped; at most 40 repositories are collected.

Results are ordered by depth (closest first), then by `.git` modification time
(most recent first), then by path. In a container directory holding a dozen projects,
alphabetical order would always land on the same unrelated repository; modification time
is closer to "what was touched last" and stays stable within the same second. Scans are
cached per root and depth for 8 seconds.

The top-bar dropdown only appears when more than one repository is found. Press
**Rescan** after `git init` to see a new one immediately.

## Configuration

The `config` block of the `insert` entry in `cordis.patch.yml`:

```yaml
- insert:
    - id: git-panel
      name: dsh-session-git
      config:
        repoRoot: ''            # fixed repository; empty means follow the session
        allowedRoots: []        # allow-list of roots; empty means unrestricted
        maxCommits: 400         # commit list page size
        allowWrite: true        # false turns the panel into a read-only browser
```

## Implementation notes

- **No shell.** `subprocess.spawn({ argv })` executes directly, so paths containing
  spaces or `$` are safe. When `ctx.subprocess` is unavailable it falls back to
  `node:child_process.execFile`.
- **Optional services only.** `apply()` hard-depends on `webServer` alone; `subprocess`,
  `workingDirectory`, `sessions` and `sessionController` are read through a try/catch
  helper, so the plugin loads in any profile and degrades instead of failing.
- **The view computes its own height.** The conversation view area is `flex: 1 0 auto`,
  so it grows to fit its content — a long commit list would push the page to a few
  thousand pixels and slide under the composer. The panel measures the viewport minus the
  composer seat with a `ResizeObserver` and scrolls internally.
- **Merge diffs.** Git prints no patch for a merge commit by default, which renders as
  "no changes". Both the file list and the diff pass `-m --first-parent`, so a merge is
  shown against its first parent.
- **Ref classification.** After `--decorate=full`, local branches are `refs/heads/x` and
  remote ones `refs/remotes/o/x`. Testing for a slash misfiles `feature/x` as a remote.
- **Empty repositories.** `git log` exits non-zero when there are no commits; the host
  recognises that case and returns an empty list. Non-repositories and permission errors
  are also empty states, not red text.
- **Renames.** With `--porcelain=v1 -z`, `R` and `C` entries carry a second NUL-separated
  path; consuming only one shifts every later path.
- **Lane width cap.** With every ref shown, a repository can have dozens of live columns —
  34 columns took 449 px and squeezed the subject to 15 px. `LANE_MAX = 12` clamps the
  geometry, trading a little visual accuracy for a readable subject column.
- **Theme tokens.** All colors are `var(--dsw-alias-*)`, so the panel follows the host's
  light and dark themes.

![Working tree with commit box and per-file actions](assets/screenshot-working.png)

## Known limits

- Empty conversations do not render the view area, so the tab appears after the first
  message.
- `push` / `pull` / `fetch` are out of scope (see above).
- Diffs over 2 MB are truncated; the commit list page is bounded by `maxCommits`.
- A merge commit's diff is always shown relative to its first parent.

![Branches, tags and stashes](assets/screenshot-branches.png)

## 中文说明

在每个 DSH 会话里直接查看、直接操作这个会话工作目录的 Git 仓库。对话头部会多一个
**Git** 页签，不同会话各管各的仓库，互不串。

- 会话绑定：注册在 `conversation.view` 插槽，请求统一带 `?session=<id>`
- 每会话独立记忆选中仓库
- 分支泳道图、提交详情、逐行着色 diff、工作区暂存/提交、引用与 stash 管理
- `push` / `pull` / `fetch` 不在面板内执行，留给终端

## License

MIT
