# 公开站：登录、个人隔离、个人 Bot 与 RSS

本文只讲「把资源雷达当公开站运营」这一层。单人自建不需要看，行为与以前完全一致。

## 1. 两种站点形态

| `SITE_MODE` | 适用场景 | 收藏 / 已读 / 屏蔽 / 关注词 | 管理区 |
| --- | --- | --- | --- |
| `selfhost` | 自己一个人用、内网用 | 全局（`items.starred`、`block_rules`、`subscriptions`） | 非生产未设 `ADMIN_TOKEN` 时开放；生产锁定 |
| `public` | 给一群人用 | 按登录用户隔离（`user_*` 表）；未登录访客只存浏览器 | **只认 `ADMIN_TOKEN`**，没配就锁死 |
| `auto`（默认） | 懒人模式 | 配齐 LINUX DO 或 GitHub 的 OAuth 凭据 → `public`，否则 `selfhost` | 同上 |

> 关键点：**LINUX DO 登录永远不构成管理权限**。管理员身份只来自 `.env` 里的 `ADMIN_TOKEN`，与 OAuth 完全正交。

## 2. 最小上线配置

```env
SITE_MODE=public
ADMIN_TOKEN=<换成一串足够长的随机密码>

# 在 https://connect.linux.do 申请，回调地址填 https://<你的域名>/api/auth/linuxdo/callback
LINUXDO_CLIENT_ID=
LINUXDO_CLIENT_SECRET=
PUBLIC_BASE_URL=https://<你的域名>

# 不填也行：首次启动自动生成并写入 settings 表，重启后 Session 与已加密的 Bot Token 不会失效
SESSION_SECRET=
```

启动后在「管理区 → 访问与公告」里设：

- **登录入口**：开 / 关
- **注册模式**：开放注册 / 邀请码注册（默认）/ 停止新注册
- **最低信任等级**：0–4，低于门槛的 LINUX DO 账号会被挡在登录页
- **关闭登录时是否同步暂停个人端**：维护模式用

> 公开站默认是「邀请码注册」而不是「开放注册」——AI 一审和个人 Bot 推送都要花服务器出口，先控量更稳。

## 3. 邀请码

- 生成：`管理区 → 访问与公告 → 生成邀请码`，可设次数（1–10000）、备注、有效期天数，也能指定自定义码（`^[A-Z0-9-]{4,32}$`）
- 核销是原子的：`BEGIN IMMEDIATE` 拿写锁 + 条件 `UPDATE ... WHERE used_count < max_uses`，靠 `changes === 1` 判定成功，并发不会超发
- 两种用法：
  1. 登录前在弹窗里填码 → 授权回调时直接核销建号
  2. 直接登录 → 回调发现是新用户且没带码 → 跳回前端补码（10 分钟签名凭证，过期需重新登录）
- 老用户永远免码；`停止新注册` 只拦新用户

## 4. 个人状态隔离是怎么做的

- 公开站下 `/api/items`、`/api/stats`、条目详情、日报都会按当前登录用户的 `user_item_states` 过滤
- 过滤条件写成自包含的 `EXISTS (SELECT 1 FROM user_item_states uis WHERE uis.user_id = ? AND uis.item_id = items.id ...)`，因为 `merge=1` 时的窗口函数子查询只查 `items` 单表，拿不到外层 JOIN 别名
- 未登录访客：`PATCH /api/items/:id` 一律 401，前端改成本地 `localStorage`（`radar_guest_state_v1`），并在顶栏显示「本机偏好」计数；登录后可以一键合并到账号
- 数据保留策略删除条目时会排除「被任意登录用户收藏」的条目

## 5. 个人 Telegram Bot

用户侧（`我的` 页签）：

1. 在 @BotFather 建 Bot，拿 Token
2. 粘贴 Token → 保存（服务端 AES-256-GCM 加密，接口只回打码值 `123456:AA***9xyz`）
3. 给自己的 Bot 发一句 `/start`，点「探测 Chat ID」自动回填
4. 发测试消息 → 调阈值 → 试算 → 开开关

服务端行为：

- 与全局推送共用过滤/攒批/免打扰引擎，但**去重、限流、日志都按 `user_id` 独立**（`user_push_deliveries` / `user_push_logs`）
- 去重只用标题聚类 + `canonical_id`，不会按用户数重复调付费 LLM
- 个人上限受 `USER_PUSH_MAX_PER_HOUR` / `USER_PUSH_MAX_PER_INSTANT` 夹紧
- 连续 3 次 `401/403/chat not found` 自动停用该用户的推送并记录 `last_error`
- **全局没配 `TELEGRAM_BOT_TOKEN` 也能跑**：只要有人开了个人推送，采集后仍会走「AI 一审 → 派发」，后台补审通过后也会二次派发
- Bot Token 的 `apiBase` / 代理固定用服务端配置，不接受用户填写任意 URL（防 SSRF）

## 6. RSS

| 地址 | 说明 |
| --- | --- |
| `/rss.xml` | 公开源，支持 `preset` `kind` `category` `excludeCategory` `source` `obtain` `minScore` `freeOnly` `hasCodes` `lang` `search` `limit` |
| `/api/rss` | 同上，别名 |
| `/rss/u/<token>.xml` | 个人源：自动排除你关掉的条目 + 你的个人屏蔽词 |
| `/rss/u/<token>.xml?mode=push` | 完全按你的个人推送规则过滤 |
| `/rss/u/<token>.xml?mode=subs` | 只输出命中你关注关键词的条目 |

- 响应带 `ETag`，命中返回 `304`；个人源为 `private, no-store`，不能作为公共 CDN 缓存
- 描述用 CDATA 包纯文本（不是 HTML），阅读器不会把正文里的 `<` 当标签
- 个人链接本身就是凭据，泄露了就到「我的」里重置 Token

## 7. 入站提示

`settings.onboarding` 存标题、正文、引导卡片开关与版本号：

- 前端按 `radar_onboarding_seen_v<version>` 记一次
- 站长点「保存并重新弹出」时版本号 +1，所有访客下次进站会重新看到
- 引导卡片按站点形态动态显示（访客隔离 / 登录与个人 Bot / RSS）

## 8. 版本检测与一键更新

`管理区 → 版本与更新`：

| 环境 | 判定 | 能做什么 |
| --- | --- | --- |
| `git` | 仓库里有 `.git` 且 `git` 可用 | 真一键：脏工作区拒绝 → `VACUUM INTO` 备份 DB → `git pull --ff-only` → `pnpm install --frozen-lockfile` → `pnpm build` → 重启 |
| `docker-webhook` | 容器内无 `.git`，但配了 `UPDATE_WEBHOOK_URL` | POST 到宿主机脚本触发重建 |
| `docker-readonly` | 标准容器 | 只看变更 + 复制宿主机命令，**不会假装能自更新** |

- 重启方式：配了 `SELF_UPDATE_RESTART_CMD` 就执行它，否则进程自行退出，交给 systemd / pm2 / `docker restart` 拉起
- `/health` 返回 `commit`，前端轮询它判断新版本是否真的起来了
- 备份保留最近 3 份，在 `data/backups/`

## 9. 本地验证多账号隔离

```env
SITE_MODE=public
NODE_ENV=development
AUTH_DEV_MOCK=true      # 还必须通过 localhost/127.0.0.1 访问
ADMIN_TOKEN=test-admin-secret
```

打开站点 → 顶栏「LINUX DO 登录」→ 底部出现「账号 A / 账号 B」两个按钮：

1. 用 A 登录，关掉几条、收藏几条
2. 退出，用 B 登录 → B 完全看不到 A 的操作
3. 各自在「我的」里绑不同的 Bot，验证互不串台

> `AUTH_DEV_MOCK` 上线前务必关掉。

## 10. 常见问题

**Q：公开站没配 `ADMIN_TOKEN` 会怎样？**
管理写接口直接返回 `403`（`adminLocked`），前端管理区显示「已锁定」。这是刻意设计：公开站不能让任何登录用户顺手改全站配置。

**Q：能不能让某个 LINUX DO 账号当管理员？**
不能，也不打算加。管理权限只认 `ADMIN_TOKEN`；需要多人管理就共享密码，或者自己在前面加一层反向代理鉴权。

**Q：用户 A 把条目「关掉」了，别人会看不到吗？**
不会。公开站下 A 的关闭只写 `user_item_states.hidden`，只影响 A 自己的列表、统计、个人 RSS 与个人推送。

**Q：个人 Bot 推送会不会把 AI 额度烧光？**
不会。AI 一审是全局共用的（一条内容只审一次），个人推送只做规则过滤与标题聚类去重。

## 11. 多登录渠道、名额上限与 Webhook

### GitHub 登录

与 LINUX DO 并存，两个按钮都在登录弹窗里。配置：

```bash
GITHUB_CLIENT_ID=Ov23xxx
GITHUB_CLIENT_SECRET=xxx
# 留空则用 PUBLIC_BASE_URL + /api/auth/github/callback 推导
GITHUB_REDIRECT_URI=https://radar.example.com/api/auth/github/callback
```

GitHub OAuth App 里的 Redirect URI 必须与上面**逐字符一致**（末尾别加斜杠）。差异点：

- GitHub 没有 `trust_level`，所以「最低信任等级」这道门槛对它不生效（按 0 处理）
- 内部用负数 id 做命名空间，两个渠道的用户 id 不会撞车
- 邀请码、名额上限、登录开关、封禁对两个渠道一视同仁

### 注册名额上限

后台「访问控制 → 注册名额上限」，`0` 表示不限。满了之后：

- 新用户注册被拒（回调跳 `/#quota-full`，接口返回「站点名额已满（x/y）」）
- **老用户照常登录**，不受影响

### Webhook 推送（含 QQ）

个人中心 → 推送渠道选 `Webhook`，填地址即可，不需要 Bot Token。请求体：

```json
{ "source": "freebie-radar", "text": "推送正文", "sentAt": "2026-11-15T14:02:09.494Z" }
```

带 `X-Radar-Secret` 头（填了校验密钥时）。可直接对接 Bark、飞书、钉钉、Slack、自建服务。

**QQ 为什么不用官方 Bot**：QQ 官方机器人只有被动回复（必须带 `msg_id`，同一条最多回 5 条），没有主动推送通道，定时推福利做不到。可行路径是 NapCat / Lagrange 这类 OneBot 实现，它们暴露 HTTP 接口，填成 webhook 地址即可。
