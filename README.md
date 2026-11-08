# @jsonwyj/dsh-session-delete

给 DSH 工作区对话加一个**真正的删除**动作。

DSH 自带的「归档」只是把会话从侧栏藏起来：文件、登记、顺序全都留着，`workspace/delete` 也只删工作区不删会话。这个插件补上缺的那一步，而且不需要改动 `app.asar`，升级 DSH 也不会被覆盖。

## 用法

装好后在侧栏任一对话上点「⋯」，菜单底部（和「归档会话」同一组）会多一项 **🗑 删除会话…** —— 带垃圾桶图标、红色危险样式。

- 点开先弹确认框，确认后才动手；
- 会话从侧栏立刻消失（不刷新页面）；
- 对话文件**不是** `rm -rf`，而是移动到 `~/.dsh/sessions-trash/<时间戳>-<会话 id>/`，需要时把目录放回 `<DSH_HOME>/sessions/<工作区桶>/<会话 id>/` 就能恢复；
- 同时把它从工作区的会话登记、归档集合、置顶集合里清掉，不会留下看得见点不开的空壳行。

## 它做了什么

浏览器半边在会话右键菜单里注册一项（优先走 Host 的 `ctx.contextMenus`，排在归档之后；老版本 Host 回退到 `sidebar.workspaces.session.menu.item` 插槽），确认后通过 Typert Remote 调宿主半边的 `sessionDelete/delete`。

宿主半边按这个顺序执行：

1. 校验会话 id（只接受 `[A-Za-z0-9][A-Za-z0-9._:@-]*`，不接受任何路径片段）；
2. 找到该 id 的全部落盘产物：`<home>/sessions/*/<id>/` 以及 `<home>/storages/session_projcache/sessions/<id>.json`；
3. **先搬文件**：整体移到 `<home>/sessions-trash/`。文件被占用（正开着的会话）时直接返回 `code: 'busy'`，此时文件和侧栏都没被动过，不会出现半删状态；
4. 再改登记：`detachSession` 出所属工作区，`unarchiveSession` / `unpinSession` 清掉两个全局集合；
5. `ctx.emit('api-session/removed', id)`，让 Web 端会话列表就地丢掉这一行。

登记失败只会记进返回值的 `applied`，不会把已经搬走的文件回滚——宁可少一行登记，也不留半截状态。

## 限制

- **正在使用中的会话删不掉**：宿主对该会话还持有打开的写句柄，插件会返回「文件正被占用」，提示先切走或重启 DSH。这是刻意的，避免删完又被内存里的会话写回来。
- 附件缓存（`<home>/cache/attachments`）不清理；它是按请求哈希存的，不属于某个会话的私有数据。
- 恢复只能手工搬目录，插件不带「还原」按钮。

## 结构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：`deleteSession()` 核心逻辑 + `sessionDelete` Remote 命名空间 |
| `client/client.js` | 浏览器半边：菜单项、确认弹窗、RPC 调用（`window.__ModuleLoader__.load` 格式，无构建步骤） |
| `cordis.patch.yml` | bundle 的 loader 行：`- insert: [{ id: session-delete, name: '@jsonwyj/dsh-session-delete' }]`（`@` 开头必须加引号） |
| `test/host.test.mjs` | 宿主逻辑测试，用临时 home 目录，不碰真实会话 |
| `test/client.test.mjs` | 用 `vm` 按客户端的加载方式跑一遍浏览器半边，检查注册与文案 |
| `scripts/build-market-index.mjs` | 从 `package.json` 生成插件市场索引（format 1），支持 `npm` 与 `git` 两种源，并用 DSH 自带校验器验证 |
| `market/icon.svg` | 市场图标（索引里相对引用，要和索引同目录托管） |
| `.github/workflows/release.yml` | 推 tag 即发版：测试 → 打 tgz → GitHub Release → 生成 git 源索引 → 发 Pages |
| `docs/PUBLISH.md` | 发布与上市场的完整步骤、索引字段速查、常见坑 |

```bash
node test/host.test.mjs
node test/client.test.mjs
```

## 发版

全程不碰 npm：改完 `package.json` 的 `version`，推一个 tag 就够了。

```bash
git commit -am "chore: release v0.1.5"
git tag v0.1.5
git push origin main --tags
```

CI 会跑测试、打出 tgz 挂到 Release、用该 commit 生成 git 源的市场索引并发布到 Pages。

## 安装 / 更新

**用 tarball 装，不要用 `link:`。** 宿主包（`@deepseek-ai/dsh-typert-protocol` 等）只对装在 profile 里的插件可见；`link:` 形式的插件解析到工作区真实路径，宿主包就找不到了。

**从 GitHub 装（推荐）** —— 包挂在 Release 上，不需要 npm：

```text
plugin_manager install_bundle target=https://github.com/<owner>/dsh-session-delete/releases/download/v<version>/jsonwyj-dsh-session-delete-<version>.tgz
```

或者加市场索引，让 Discover 自己更新：`https://<owner>.github.io/dsh-session-delete/index.json`。

**本地开发时**：

```bash
node <runtime>/node/bin/node.exe <runtime>/pnpm/bin/pnpm.mjs pack --pack-destination dist
# 然后让 Host 装这个包：
#   plugin_manager install_bundle target=<本目录>/dist/jsonwyj-dsh-session-delete-<version>.tgz
```

装完**需要重启 DSH** 才会挂上宿主半边；浏览器半边会随 HMR 或刷新出现，但删除动作要等宿主重载后才能真正执行。

排查时看 `<DSH_HOME>/cache/dsh-session-delete/status.json`：`mounted: true` 表示 `sessionDelete/delete` 已挂上，`reason` 写明失败原因。

浏览器半边挂了会写 `<DSH_HOME>/cache/dsh-session-delete/client-error.json`，里面是 `label`（哪一步：`connection` / `locale-register` / `locale-bind` / `menu-register` / `legacy-slot` / `delete`）加上原始堆栈。这一层是「尽力而为」的：菜单注册、文案注册失败都只上报，不会让整个插件起不来。

改代码后要重新 pack + 重装，profile 里的那份副本才是运行的那份。
