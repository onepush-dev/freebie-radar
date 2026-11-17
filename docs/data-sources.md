# 数据源侦察报告

> 按源固定分类、RSS 表单过滤、误判诊断与人工移动见 [分类管理指南](classification.md)。

> 实测时间：2026-11-10 / 2026-11-11。所有结论都来自真实请求输出，原始数据见 `docs/probe-results.json`、`docs/probe2-results.json`、`docs/fs-test.json`。

## 当前源总览（2026-11-16 核对）

- **111 个内置源，默认启用 62 个**：以 `SEEDS` 为准，实时状态用 `pnpm tsx src/server/cli.ts sources` 查看。
- **采集器分布**：RSS 77、V2EX 5、GitHub readme 4、Telegram 3、NGA 3、CCTV 3、登录态回环（知乎/小红书/小黑盒）3、LINUX DO 2、GamerPower 2、Bluesky 2，OpenRouter / Epic / Steam / CheapShark / GOG / B站 / 微博各 1。
- **27 个分类 × 6 种形态 × 8 个频道**，口径见 [classification.md](classification.md)。
- 下文第 1–9 节是逐批侦察记录（带实测日期与原始输出），保留为历史证据；源的增删与启停以 `SEEDS` 和数据库 `sources` 表为准。

## 0. 网络拓扑（决定了整个架构）

| 位置 | 出口 | 能访问 | 不能访问 |
|---|---|---|---|
| 本机 Windows (H:/WorkSpace) | 国内家宽 | GitHub API、52pojie、什么值得买、知乎/小红书/小黑盒页面 | **linux.do、V2EX、Telegram、rsshub.app、github.com(raw)** 全部连接超时 |
| 海外 VPS（美国 / 欧洲节点） | 境外直连 | linux.do RSS、V2EX、Telegram、GitHub、Reddit、RSS | 部分国内站偶发 RST |
| 国内机器 | 国内 | 国内站（知乎/小红书/小黑盒回环采集） | 境外站需配置 `HTTP_PROXY` |

本机实测（`node scripts/probe.mjs`）：

```
linuxdo_latest_json  -> ERR UND_ERR_CONNECT_TIMEOUT
v2ex_api_free_node   -> ERR UND_ERR_CONNECT_TIMEOUT
gh_api_rate          -> 200   (api.github.com)
gh_commits_atom      -> ERR UND_ERR_CONNECT_TIMEOUT   (github.com 主站)
rsshub_zhihu_hotlist -> ERR UND_ERR_CONNECT_TIMEOUT
telegram_api         -> ERR UND_ERR_CONNECT_TIMEOUT
xhs_explore          -> 200 -> 302 /login
zhihu_home           -> 200 -> 302 /signin
52pojie_rss          -> 200
smzdm_rss            -> 200
```

> 用户明确要求：**本机不允许开启 Clash 代理**。因此凡是被墙的源，一律通过 RN 出网。

### 关键能力：FlareSolverr

当部分站点出现 Cloudflare「Just a moment」时，可通过可选的 FlareSolverr（`docker compose --profile cf up -d`）过盾；日常 `linux.do` 的 RSS 经 `curl` 直连即可拿到 HTTP 200：

```
POST http://flaresolverr:8191/v1  {"cmd":"request.get","url":"https://linux.do/latest.json"}
-> {"status":"ok","message":"Challenge solved!", "solution":{"status":200,...}}
```

注意：`solution.response` 对 JSON 接口会被包进 `<html><body><pre>{...}</pre>`，取 `<pre>` 内容再 `JSON.parse`；HTML 页面请求 60s 超时（`c/36.json` 这类 JSON 接口稳定成功，页面渲染不稳定）。

## 1. 源矩阵

| # | 源 | 入口 | 可达性（实测） | 登录态 | 首版 | 价值 |
|---|---|---|---|---|---|---|
| 1 | **LINUX DO 福利羊毛** `c/36` | `https://linux.do/c/36/l/latest.json?order=created`（经 FlareSolverr） | 200 / 85200B / 30 topics | 否 | ✅ 主力 | ★★★★★ |
| 2 | **LINUX DO 资源荟萃** `c/14` | `https://linux.do/c/14/l/latest.json?order=created` | 同上机制 | 否 | ✅ 主力 | ★★★★ |
| 3 | **V2EX 免费赠送** `node=free` | `https://www.v2ex.com/api/topics/show.json?node_name=free` | 200 / 22395B / JSON 数组 | 否 | ✅ 主力 | ★★★★★ |
| 4 | **GitHub free-for-dev** | `https://api.github.com/repos/ripienaar/free-for-dev/contents/README.md` | 200 / 383539B / base64 | 否 | ✅ | ★★★★ |
| 5 | GitHub 其它 awesome 仓库 | `https://api.github.com/search/repositories?q=...` | 200 | 否 | ✅ | ★★★ |
| 6 | **福利吧 fuliba** | `https://fuliba.net/feed` | 200 / 213938B / RSS 20+ | 否 | ✅ | ★★★★ |
| 7 | **Telegram 频道** | `https://t.me/s/<channel>` | 200 / 146819B（RN 直连） | 否 | ✅ | ★★★★★ |
| 8 | 吾爱破解 52pojie | `https://www.52pojie.cn/forum.php?mod=rss` | 200 / 9214B（**GBK 编码**） | 否 | ⚠️ 可选 | ★★ |
| 9 | 什么值得买 | `https://www.smzdm.com/rss/` | 200 / 32017B | 否 | ⚠️ 可选 | ★★（多为评测资讯） |
| 10 | 知乎 | `api/v4/search_v3` → 401 `身份未经过验证`；首页 302 `/signin` | 不可匿名 | 是（cookie + `x-zse-96`） | ⏸ 二期 | ★★★★ |
| 11 | 小红书 | `/explore` → 302 `/login`；页面仅 SPA 外壳 | 不可匿名 | 是（cookie + `x-s`） | ⏸ 二期 | ★★★★ |
| 12 | 小黑盒 | `api.xiaoheihe.cn/bbs/app/api/web/feeds` → 404；首页 3918B SPA 外壳 | 需签名 | 是 | ⏸ 二期 | ★★★ |
| 13 | RSSHub 公共实例 | `rsshub.app` → **403 Cloudflare**（RN 同样 403）；`rsshub.rssforever.com` → 503 | 不可用 | - | ❌ 降级 | - |
| 14 | hostloc | `forum.php?mod=rss` → 200 但返回 HTML（CF 拦截页），无 XML | 不可用 | - | ❌ 降级 | - |
| 15 | 线报酷 linebaoku | `/feed` → 000 超时 | 不可达 | - | ❌ 降级 | - |

### 样本（真实抓取，2026-11-10）

linux.do `c/36` 福利羊毛：

```
#3152335 mlh联合Grok Premium 免费一个月
#3152067 【双十一抽奖】拿出 600 美刀额度，请 22 位佬友用模型
#3151806 【快跑AI】 Qwen Audio 系列多款音频模型 72 折 已上线 注册送10$
#3151437 云栖Emby 此次开放注册150人
```

52pojie（GBK 解码后）：

```
锁定解锁文件夹工具v20261110
全新PC微信实用小工具
求芝士架构系统架构设计师2026年最新资料
```

## 2. 首版落地范围

**纳入**：linux.do(36/14)、V2EX free、GitHub(free-for-dev + awesome 搜索)、fuliba、Telegram 频道、52pojie、smzdm。

**降级/二期**：知乎、小红书、小黑盒 —— 三者都需要登录态 + 请求签名，且采集端在墙外服务器上没有用户浏览器会话。二期方案（已与用户确认方向）：本机已登录浏览器（CDP）抓取后 POST 到服务端 ingest 接口。

**不纳入**：RSSHub 公共实例、hostloc、线报酷（实测不可用）。

## 3. 采集约束

- 限速：同一源最小间隔 2s；linux.do 走 FlareSolverr 时串行，单次 maxTimeout 60s。
- 凭据：FlareSolverr 地址、GitHub token（可选，把 60/h 提到 5000/h）、Telegram 频道清单全部走环境变量。
- 增量：按 `(source, external_id)` 唯一键去重；适配器返回 `cursor`（如 linux.do 的 `more_topics_url`）用于翻页。
- 失败隔离：单源异常写入 `runs` 表 status=failed + 错误摘要，不影响其它源。

## 4. 待办（进入实现前已确认）

1. 当前默认部署架构为海外单容器（Docker Alpine + built-in SQLite），配合本机回环助手完成登录态站点采集。

## 5. 实际采集结果（2026-11-11 本机实测）

| 源 id | adapter | 条数 | 耗时 | 结果 |
|---|---|---|---|---|
| linuxdo-welfare | linuxdo (c/36) | 30 | 109.8s（首次建 session） | ok |
| linuxdo-resource | linuxdo (c/14) | 30 | 7.6s（复用 session） | ok |
| v2ex-free | v2ex (node=free) | 10 | 2.1s | ok |
| github-free-for-dev | github-readme | 60 | 2.4s | ok |
| rss-52pojie | rss (GBK) | 20 | 0.18s | ok |
| rss-smzdm | rss | 20 | 0.25s | ok |
| rss-fuliba | rss | 20 | 0.79s | ok |
| tg-channels | telegram | 0 | — | **blocked：缺真实频道清单** |

入库后分布：linuxdo-welfare 均分 56、v2ex-free 均分 63、linuxdo-resource 42、52pojie 39、fuliba 36、github 33、smzdm 26。

### 结论与后续

- **linux.do 可以跑**：FlareSolverr 复用命名 session 后，第二次起从 ~110s 降到 ~8s。首次仍需耐心（Chromium 冷启动 + 解挑战）。
- **v2ex 可以跑**：同样的 fs 通道，2s 返回 10 条 JSON。
- **GitHub / 52pojie / smzdm / fuliba 直连可用**：无需任何登录或代理。52pojie 的 GBK 编码靠 Content-Type + XML 声明双重探测解出。
- **tg-channels 仍 blocked**：`t.me/s/<channel>` 抓取逻辑已验证可用（用 `durov` 测到 20 条消息），但手上没有可确认存在且持续更新的中文羊毛频道清单，源保持 disabled，等用户给频道名后 `cli.ts config tg-channels '{"channels":[...]}'` 一行即可启用。
- **知乎 / 小红书 / 小黑盒**：维持二期（需登录态 + 签名），在 `/status` 中以 blocked 呈现。
2. Telegram 推送用户已明确「先不急做这个」，首版只落本地日报，接口预留。

## 6. 三个登录态站点（Playwright + 持久化 profile，2026-11-11 实测打通）

三站都需要用户登录态；小黑盒还额外要求前端签名。最终方案：**Playwright 驱动一个持久化的 Chrome profile**（`%LOCALAPPDATA%\freebie-radar-chrome`），登录一次写进磁盘，之后任意次运行都带着登录态。

实现：`scripts/pw-collect.mjs`，结果 POST 到 `SERVER_URL/api/ingest`（Bearer token）。

| 站 | 抓法 | 实测 |
|---|---|---|
| 知乎搜索 | `/search?type=content&q=`，读 `.SearchResult-Card` 的 `h2 a` + `.RichText` | ✅ 3 关键词去重后 47 条（inserted=3，其余已存在） |
| 小红书搜索 | `/search_result?keyword=`，滚动 3 屏后读 `section.note-item` 的 `.title span` + `a.cover` | ✅ 3 关键词去重后 74 条，全部新增 |
| 小黑盒搜索 | `/app/bbs/home` → 填 `.el-input__inner` + Enter → 监听 `general/search` 响应 | ✅ 2 关键词去重后 20 条（inserted=7） |

### 小黑盒为什么必须走浏览器

搜索接口 `https://api.xiaoheihe.cn/bbs/app/api/general/search/v1` 需要 `hkey` / `_time` / `nonce` / `_rnd` 四个签名参数，由前端 JS 生成，直接 HTTP 请求无法复现。因此用 Playwright 监听 `page.on("response")`，让页面自己发签名请求，脚本只负责填关键词、回车、读拦截到的 JSON。

附带发现：小黑盒 web 端没有独立搜索路由，`/app/bbs/search` 会被重写成 `/app/bbs/home` 且丢弃关键词；只有 UI 输入框触发的 SPA 跳转 `/app/search/list?q=...` 才会真正调签名接口。

### 走过的弯路（记录以免重犯）

1. **ego-browser**：知乎可用（复用用户日常浏览器登录态），但小红书在该实例里始终未登录，且 `taskSpace` 会被用户接管导致脚本报 `already exists and belongs to the user`。
2. **独立 Chrome + CDP**：用户在该 profile 扫码登录成功，但 CDP 手写客户端要自己处理等待与选择器；改为 Playwright 后同一 profile 直接可用，`launchPersistentContext` 一行拿到登录态。
3. Playwright 用 `channel: "chrome"` 复用系统 Chrome，与已有 profile 完全兼容，无需 `playwright install`。

### 去重验证

- 知乎第二次：`received=47 inserted=3 skipped=44`
- 小黑盒第二次：`received=20 inserted=7 skipped=13`

同一资源不会重复入库，只有标题/摘要变化的会更新。

## 7. 第二批源（游戏与海外福利，2026-11-11 实测）

用户反馈「白嫖内容不够、游戏方面太少」。新增 8 个源，全部实测入库：

| 源 id | 采集器 | 入口 | 实测 |
|---|---|---|---|
| `gamerpower` | gamerpower (JSON) | `gamerpower.com/api/giveaways?type=game` | ✅ 14 条（Epic/Steam/GOG/itch.io/IndieGala/DRM-Free 全平台聚合，含 worth 与 end_date） |
| `epic-free` | epic (JSON) | `store-site-backend-static-ipv4.../freeGamesPromotions` | ✅ 3 条（本周免费 2 + 即将免费 1，带原价与起止时间） |
| `rss-reddit-freegames` | rss | `reddit.com/r/FreeGameFindings/hot.rss` | ✅ 25 条 |
| `rss-reddit-efreebies` | rss | `reddit.com/r/efreebies/hot.rss` | ✅ 25 条 |
| `rss-reddit-gamedeals` | rss | `reddit.com/r/GameDeals/hot.rss` | ✅ 25 条 |
| `rss-slickdeals` | rss | `slickdeals.net/newsearch.php?rss=1` | ✅ 25 条 |
| `rss-heyitsfree` | rss | `heyitsfree.net/feed` | ✅ 20 条 |
| `rss-keylol` | rss | `keylol.com/forum.php?mod=rss`（中文 Steam 社区） | ✅ 20 条 |

结果：游戏类条目从 23 → **102**，全站在库 710 条 / 18 个有数据的源。

### 踩到的两个坑

1. **Reddit 的 atom feed 触发 XML 实体展开上限**：`Entity expansion limit exceeded: 1028 > 1000`。fast-xml-parser 默认展开实体并限制 1000 次，Reddit 的单条 feed 就超了。解法：`processEntities: false`，实体交给后面的 `cleanText` / `decodeEntities` 统一处理。
2. **Reddit 连续请求 429**：同一 IP 连抓 3 个子版会被限流（HTTP 429），隔 45 秒重试即可通过。当前三个 Reddit 源分属不同 `source_id`，服务器定时批次里会连续触发，因此把它们的采集间隔留给统一限速（`MIN_REQUEST_GAP_MS`）+ 失败重试自然恢复；单轮失败会被记为 failed 并在下一轮补上。

### 探测后放弃的源

| 目标 | 状态 | 原因 |
|---|---|---|
| old.reddit.com JSON | 403 | IP 被封，只有 .rss 可用 |
| GOG 免费列表 API | 400 | `/games/ajax/filtered?price=free` 已改接口 |
| freestufffinder.com | 403 | Cloudflare |
| NGA 福利版 | 403 | 反爬 |
| nitter.net | 410 | 实例已下线 |
| steamdb.info/upcoming/free | 403 | Cloudflare |
| x.com/EpicGames | 200 HTML | 能打开但内容是 JS 渲染 + 登录墙，单页解析不稳定；tg/reddit 已覆盖同类信息，暂不接入 |

## 8. 第三批源（全量铺开，2026-11-11）

按「能找到的全加」的要求，又探测约 50 个候选，落地 13 个新源：

| 源 id | 实测 |
|---|---|
| `rss-reddit-freebies` / `-apphookup` / `-freeebooks` / `-googleplay` | 各 25 条（App 限免、免费电子书、Google Play 折扣） |
| `rss-giveawayoftheday` | 10 条（每日一款正版软件限免） |
| `rss-appinn`（小众软件） | 10 条 |
| `rss-sspai`（少数派） | 10 条 |
| `rss-ithome`（IT之家） | 25 条 |
| `rss-producthunt` | 25 条 |
| `rss-hnrss`（HN 100+ 分） | 16 条 |
| `rss-freebieshark` | 23 条 |
| `rss-9to5toys` | 25 条 |
| `steam-free` | 1 条（`search/results?maxprice=free&specials=1`，当前只有 1 个 100% off） |
| `gog-free` | **已禁用**，见下 |

全站在库 1051 条 / 31 个有数据的源，游戏类 111 条。

### Reddit 限流（关键约束）

Reddit 对同一 IP 的 `.rss` 请求限制极严：并发 4 路会全 429，串行 9 秒间隔仍会有 6/9 失败。因此：

- 新增 `SOURCE_GAP_MS`（默认 3000）在 `runAll()` 的源之间插入间隔；
- Reddit 各子版拆成独立 `source_id`，单源失败只标记自己 failed，不牵连其它源，下一轮自动补；
- 实测同源重试 1 次即成功（`freeebooks` 首次 429，20 秒后 ok）。

### GOG 为什么放弃

`catalog.gog.com/v1/catalog` 的 `price=free` / `priceBetween=0,0` / `discount=100` 三个参数**实测都不生效**：返回 48 个普通折扣游戏（-10% / -50% / -90%），没有一个是 0 元。GOG 真正的免费（GOG Giveaway）通过首页 banner 发放，商店页是 Angular SSR，解析成本高而单周通常只有 0-1 个。源保留但 `enabled=false`。

### Steam 的一个正则坑

`<a href=".../app/...">` 上挂了超长的 `onmouseover` / `data-ds-*` 属性，从 `href` 到 `<span class="title">` 实际有 1-2KB。最初限制 800 字符，结果 0 条；放宽到 3000 后正常。

### 前端不再写死源名

`App.tsx` 改为启动时拉 `/api/sources`，用后端 `name` 覆盖内置表（`SOURCE_NAMES`）。以后加源只需改 `SEEDS`，前端零改动。

### 探测后仍不可用

`bensbargains` / `hunt4freebies` / `greenmangaming` / `epic_free_page` / `steamgifts` 均 403；`xbox_gwg` 404；`sampleaday` / `free_app_watch` 域名不可解析；`humblebundle` API 403、页面需 JS；`fanatical` API 返回 249KB 但结构为混合页面数据，未找到免费列表字段；`itch.io` 无 JSON 接口（`/games/free.json` 404）。

## 9. 第四批源：国内社区与中文主机圈（2026-11-15 实测）

按「国内源还不够」的要求，重点补 NGA 这类国内社区，并顺带扫了一遍中文羊毛/主机/游戏/试用站点。

### 9.1 NGA 玩家社区（必须登录态）

| 入口 | 结果 |
|---|---|
| `bbs.nga.cn/thread.php?fid=-7` | 403，HTML 标题「未登录」 |
| `bbs.nga.cn/thread.php?fid=570&__output=11` | 403，`{"error":["15:访客不能直接访问",...]}` |
| `nga.178.com` / `ngabbs.com` / `g.nga.cn` 同参数 | 全部 403，错误码一致 |
| 加 `Cookie: guestJs=<秒级时间戳>` | 仍 403（`guestJs` 只是前端时间戳，不是登录态） |
| `app.nga.cn/app_api.php` | 404（旧 App 接口已下线） |

结论：NGA 已全面改为**登录可见**，唯一的可行路径是用户登录后取 `ngaPassportUid` + `ngaPassportCid` 两个 Cookie（第三方 UWP 客户端同款做法）。

落地：`src/server/collectors/nga.ts`（kind=`nga`），走 **HTTP + 托管 Cookie**，不需要无头浏览器：
1. 主通道 `thread.php?fid=<fid>`（GBK HTML，正则取 `/read.php?tid=` 锚点）；
2. 备通道 `thread.php?fid=<fid>&__output=11`（UTF-8 JSON，解析 `data.__T`）。
Cookie 存进既有的 Cookie 托管（新增 site key `nga`，`hasCookieConfiguredForSource` 对 NGA 不要求 VPS 执行器）。
默认源 `nga-deals` → **fid=570 优惠信息购物指南**（羊毛/优惠主版块），间隔 600s。

未配置 Cookie 时的报错是明确的：`未配置 NGA Cookie，请在「数据源运维 → Cookie 托管」粘贴 ngaPassportUid / ngaPassportCid`。

### 9.2 中文主机圈促销（已启用，零配置）

| 源 id | 入口 | 实测 |
|---|---|---|
| `rss-vpsjxw` | `vpsjxw.com/feed` | 200 / 10 条（双十一特价、原生 IP、住宅 IP 系列） |
| `rss-laozuo` | `laozuo.org/feed` | 200 / 10 条（RAKSmart 等线路测评+促销） |
| `rss-veidc` | `veidc.com/feed` | 200 / 20 条（黑五/双11 主机商折扣合集） |
| `rss-vpser` | `vpser.net/feed` | 200 / 10 条（EdgeNAT、HHOST 等月付折扣） |
| `rss-banwagong` | `banwagong.net/feed` | 200 / 10 条（搬瓦工套餐与优惠码） |

本地实测入库 60 条，分类落在 `vps` / `deal`，评分 66-75，无需任何代理。

### 9.3 探测后放弃（本轮新增证据）

| 目标 | 结果 | 原因 |
|---|---|---|
| 52pojie 全站 RSS | 200 / 20 条 | 内容为破解教程与「求资源」混排，福利纯度不足，保持 `enabled=false` |
| 52pojie 福利经验区 `fid=66` RSS | `Specified forum not found` | 该版块未开 RSS；版块页只解析出 3 条锚点，结构不适合列表采集 |
| 卡饭 `bbs.kafan.cn` | 全站 RSS 200 / 20 条 | 版块全是杀软/样本/硬件，无福利版块（`fid=39` 不存在） |
| 恩山 `right.com.cn` | 200 但返回 JS 挑战页 | 反爬，需浏览器 |
| 远景 `bbs.pcbeta.com` | 200 但返回「请启用 JavaScript」 | 同上 |
| 百度贴吧 `tieba.baidu.com/f?kw=免费` | 403 | 反爬 |
| 豆瓣小组 | 讨论页 200 但无 RSS | 豆瓣已停小组 feed（`/feed/group/<id>/discussion` 404），HTML 结构脆弱 |
| 什么值得买「白菜党」 | 404 | 频道已改版；`post.smzdm.com/feed/` 是原创长文（生活/评测），非好价 |
| 酷安 / 券妈妈 / TapTap | 200 但为 JS 反爬外壳（`renderData`） | 需签名或渲染 |
| 京东试用 / 淘宝试用 | 200 空壳 / 500 | 需登录 |
| 游研社 / 掘金 / 快科技 | RSS 可用（12 / 20 / 100 条） | 游戏资讯与技术文章，不是福利，未纳入 |
| S1 论坛 `bbs.saraba1st.com` | 连接超时 | 本机不可达 |
| 虎扑 / 3DM / 17173 / VGtime | 200 首页 | 无福利频道，HTML 列表页噪声大 |
### 9.4 NGA 版块地图（免登录枚举，2026-11-15）

NGA 的列表页对访客 403，但**版面权限页是免登录的**：
`https://bbs.nga.cn/nuke.php?__lib=view_privilege&__act=view&id=<fid>` → 200，返回该版块的层级链与访问条件。
扫 fid=400..900（每次 120ms）得到 463 个存在的版块，其中 106 个因为层级链里出现了父版块名而拿到了名字。

关键发现：**570 不是孤立的购物版，它挂在「杂谈 > 消费电子 IT新闻」下**：

```
杂谈 (668)
└─ 消费电子 IT新闻 (436)
   ├─ 498  二手交易
   ├─ 570  优惠信息购物指南        ← 已接入 nga-deals
   ├─ 576  （名称待确认）
   └─ 613  分享活动买家互助（拼车/拼单） ← 已接入 nga-carpool
```

`668 杂谈` 的其它子版：`-7` 网事杂谈、`-343809` 汽车俱乐部、`-1459709` 职场人生、`-576177` 影音讨论区、`-447601` 二次元国家地理、`-84` 模玩之魂、`-81981` 生命之杯；另有 `524` 漩涡书院（网络文学）。

版块名确认来源：搜索引擎收录的 `thread.php?fid=<fid>` 页面标题（570=优惠信息购物指南、498=二手交易、613=分享活动买家互助、524=漩涡书院、428=手机网页游戏综合讨论、650=原神、307=论坛公告、572=二次元国家合集、863=手机游戏快讯）。

访问条件差异（同一接口返回）：

| 版块 | 访问条件 |
|---|---|
| 498 / 570 / 613 | 主题最后回复时间在 2019-04-01 之后 **并且** 是访客或注册用户 |
| -7 网事杂谈 | 主题发布时间在 144 小时内 **并且** 是**注册用户** |

「访客」指的是 NGA 游客 cookie 机制，而 `thread.php` 连游客 cookie 都不再下发，所以实际上仍然需要 `ngaPassportUid` + `ngaPassportCid`。

落地：新增两个源，与 `nga-deals` 共用 `nga` 采集器（`categoryHint` 由 config 透传到每条条目）：

- `nga-carpool` → **fid=613 分享活动买家互助**，`categoryHint: carpool`（拼车 / 合租 / 拼单），间隔 900s
- `nga-trade` → **fid=498 二手交易**，`categoryHint: trade`（二手设备 / 出鸡），间隔 1200s

**暂不接入**：`-7` 网事杂谈 —— 水区流量大但福利帖占比极低，且需要注册用户 + 只看 144 小时内新帖，噪声与配额成本不成正比；若要接，先加标题关键词白名单（免费/领取/白嫖/兑换码/0 元）。各游戏专区下的「兑换码」帖子同理，噪声高于收益。

### 9.5 B 站（wbi 签名搜索，免登录，2026-11-15）

结论：**B 站可以零 cookie 采集**，靠公开的 wbi 签名算法。

| 接口 | 实测 | 说明 |
|---|---|---|
| `x/web-interface/nav` | 200 code=0 | 返回 `wbi_img.img_url` / `sub_url`，未登录也给 |
| `x/web-interface/wbi/search/type` | 未签名 -403/-352；签名后 **code=0，20 条/页** | 主通道，`search_type=video` 或 `article` |
| `x/web-interface/search/all/v2` | 200 code=0 | 免签名，作 wbi 失效时的降级通道 |
| `x/web-interface/ranking/v2?rid=` | 200，每区约 100 条 | 可用但与福利无关（全站热榜） |
| `x/web-interface/popular` | 200，20 条 | 同上，未采用 |
| `x/polymer/web-dynamic/v1/feed/space` | 无 cookie 返回空 | UP 主动态需登录态，暂不接 |

wbi 签名实现（`src/server/collectors/bili.ts`）：取 `img_url` / `sub_url` 的文件名拼成一个 64 字符串，按固定 MIXIN 表重排后取前 32 位当密钥；请求参数按字母序拼接 + `wts` 时间戳，`w_rid = md5(query + key)`。keys 进程内缓存 1 小时。

实测一次采集（关键词：免费领取 / 白嫖 / 喜加一 / 限时免费，每词 15 条）：

```
免费领取 ok:20 kept:15
白嫖     ok:20 kept:15
喜加一   ok:20 kept:15
限时免费 ok:20 kept:1      ← 其余是影视剧集，被标题白名单挡掉
相似标题合并 46 → 45
fetched=45 inserted=44 duration=6511ms
```

入库后 `kind` 分布：`freebie=40 / deal=4`；`category`：game 23、media 11、goods 4、other 4、ai 1、edu 1。当日正好是 BLG 夺冠送大会员，media 类全是这条真实福利。

### 过滤与去重策略（踩过的坑）

1. **标题词只看标题，不看简介**：一开始把 `title + summary` 一起匹配"免费"，结果「【4K超清】橘里夫人 全12集」因为简介里有"免费"被放进来。改为标题命中白名单、简介只参与排除词。
2. **相似标题合并要区分「跨 UP 复述」与「同 UP 系列」**：实测 BLG 送大会员被 10 个 UP 复述，两两 bigram Jaccard 0.71-0.77；而同一 UP 的每周喜加一汇总（`【免费白嫖1511】` vs `【免费白嫖1474】`）相似度只有 0.39-0.47。所以阈值取 0.7 **并且要求作者不同**才合并 —— 单看相似度会把周报系列误杀。
3. **已知噪声**：私服/引流广告（如「DNF70 龙服预热…送黑钻」）能通过标题白名单并拿到 78 分，靠全局屏蔽词（`block_rules`）处理，不在采集端硬编码。

> 未接入：B 站 UP 主动态（需 cookie）、`t.bilibili.com` 动态页（SPA 渲染）。若后续要盯固定 UP 主，复用 Cookie 托管加一个 `bilibili` 站点即可。
### 9.6 微博（没有 RSS 可用，但 PC ajax 能直采；实测噪声过高，默认关闭）

**先回答「微博有没有现成 RSS」：有路由，但没有能用的实例。**

| 通道 | 实测（2026-11-15） |
|---|---|
| `rsshub.app/weibo/keyword/…` | 连接失败 |
| `rsshub.rssforever.com/weibo/keyword/…` | 503（返回 RSSHub 欢迎页） |
| `rss.shab.fun/weibo/keyword/…` | 连接失败 |
| 微博官方 | 不提供 RSS |

RSSHub 确实有 `/weibo/user/:uid`、`/weibo/keyword/:keyword` 路由，但公共实例全挂；自建要 Node + Chromium（Puppeteer 渲染微博）常驻 200MB+ 内存，与「单机轻量、不加常驻容器」的取舍冲突。所以走直采。

**直采通道（需要 weibo.com 登录 Cookie，`SUB` 是主凭据）**

| 接口 | 实测 |
|---|---|
| `weibo.com/ajax/statuses/search?q=<kw>&page=1` | 200 / 340KB / `statuses[]` 48-50 条 / `total_number` 命中总数（"免费领取"=2,270,277）；`sort=hot|time` **参数无效**，恒为时间序 |
| `weibo.com/ajax/statuses/mymblog?uid=<uid>&page=1&feature=0` | 200 / `data.list[]` 20 条（盯指定博主） |
| `s.weibo.com/weibo?q=<kw>` | 200 / 293KB HTML（登录态可用，解析成本高，未用） |
| `m.weibo.cn/api/container/getIndex` | 用 PC cookie 返回 `ok:-100` 跳登录 —— **PC 的 SUB 在 m.weibo.cn 域不认**，移动端接口必须用移动端登录态 |

字段映射：`mid` 作 externalId、`user.idstr` + `mblogid` 拼出 `weibo.com/<uid>/<mblogid>`、正文 `text_raw`、时间 `created_at`（`Sun Nov 15 20:27:21 +0800 2026` 能被 `new Date()` 解析）、图片 `pic_ids[0]` → `wx1.sinaimg.cn/large/<id>.jpg`（实测 200 image/jpeg 916KB）。

**实测质量问题（这是它与 B 站的关键差别）**

三个关键词（免费领取 / 白嫖攻略 / 羊毛）一轮拿到 60 条，按正文指纹合并营销号刷屏后入库 25 条，但列表里真正能用的只有 2-3 条：

- 擦边图包拿 81 分：`No.11131 花样抹胸裙 [137P-2.06GB] ￥10 获取原图`（正文里带「免费」字样就过了白名单）
- 手游私服广告：`向僵尸开炮0.1最新玩法 进有50000每天20000`
- 同文案刷屏：`11月13日星期五 最新白嫖奶茶教程` 被 4 个号转发（日期不同，指纹合并只能吃掉一部分）
- 新闻误入：`#零元面馆周边商户快交不起房租了#`

微博搜索没有热度排序、也没有"只看带链接的"这类过滤，关键词越泛噪声越大。**因此 `weibo-freebies` 默认 `enabled: false`。**

**如果要启用，用盯人模式而不是关键词**：`config: { uids: ["<羊毛博主 uid>", ...] }`，走 `mymblog` 拿博主的原始时间线，质量远高于搜索（博主本身就是筛选器）。实测两个猜测的 uid（1669937675 / 7512667074）返回 60B 空数据，说明 uid 得给真实的，不能猜。

采集器已实现的能力：搜索 + 盯人两种模式可同时配、白名单/排除词（含擦边与私服）、同文案指纹合并（保留互动量最高的一条）、正文首句切标题（按 `。！？，；` 切）。
### 9.7 踩坑：改 `SEEDS` 不影响已存在的源

`ensureSources()` 的 SQL 是 `ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind` —— **只同步 name / kind，不动 config / enabled / interval_sec**（故意为之：运维台手改过的配置不能被内置值覆盖）。

所以本地调 `SEEDS` 后如果发现行为没变，先查库：

```sql
SELECT id, enabled, config FROM sources WHERE id = '…';
```

实测就踩过：把 `nga-carpool` 的 `categoryHint` 从 `carpool` 改成不设置，重跑后 28 条仍然被判成 `carpool`，原因是库里的旧 config 还在。手动 `UPDATE sources SET config = …` 后才生效。

顺带记录 613 版块的分类结论：内容是团购/拼单（`辉山纯牛奶20盒30元`、`三人团 芬达5瓶7.9元`），**既不是 carpool（拼车/合租）也不是 other**：

| categoryHint | 结果 |
|---|---|
| `carpool` | 35 条全被强制成「拼车/合租」—— 团购≠拼车，错 |
| 不设置 | 规则判成 `other` 28 条 + `goods` 7 条 —— 大量丢分类 |
| `goods` | 35 条全 `goods`（生活羊毛/实物）—— 采用 |

另一个已知偏差（未在本次范围内修）：这 35 条 `kind` 判成 `freebie=34 / deal=1`，但它们是"30 元 20 盒牛奶"这类好价，理想应为 `deal`。属于既有 kind 规则对「N 元」的判定精度问题。
