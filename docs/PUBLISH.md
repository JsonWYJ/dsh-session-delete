# 怎么把插件「上市场」

> 结论先说：DSH 没有「上传插件市场」的后台。**市场 = 一份 JSON 索引文件 + 一堆可安装的包**；别人把索引 URL 加进自己的 DSH，就能在里面搜到并安装。

## 0. 推荐路线：只发 GitHub，不碰 npm

npm 每次 `publish` 都要 6 位动态码，还要担心包名、2FA、registry。**DSH 的索引原生支持 git 源**，包钉到一个 commit 就等价于「某个版本」，所以整条发布链可以完全不经过 npm：

```
git tag v0.1.5 && git push origin v0.1.5
        │
        ├─ CI 跑测试 → npm pack 出 tgz → 挂上 GitHub Release
        ├─ CI 用 tag 指向的 commit 生成 market/index.json（source.type = "git"）
        └─ CI 把 market/ 发到 GitHub Pages → 那就是你的市场索引 URL
```

索引里的 git 源长这样：

```jsonc
"versions": [{
  "version": "0.1.5",
  "publishTimestamp": 1794106724,
  "source": {
    "type": "git",
    "url": "https://github.com/<owner>/<repo>",   // 必须是 https、至少两段路径、不加 .git 也认
    "commit": "40 位小写 sha",                     // 必填，分支名/tag 名一律不收
    "path": "可选：包在仓库里的子目录"              // 仓库根就是包时省略
  },
  "engines": { "dsh": ">=0.2.0-rc.2 <0.3.0-0" }
}]
```

别人装的时候，DSH 会把上面三项拼成 `git+https://…git#<commit>[&path:/<dir>]` 交给 pnpm，全程不查 registry。

**两条安装路径，任选：**

| 方式 | 命令 / 操作 | 适合 |
|---|---|---|
| 市场（推荐） | 设置里加索引 URL `https://<owner>.github.io/<repo>/index.json` | 以后每次发版自动出现在 Discover |
| 直装 tgz | `plugin_manager install_bundle target=https://github.com/<owner>/<repo>/releases/download/v0.1.5/<pkg>-0.1.5.tgz` | 不想加索引，一条命令搞定 |

> 直装 tgz 是绝对 URL，`install_bundle` 认这种 spec（`install-spec` 把 `https://…/*.tgz` 判成 tarball）。

**仓库里不提交 `market/index.json`**：它是构建产物，commit 和时间戳必须由发版那一刻决定，CI 会重新生成。`market/icon.svg` 是源文件，要提交。

后面的第 3~4 节是 npm 路线，保留作为备选（比如以后想同时上 npm）。

## 1. 先分清两种目录

| 目录 | 内容 | 第三方能不能进 |
|---|---|---|
| 官方目录（`@deepseek-ai/dsh-official-bundles`） | 随 DSH 版本内嵌的官方 bundle 列表，安装目标由运行版本推导 | 不能。它是对 `@deepseek-ai/*` 官方包名的硬编码清单，改它要发 DSH 新版本 |
| 自定义索引（format 1 JSON） | 任何发布者自己托管的一份列表 | **能，这就是你的「市场」** |

GUI 里的入口是 **Discover**，它由可选 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供（默认关闭）；设置的 `plugin-market` 条目里 `indexes` 就是索引 URL 列表。

## 2. 包名先查（重要）

本包已定名 **`@jsonwyj/dsh-session-delete`**（npm scope，永不撞名）。

本机实测（2026-11-08，registry.npmmirror.com）—— 未加 scope 的名字基本都被占了，别再用：

| 名字 | 状态 |
|---|---|
| `dsh-session-delete` | **已被占用**（vtxf，0.1.0，功能几乎是同一件事：删除会话 + 批量归档） |
| `dsh-session-trash` | 已被占用（0.1.1） |
| `dsh-conversation-delete` | 已被占用（1.0.0） |
| `dsh-session-delete-plus` | 空 |
| `dsh-recoverable-delete` | 空 |

`@jsonwyj/dsh-session-delete` 用 `scripts/set-package-name.mjs` 一次性改齐了四处，以后要再改名也是同一条命令。

改名要同步 **4 处**：

1. `package.json` 的 `name`
2. `cordis.patch.yml` 里 `- insert:` 那条的 `name:`（Loader 按它找包）
3. `market/index.json` 的 `plugins[0].name`（用生成脚本就不用手改）
4. 本地目录名、README 里的安装命令

## 3. 发布包（npm）

```bash
# 一次
npm login          # 或 pnpm login

# 每次发版
node <runtime>/node/bin/node.exe <runtime>/pnpm/bin/pnpm.mjs pack --pack-destination dist   # 看包里到底有什么
npm publish --access public
```

包必须满足的硬条件（缺一条，装上去也激活不了）：

- `dsh.bundle.patch` 指向 `cordis.patch.yml`，里面 `- insert: [{ id, name }]`
- 客户端插件：`dsh.client.platform: "web"` + `exports["./client"]` 指向手写的 `window.__ModuleLoader__.load({ id, factory })` 文件
- `engines.dsh` 写 SemVer 范围（管理器和索引校验都用它做兼容判断）
- `files` 白名单要把 `lib`、`client`、`locale`、`cordis.patch.yml`、`icon.svg`、`README`、`LICENSE` 都带上
- **必须是真实目录**：`link:` 装的插件解析不到 `@deepseek-ai/*` 宿主包（本仓库实测过的坑）

## 4. 生成并托管索引

```bash
node scripts/build-market-index.mjs --publish-time <npm 上的发布秒级时间戳>
```

- 时间戳取 `pnpm view <包名> time.<版本>`，转成 Unix 秒（索引要求整数秒）
- 脚本会调用 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index` 校验器跑一遍，格式不对当场报错（可用 `--validator <路径>` 指定校验器位置）
- 产物：`market/index.json`（格式 1）+ 图标 `market/icon.svg`

托管随便挑一个 HTTPS 静态站，两个文件放在同一目录即可（图标是相对引用，按索引 URL 解析）：

- GitHub Pages：仓库 → Settings → Pages → 发布 `market/`
- jsDelivr：`https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/market/index.json`
- 公司内网静态服务也行，只要是 HTTPS 且不含查询串/片段

索引 URL 长这样：`https://<你的域名>/dsh/index.json`

## 5. 别人怎么装

**方式 A：知道包名，直接装**（不走市场）

```text
plugin_manager install_bundle target=@jsonwyj/dsh-session-delete@0.1.4
```

**方式 B：走市场**

1. 启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`（插件页里打开，或在 profile `cordis.patch.yml` 里 `- id: plugin-market\n  disabled: false`）
2. 打开 Discover，添加索引 URL
3. 搜索、看详情、安装 —— 安装参数由索引里的 `name@version` 推导

## 6. 索引字段速查（format 1）

```jsonc
{
  "format": 1,                                   // 必须是 1
  "title": { "en": "...", "zh": "..." },         // 本地化文本：字符串或对象，对象必须含 en
  "description": { "en": "...", "zh": "..." },   // 可选
  "metadata": {                                  // 可选：分类/标签/排序键的声明表
    "categories": { "sessions": { "title": { "en": "Sessions" } } },
    "labels": { "destructive": { "title": { "en": "Destructive" } } }
  },
  "plugins": [{
    "name": "包名",                               // 与 npm 包名一致
    "title": { "en": "..." },
    "description": { "en": "..." },
    "icon": "icon.svg",                          // 相对索引、或 https、或 data: base64（≤32 KiB）
    "author": "...", "homepage": "https://...",
    "repository": { "url": "https://...", "directory": "可选子目录" },
    "metadata": { "category": "sessions", "labels": ["destructive"], "keywords": ["..."] },
    "versions": [{
      "version": "0.1.3",                        // 精确 SemVer
      "publishTimestamp": 1762584792,            // 整数 Unix 秒
      "source": { "type": "npm" },               // 或 { type: "git", url, commit: 40位, path? }
      "engines": { "dsh": ">=0.2.0-rc.2 <0.3.0-0" }
    }]
  }]
}
```

规则来自 `@deepseek-ai/dsh-plugin-market-index` 的校验器：`title`/`description` 里对象形式必须含 `en`；标签、分类必须先在 `metadata` 里声明；`versions` 不能为空、不能重复版本；`git` 源必须钉到 40 位 commit；图标必须 https 或同源。

## 7. 检查清单

- [ ] 包名可用（或换 scope）
- [ ] `pnpm pack` 产物里 `lib/`、`client/`、`cordis.patch.yml`、`locale/`、`icon.svg` 都在
- [ ] 干净 profile 里 `install_bundle` 一次成功，`status.json` 显示插件已激活
- [ ] 索引用官方校验器验证通过（`scripts/build-market-index.mjs` 已内置）
- [ ] 索引 URL 是 HTTPS，能直接 `curl` 到，且 `market/icon.svg` 同目录可访问
- [ ] README 里写了 `engines.dsh` 范围，和实际测过的 DSH 版本一致

## 8. 常见坑

| 现象 | 原因 |
|---|---|
| 装了但侧栏没变化 | 插件是 `link:` 装的，宿主包解析失败；发 npm 或装 tgz |
| Discover 里搜不到 | 索引 URL 没加，或 `plugin-market` bundle 没启用 |
| 索引报 `$.plugins[0].versions[0].publishTimestamp must be an integer ...` | 时间戳用了毫秒或写了字符串 |
| 图标 404 | 图标路径相对索引 URL 解析，`icon.svg` 必须和 `index.json` 同目录或换成 https 绝对地址 |
| 装完 DSH 提示版本不兼容 | `engines.dsh` 范围没覆盖用户版本，或插件在旧版本上真的会挂 |
| 安装被拒：`failed to parse overlay ... cordis.patch.yml: YAMLException: bad indentation` | `name:` 的值以 `@` 开头却没用引号（YAML 把 `@` 当保留字符）。写成 `name: '@scope/pkg'` |
