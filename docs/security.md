# 公网部署与安全边界

## 应用默认护栏

- 管理权限只认 `ADMIN_TOKEN`，与 OAuth 用户正交。生产环境没有管理令牌时一律锁定管理区。
- `ADMIN_HOSTS` 可限制管理 API 的 Host，例如 `admin.radar.example.com`；**Host 不是独立鉴权手段**，必须配合反代 Access/VPN 并封闭源站。
- `AUTH_DEV_MOCK` 只有 `NODE_ENV=development`、回环 Host、显式开启三者同时满足才生效。上线设 `false`。
- 请求体上限 2 MB；采集回传每次最多 500 条。API 同时最多处理 16 个请求，HTTP 请求/头超时分别为 30/10 秒。
- 入站每 IP 每分钟：普通读 240、搜索/导出/热点/统计/规则计数/关联/试算查询 30、鉴权读 30、写操作 60。个人测试/探测/立即攒批每用户每分钟最多 2 次。
- 限流不信任客户端转发头。**只有反代覆盖转发头且源站无法直连时**才设 `TRUST_PROXY=true`；多实例部署应在反代使用共享限流。
- 公共匿名 JSON 短缓存，Cookie/Bearer 响应不共享；个人 RSS `private, no-store`。
- Webhook 解析全部 DNS 记录，拒绝本机、内网、保留 IPv4/IPv6，固定实际 socket 地址以避免 DNS rebinding；不跟随重定向。
- 公开站不允许内网 Webhook。单人自建如确需 NapCat 等内网服务，可显式设 `WEBHOOK_ALLOW_PRIVATE=true`，不要用于公开站。
- 个人规则只支持关键词，规则/关注词各最多 100 条。遗留个人正则停用；管理员正则也只接受保守子集。
- Cookie 使用 HttpOnly/SameSite；写请求校验 Origin；网页设置 CSP、禁止嵌入、禁 MIME 猜测、禁 Referer 泄露。

这些护栏不能替代上游 DDoS 防护。公开列表、导出和 RSS 本来允许读取，应按“可被爬取”运营；`robots.txt` 不是安全控制。

## 推荐入口分离

不必拆成两个项目。推荐：

```text
radar.example.com       -> CDN/WAF -> 公开与个人接口
admin.radar.example.com -> Access/VPN -> 管理接口
源站 8788              -> 只允许回环/指定反代访问
```

在 `.env` 设置 `ADMIN_HOSTS=admin.radar.example.com`。公开反代不要暴露管理写路径。旧接口包括 `/api/ai*`、`/api/push*`、数据源写操作、全局规则/订阅、清理和 `/api/admin/*`，不是仅保护 `/api/admin` 即可。

Docker 默认 `BIND_ADDRESS=127.0.0.1`；宿主机 Caddy/Nginx 可继续反代 `127.0.0.1:8788`。反代若也是容器，建议同一私有网络访问 `radar:8788`，移除宿主机端口发布，不要为了连接方便改成公网暴露。

Nginx 限流基础示例（`limit_req_zone` 放在 `http` 段）：

```nginx
limit_req_zone $binary_remote_addr zone=radar_api:10m rate=5r/s;

# 以下放在已配置 TLS 的 server 段，并配合 CDN/WAF。
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
    # 不拼接客户端伪造的 X-Forwarded-For。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 2m;
    proxy_read_timeout 30s;
    limit_req zone=radar_api burst=15 nodelay;
    limit_req_status 429;
}
```

上游如果是 CDN，应只信任其官方 IP 范围，并正确配置 real_ip；否则所有用户会共用 CDN 出口的限额。更严格的管理认证由管理域名的 Access/VPN 完成。

## 密钥、数据与监控

- 使用独立长随机 `ADMIN_TOKEN`/`INGEST_TOKEN`，不要提交或记录明文。
- HTTPS 反代应覆盖 `X-Forwarded-Proto`。源站封口后才可依赖转发头判断 Secure Cookie。
- 未配置加密密钥时仍兼容旧版 settings 内的自动密钥；这只能防接口泄露，**不能保护整份 DB 被盗**。建议将独立加密密钥放在秘密管理系统；现有用户已保存 Token 时不要直接换钥，否则需要重新绑定。
- 权限保护 `.env`、数据库、Cookie 和备份；加密备份，不要开放 `/data`。备份恢复时同时保留对应密钥。
- 监控 401/429、请求量、p95 延迟、CPU/内存、出口流量与推送失败。应用日志对个人 RSS Token 与 OAuth 参数脱敏。
- 本次仓库改动不等于线上反代、防火墙、CDN 已配置；部署后还需验证直接源站不可访问以及管理入口确实被额外认证。

## 本地验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm benchmark
```

基准仅使用 1 万条合成数据、内存数据库和进程内串行请求，不读取现有数据库、不调用 AI/推送，也不代表线上并发容量。
