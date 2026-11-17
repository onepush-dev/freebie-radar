# 变更记录

## 2026-11-16

### 实地福利收紧：先得是福利，再谈实地

- **根因一：AI 判对的分类被丢掉了**。采集落库（`collectors/index.ts`）只把 AI 的 `category` 拿去算 `kind`，写进 `items.category` 的始终是关键词规则结果；线上 51 条 `offline` 里有 42 条 AI 给的是 `tech` / `news` / `goods` / `headline`，全被规则覆盖。现在 AI 分类优先落库，规则只在 AI 没给时兜底
- **根因二：`offline` 规则只认地点词**。「附近」「现场」「门店」单独命中就能进实地福利，于是「杭州附近的兄弟有吗…一起免费玩」这类闲聊、防火玻璃抽检通报都被收进来。规则改为 `require` 必须同时出现领取动作（免费领 / 领取 / 免费送 / 派样 / 试吃…），并 `exclude` 抽检、不合格、通报、求租、租房、租房组队这类资讯与求助
- **统一收口 `demoteOfflineCategory()`**：`offline` 只接受 `kind ∈ {freebie, deal}`；`news` / `info` / `noise` 一律降级。enrich、AI 审核落库（`ai-queue`）、补审（`ai-admin`）、采集落库、`reclassify` 五处共用同一函数，不再各写一套
- **`reclassify` 优先采用 AI 分类**：后台「零 Token 重分类」以前对已审核条目只保留库里的旧分类，现在先读 `ai.category`，再退回库值 / 规则值
- **Schema v29**：把 `offline` 里 kind 为 `news` / `info` / `noise` 的条目和历史误判（不合格 / 抽检 / 通报 / 求租 / 租房 / 记者 / 发布会 / 峰会）移出
- **口径收紧到「先福利，再实地」**：`isOfflineWorthy()` 要求 `kind=freebie` + 线下场景词（到店/门店/现场/商场/专柜/快闪/自提/打卡/试吃/博览/市集…）+ 领取动作 + 中文文本。好价（deal）、全英文的海外线上促销（如 Walgreens 照片卡、DQ 2 for $6）一律不进
- 实测：`pnpm test` 90/90、`pnpm typecheck` 干净；本地 448 条库 `offline` 2 → 1（南京「零元面馆」排队免费领素面），二次运行 changed=0
- 线上（andnode，8092 条）重跑 `reclassify`：`offline` 51 → 1，只剩「海口博博会，河北博物院礼品免费送」；AI 判为 `tech`/`news`/`goods` 的 42 条随重分类归位，`/api/items?category=offline` 返回 1 条，前端「实地福利」频道显示 1 条

### 移动端顶栏瘦身、首屏体积与接口压缩

- **拒绝安卓自动深色**：`styles.css` 的 `color-scheme` 由 `light` 改为 `only light`，并在 `index.html` 补 `<meta name="color-scheme" content="only light">`。此前手机开深色模式时 Chrome 的「自动深色」会把整站反相成纯黑底 + 灰描边，浅色设计被彻底毁掉；CSS 里只写 `light` 不足以拒绝自动反相，必须是 `only light`（实测 computed `light only` 后停止反相）
- **移动端顶栏 9 行 → 5 行**：说明/RSS/GitHub/导出/刷新收进品牌行（纯图标），账号并入 Tab 行右端，场景与数据源（快捷视图 + 数据源树）折进「筛选」面板，筛选条件整条按钮与视图切换两键各合成一个图标，统计并进分类行右端；顶栏高度 320px → 203px（−37%）
- **GitHub 入口**：品牌行与桌面侧栏新增 GitHub 图标，新窗口跳 `https://github.com/ZiChuanLan/freebie-radar`
- **面板按需加载**：`DigestPanel` / `HotPanel` / `RulesPanel` / `PushPanel` / `AiPanel` / `OpsPanel` / `SiteAdminPanel` / `UserPushPanel` 改 `lazy` + `Suspense`，React 单独成 vendor chunk（`vite.config.ts` 的 `manualChunks`）。首屏 JS 528KB → 334KB（未压缩），首次进入管理区才拉对应面板
- **接口压缩**：服务端加 `compress()` 中间件（此前 `/api/items?limit=100` 77KB 明文裸传）。实测该接口 77218 → 7197 字节，整页传输 648KB → 123KB
- **实测**（Playwright 390×844，4x CPU 降速）：FCP 472ms → 372ms；滚动帧 p95 7.8ms、无 >50ms 掉帧；标签页来回切 20 轮 DOM 节点稳定 840、堆内存锯齿不增长（无泄漏）；`pnpm typecheck`、`pnpm test` 87/87、`vite build` 均通过
### 多登录渠道、名额上限与 Webhook 推送

- **GitHub 登录**：新增 `/api/auth/github/login|callback`，与 LINUX DO 共用一套准入收尾 `finishLogin()`（登录开关 / 名额上限 / 邀请码 / 封禁 / 老用户直登），避免两套逻辑跑偏；GitHub 无 `trust_level` 概念，最低信任等级门槛对它不生效（按 0 处理）；内部用负数 `linuxdo_id` 做命名空间，两个渠道 id 互不冲突。凭据：`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_REDIRECT_URI` / `GITHUB_PROXY`
- **注册名额上限**：`AccessControl.maxUsers`（0 = 不限）。满了只挡新注册，老用户照常登录；命中时回调跳 `/#quota-full`、接口返回「站点名额已满（x/y）」。后台「访问控制」可直接改
- **Webhook 推送渠道**：个人推送新增 `deliverVia`（`telegram` / `webhook`）+ `webhookUrl` + `webhookSecret`，投递 POST JSON `{source, text, sentAt}` 并带可选 `X-Radar-Secret` 头；不需要 Bot Token 即可启用，个人日报与测试消息同样走该渠道。QQ 官方 Bot 无主动推送通道（只能带 `msg_id` 被动回复），改用 NapCat / Lagrange 的 OneBot HTTP 接口接这一层
- **开放注册不再显示邀请码**：登录弹窗里的邀请码输入只在 `registrationMode=invite` 时渲染，开放注册下整块隐藏
- **本地模拟登录遵守真实准入**：`AUTH_DEV_MOCK` 的 Alice/Bob 在邀请码模式下同样返回 `needInvite` 并弹补码框，不再无条件建号
- **测试可重复性**：测试文件头部显式清空 `ADMIN_TOKEN` 并固定 `SITE_MODE=selfhost`，避免本机 `.env` 配了公开站/管理令牌后测试集体 401/403
- 实测：个人 Webhook 端到端（本地接收端收到 `POST /hook`、`X-Radar-Secret: s3cret`、正文含测试消息）；名额上限 1 时新用户注册被拒、老用户不受影响；`pnpm typecheck` 干净，`pnpm test` 87/87
## 2026-11-15

### 公开站：LINUX DO 登录、个人状态隔离、个人 Bot 推送与 RSS

- **站点双模式**：新增 `SITE_MODE`（`auto` / `selfhost` / `public`）。`selfhost` 完全保持旧的全局行为；`public` 下公共内容（`items` / `sources` / `digests`）只读共享，个人状态按登录用户隔离
- **公开站个人隔离**：新增 `users` / `sessions` / `user_item_states` / `user_block_rules` / `user_subscriptions`（Schema v28）；`/api/items`、`/api/stats`、条目详情、日报改用自包含 `EXISTS` 子查询按 `user_id` 过滤（`merge=1` 的窗口函数子查询拿不到外层 JOIN 别名，不这么写会直接报错）
- **未登录访客零副作用**：公开站访客的「不想看 / 收藏 / 已读 / 快捷屏蔽」只写浏览器 `localStorage`，不发请求；顶栏显示本机偏好计数，登录后可一键合并到账号
- **LINUX DO Connect OAuth2 登录**：`/api/auth/linuxdo/login|callback`，CSRF `state` 与预填邀请码一起签名存短期 Cookie；校验 `active` / `silenced` / `trust_level`；`/api/auth/me`、`/api/site/bootstrap` 供前端取身份与站点状态；非生产环境可开 `AUTH_DEV_MOCK` 用 Alice/Bob 双账号验证隔离
- **权限严格正交**：管理区只认 `ADMIN_TOKEN`（定长摘要比对），**OAuth 登录不构成任何管理权限**；公开站未配 `ADMIN_TOKEN` 时管理写接口直接 403 锁定，不再像旧版那样无密码全开
- **登录开关与邀请码**：后台可热改「关闭登录 / 开放注册 / 邀请码注册 / 停止新注册」与最低信任等级；邀请码支持单次/多次、过期时间、停用、核销记录，核销走 `BEGIN IMMEDIATE` + 条件 `UPDATE`，并发不会超发；老用户始终免码登录，新用户可先登录再补码（10 分钟签名凭证）
- **个人 Telegram Bot**：登录用户绑定自己的 Bot Token（AES-256-GCM 加密落库，接口只回打码值）+ Chat ID，支持 `getUpdates` 一键探测 Chat ID、发测试消息、规则试算、立即冲刷；个人推送复用同一套过滤/攒批/免打扰引擎但独立去重与限流，个人上限受 `USER_PUSH_MAX_PER_HOUR` / `USER_PUSH_MAX_PER_INSTANT` 夹紧，连续 3 次发送失败自动停用
- **个人推送不依赖全局 Bot**：全局没配 `TELEGRAM_BOT_TOKEN` 时，只要有人开了个人推送，采集后仍会跑「AI 一审 → 派发」链路（含后台补审通过后的二次派发）
- **RSS 2.0 输出**：`/rss.xml`（含 `/rss/api` 别名外的 `/api/rss`）支持 `preset`/`kind`/`category`/`source`/`obtain`/`minScore`/`search`/`limit` 等筛选，带 `ETag` 与 304；`/rss/u/:token.xml` 是个人专属源，自动排除个人关闭与个人屏蔽词，支持 `?mode=push`（按个人推送规则）与 `?mode=subs`（只看关注词）
- **入站提示**：`settings.onboarding` 可热改标题/正文/引导卡片，按版本号记一次；站长「保存并重新弹出」时版本自增，所有访客下次进站重新看到
- **版本检测与一键更新**：`/api/admin/overview|update/check|update/run|update/status`；Git 源码环境支持「脏工作区拒绝 → SQLite `VACUUM INTO` 备份 → `git pull --ff-only` → install/build → 重启」，容器环境如实显示边界（Webhook 触发或复制宿主机命令），`/health` 增补 `commit` 供前端判断新版本是否真的起来了
- **清理与 AI 反馈防污染**：数据保留策略删除条目时排除「被任意登录用户收藏」的条目；AI 提示词反馈只统计全局标记，普通用户操作不会污染全站审核口径
- **接口健壮性**：`/api/ingest` 对缺失 `externalId` 的回传条目回退用 URL 兜底（此前会把 `undefined` 绑进 SQLite 直接 500）
- 本地端到端实测 51 项全通过（公开站隔离 / 权限正交 / 邀请码 / RSS / 个人 Bot 打码 / 公告热更新 / 关闭登录），另单独跑 `SITE_MODE=selfhost` 回归确认旧部署行为不变；`pnpm typecheck`、`pnpm test`（69 例）、`vite build` 均通过

### 国内源补强：NGA 优惠版（登录态）+ 5 个中文主机圈促销源

- 新增 `nga` 采集器（`src/server/collectors/nga.ts`）：NGA 已全面改为登录可见，实测所有镜像域名对访客返回 403「15:访客不能直接访问」（`guestJs` 时间戳无效），因此走 HTTP + 托管 Cookie（`ngaPassportUid` / `ngaPassportCid`），主通道 GBK HTML 列表页、备通道 `__output=11` JSON
- Cookie 托管新增 `nga` 站点（`.nga.cn`），且 NGA 不需要 VPS 无头执行器即可进入调度；运维台的 Cookie 卡片由 3 张扩到 4 张
- 新增默认源 `nga-deals` → **fid=570 优惠信息购物指南**（国内羊毛/优惠主版块），间隔 600s
- 用免登录的 `nuke.php?__lib=view_privilege` 枚举出 NGA 版块地图：570 挂在「杂谈 > 消费电子 IT新闻 (436)」下，同父版块还有 498 二手交易、613 分享活动买家互助（拼车）；据此新增 `nga-carpool`（613，`carpool`）与 `nga-trade`（498，`trade`）两个源，采集器支持 `categoryHint` 透传
- 水区 `-7 网事杂谈` 不接入：福利帖占比低、需注册用户且只看 144 小时内新帖，噪声与配额不划算
- 新增 `bili` 采集器 + 源 `bili-freebies`：B 站关键词搜索（`wbi` 签名算法免登录可用，`w_rid` 由 nav 的 img_key/sub_key 按固定 MIXIN 表重排后 md5），主通道 `wbi/search/type`、降级 `search/all/v2`；实测 4 关键词一轮入库 44 条（freebie 40 / deal 4）
- B 站过滤策略：标题白名单（免费/白嫖/喜加一/限免/兑换码…）只看**标题**不看简介（否则「全12集」影视剧集会混入），排除词看标题+简介；同批次相似标题合并要求「跨 UP + Jaccard ≥ 0.7」，同 UP 的周报系列（实测相似度仅 0.39-0.47）全部保留
- 新增 `tests/bili.test.ts`（6 例）：wbi 签名格式、条目映射、关键词与排除词过滤、跨 UP 合并与同 UP 保留、legacy 降级、未配置 keywords 报错
- 新增 `weibo` 采集器 + 源 `weibo-freebies`（**默认关闭**）：微博没有可用 RSS（RSSHub 的 weibo 路由公共实例实测全挂：rsshub.app 连不上、rssforever 503、shab.fun 连不上），改走 PC 端 `ajax/statuses/search`（需 `SUB` cookie）与 `ajax/statuses/mymblog`（盯人）
- 微博实测噪声过高：3 关键词 60 条 → 同文案合并后 25 条，但擦边图包（81 分）、手游私服、「白嫖奶茶教程」刷屏、新闻误入占多数；采集器已带白名单/排除词（含擦边与私服词）与同文案指纹合并，源仍默认关闭，建议改用 `uids` 盯博主的模式
- Cookie 托管新增 `weibo` 站点（`.weibo.com`，鉴权字段 `SUB`/`SUBP`/`SCF`），与 NGA 一样不需要 VPS 无头执行器；运维台 Cookie 卡片 4 → 5 张
- NGA 实测打通并修正解析：真实列表页用**单引号**属性（`href='/read.php?tid=…' class='topic'`），置顶/版规帖在 `#toptopics` 里且无 `topic` 类 —— 改为「只取带 `class='topic'` 的锚点」后，570/613/498 分别抓到 36/35/40 条，零噪声置顶帖
- 新增 `tests/weibo.test.ts`（6 例）：条目映射、标题切分兜底、白名单与擦边排除、同文案合并留互动最高、盯人模式与降级原因、未配置 Cookie/关键词报错
- 新增 5 个中文主机圈促销源（RSS 直连、零配置、实测入库 60 条）：VPS精选网 / 老左博客 / VEIDC / VPS 侦探 / 搬瓦工中文网，均落 `vps` 分类 + `deal` 形态
- 实测否决并记录：52pojie 全站 RSS 为破解教程与求资源混排、福利经验区 `fid=66` 未开 RSS；卡饭无福利版块；恩山/远景 JS 反爬；贴吧 403；豆瓣小组 RSS 已停；值得买白菜党 404；酷安/券妈妈/TapTap 为签名或 JS 壳 —— 详见 `docs/data-sources.md` 第 9 节
- 新增 `tests/nga.test.ts`（5 例）：HTML/JSON 双通道解析、Cookie 解析域、调度判定、未配置 Cookie 的明确报错、请求头携带登录态

### 分类口径单一化：主页 / 推送规则 / 数据源运维三处对齐

- 新增 `src/shared/taxonomy.ts` 作为分类（27 小类 + 5 大类分组）、内容形态（kind）、获取方式（obtain）、频道（preset）的唯一定义源，服务端与前端共同 import
- 消除 5 处重复清单：enrich 关键词规则、推送白名单校验、AI 提示词、前端 label 表、数据源运维下拉；以后加分类只改一个文件
- 修掉 AI 提示词里两份硬编码的「分类 category 只能是」，且旧的那份缺 `pan` / `course`，导致网盘、网课类内容被 AI 判成其它分类
- 推送规则：分类白名单按大类分组展示，并支持一键套用主页频道（真福利 / 全部白嫖 / 网盘网课 / 好价 / 开源 / 重要新闻 / 行业资讯）；多频道路由编辑器同步
- 数据源运维：分类下拉从 13 项补全到 26 项并按大类分组，RSS 源支持多 feed 逐条编辑（地址 / 条数 / 分类 / 用途 / 标题关键词），源列表新增「分类口径」列
- 新增 `GET /api/taxonomy` 供前端与第三方客户端渲染；`POST/PATCH /api/sources` 校验 `kindHint` / `categoryHint`，非法值直接 400，不再静默忽略
- 新增分类 `offline`（实地福利）：线下门店 / 快闪 / 商场现场领取的实物福利，从「实物/优惠」里拆出来；关键词规则带新闻排除（记者/直播/发布会等），Schema v27 迁移历史条目
- 「实地福利」独立成主页频道，不再混进真福利；频道定义新增 `exclude`，真福利同时排除网盘 / 网课 / 实地福利，主页查询与分类胶囊都按同一份设置算
- 主页快捷分类胶囊只挂真的有内容的分类（外加已选中的），数量上限 8 → 10，不再出现点了没结果的 0 条分类

## 2026-11-14

### 多兴趣频道、21 类目录与品牌升级（「资源雷达」）

- 引入 `kind`（`freebie` / `deal` / `opensource` / `info` / `noise`）与 `ai_quality`（Schema v15–v17），解耦低噪内容与必须免费白嫖
- 默认首页「真福利精选」严格锁定 AI 验真 `freebie`（`free` + `conditional`），并列开放「黑五/好价」「开源项目」「新闻资讯」频道
- 领域分类从 11 类扩至 21 类：新增 `vps`、`carpool`（拼车/合租）、`trade`（二手/出鸡）、`design`、`dev`、`security`、`hardware`、`headline`（时政/要闻）、`finance`（财经/商业）、`news`
- `/api/stats` 支持按当前频道过滤实时计数，前端按频道显示专属下级分类集合，切换频道自动清理不兼容筛选项
- 新增「重整分类 (0 Token)」接口与按钮，零 AI 成本将历史 `other` 存量条目按最新规则归位

### 图文卡片布局、多路由推送与统一屏蔽词

- 新增「紧凑列表 / 2列卡片 / 3列卡片」三种布局，10 路采集器零额外请求提取封面图（`image_url`）
- 推送引擎支持可视化多专题路由编辑器与攒批/预览路由标签，默认白嫖推送保持 `kinds=['freebie']`
- 将 AI 入口自定义噪音词合并入全局 `block_rules`，采集与补审送 AI 前自动跳过命中条目省额度

## 2026-11-12

### 获取方式分级（obtain）

- 新增独立于价格的 `obtain` 维度：`free` / `conditional` / `lottery` / `trial` / `promo` / `paid`
- 抽奖、试用、推广、需付费从「真福利精选」「完全白嫖」和 Telegram 推送中隔离出去
- AI 提示词加入 obtain 判定，并用关键词规则兜底旧数据
- 左栏新增「获取方式」筛选，条目加彩色徽章
- 修复 `unexpired` 只看 `expires_at` 导致无截止时间的老帖长期混入真福利（改为发布时间保鲜期 + 截止时间双条件）
- 修复 `priceAllowed` 让 `is_free=1` 盖过 AI 的 `paid` 判定
- 性能：拆开 `OR` + `COALESCE` 复合条件并加表达式索引 `idx_items_effective_time`，列表从 8-13 秒回到 1-2 秒

### AI 引擎页

- 端点、模型、Key、每轮送审上限、自定义提示词全部可在网页修改，改完立即生效
- 新增连通性测试（固定 3 条样本）与历史补审
- 判定分布与最近判定样本可视化
- 提示词收紧：软件版本发布、开源项目介绍、技术教程、评测对比明确判为非福利

### 数据源

- 关闭 `v2ex-promotions`：该节点 24 条里 9 条被判福利，实际全是代理/IP/中转服务商的引流帖

### 工程化

- 清理 66 个一次性探针脚本与 18 张过期截图
- 诊断能力收敛进 `cli.ts diagnose` / `cli.ts obtain`
- 补齐 README、LICENSE、CI

## 2026-11-11

- 源数量扩到 57，新增 CheapShark、IsThereAnyDeal、GG.deals、Bluesky 游戏大号、TG 频道等
- UI 重构为六个标签页，新增屏蔽词防火墙与数据源运维面板
- 推送重建为三层分流（立即单发 / 攒批 / 只入库），加入静默时段时区修正与跨源标题去重
- 接入 AI 二审，历史全量回审：1979 条里 1672 条判定并非福利

## 2026-11-10

- 时效性优化：分源采集间隔（热门源 90 秒）、采集后即时推送、兑换码提取、正文快照
- 新增「我能付多少」价格上限筛选

## 2026-11-09

- 首个可用版本：SQLite 去重、Web 站、Docker 部署
- 接入知乎 / 小红书 / 小黑盒的本机登录态采集与回传接口
