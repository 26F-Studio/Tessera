# Tessera

[English](README.md) | **简体中文**

面向 Techmino 与 Techmino Galaxy 的第一方账号与产品会话服务。本服务**不是 OAuth/OIDC 提供方**。账号凭据、邮箱验证/找回以及浏览器会话由 Better Auth 负责；Tessera 负责独立的产品/设备授权与不透明产品访问凭据。

## 环境要求与启动

- Bun 1.4.2；依赖版本锁定在 `bun.lock`。
- PostgreSQL 18，或经过兼容性验证的部署。
- 真实的 SMTP 服务。生产环境要求经过验证的 TLS；本地 Mailpit 只是测试夹具，不代表已具备邮件投递能力。
- 同源 HTTPS 反向代理，用于提供账号网站、`/api/auth/*` 与 `/v1/*`。服务只应绑定到内部网络或回环地址。

将 `.env.example` 复制为受保护且被忽略的环境文件。生成互不相同的账号密钥与资源密钥，绝不提交到仓库。通过 `MIGRATION_DATABASE_URL` 使用拥有 schema 的迁移角色，通过 `DATABASE_URL` 使用另一个仅具 DML 权限的运行时角色。

```sh
bun install --frozen-lockfile
bun run migrate
bun run typecheck
bun run start
```

启动时会拒绝具有 PostgreSQL 超级用户/createdb/createrole 权限的角色。迁移命令先调用 Better Auth 真实的迁移 API，再按顺序执行本服务自有的产品/资料迁移与授权重置（authorization-reset）迁移。运行时要求 schema 版本为 2，且绝不执行 DDL。请为运行时角色授予实际应用表上的 SELECT/INSERT/UPDATE/DELETE，以及自有 schema/序列上的 USAGE；该角色不得拥有数据库。Cadence 必须使用不同的数据库与角色，且不能读取 Tessera 的凭据或会话。

`GET /health/live` 报告进程存活状态。`GET /health/ready` 执行一次真实的数据库查询。SIGTERM/SIGINT 会停止新操作的受理、关闭监听器与连接池，并且不把凭据写入日志。

## 账号与产品边界

账号 API：`/api/auth/*`，包含强制的邮箱验证、密码与邮箱 OTP 登录、找回、邮箱/密码修改以及浏览器会话管理。密码长度为 8–128 个字符，且绝不由浏览器预哈希。仅暴露受支持的账号端点；社交/OAuth/管理员插件端点不会被隐式启用。

注册流程从不透露某个邮箱是否已注册。对未验证邮箱重复注册时，会丢弃本次提交的密码，并发送一封一次性的“完成创建账号”设置密码链接；完成该重置即验证账号，并替换先前注册者设置的任何密码。对已验证邮箱重复注册时不发送任何邮件。

公开资料仅暴露身份/name/motto/region 以及经过校验的头像。私有账号资料数据需要账号浏览器会话。头像上传接受有大小限制的 PNG/JPEG/WebP，会将其解码、拒绝动图与超限尺寸，并在对外提供前重新编码为 PNG。上传上限为 256 KiB 与 512×512 像素。

产品授权由 `POST /v1/authorization/requests` 发起，由账号网站批准或拒绝。S256 PKCE、已注册的回调/产品/state、请求与 code 的过期时间，以及原子化的单次交换共同约束这次交接。不存在内嵌的原生密钥，也不存在账号令牌与游戏令牌的拼接。访问令牌是随机的不透明凭据，300 秒后过期，且只标识一个独立授权/产品。

原生刷新凭据在成功使用后轮换，并在 30 天后过期，不做滑动续期。对紧邻的前一个刷新凭据进行重放会吊销该设备授权；未知/更早的凭据无法续期。每个产品允许每位用户最多五个活跃设备授权。访问凭据签发在每个授权下最多保留 32 个存活凭据，从而提前续期不会使尚未切换凭据的、仍被许可的 socket 失效。

Web 使用独立的、稳定的 HttpOnly 产品会话 Cookie，作用域限定为 `/v1/products/<id>/session`，而不是 JavaScript 可读的刷新令牌。这避免了游戏/网站/标签页在合法场景下的刷新竞态。产品访问凭据仅保留在内存中。不要将账号 Cookie 或产品刷新 Cookie 转发给 Cadence；请在游戏反向代理边界使用独立的主机级（host-only）Cookie 或剥离 Cookie。

| 操作 | 效果 |
| --- | --- |
| 浏览器登出 | 浏览器会话结束；独立的游戏授权继续保留 |
| 原生产品登出 | 该设备授权及其所有访问凭据终止 |
| 产品退出 | 所选产品的全部本人授权终止 |
| 账号全设备登出 | 所有浏览器会话与所有产品授权终止 |
| 密码重置/修改成功 | 所有产品授权终止；重置还会吊销浏览器会话 |
| 账号停用/禁用 | 拒绝所有产品的登录/签发/刷新/校验；保留资料与游戏数据 |

账号全设备登出为 `/v1/account/logout-all`；Better Auth 仅作用于浏览器的 `revoke-sessions` 有意不作为该操作的别名。停用要求账号会话在十分钟内创建。账号管理员 ID 属于运维方配置，而不是可通过资料写入的权限；房间所有权与 Cadence 游戏管理彼此独立。
全设备登出与密码重置还会隔离（fence）来自此前已创建浏览器会话的延迟授权决定。在重置之后，旧的、仍在途的会话正向结果无法批准新的授权。受控代理 IP 通过显式的 `TRUSTED_PROXY_IPS` 声明；只有这些对端可以提供经过净化的 `X-Real-IP`。账号库（account library）写入的 IP 头会被替换为服务自身的可信值。

邮件投递以 `SMTP_*` 环境变量为默认值。账号管理员可通过 `GET`/`PUT`/`DELETE /v1/admin/mail`（账号页提供面板）覆盖这些设置；写入要求账号会话在十分钟内创建，保存前会先验证 SMTP 登录，并只在 `mail_settings_audit` 中记录变更的字段名，从不记录值。保存的 SMTP 密码与可选的 Brevo API key 使用由 `BETTER_AUTH_SECRET` 派生的密钥做 AES-256-GCM 加密；轮换该密钥后，已保存的设置会被忽略，直到重新保存。配置 Brevo API key（仅授予 Account 读权限）后，Tessera 通过 `GET https://api.brevo.com/v3/account` 读取剩余发送量；当剩余量小于或等于保留值时，在任何账号状态变更之前，以 `429 MAIL_DAILY_LIMIT_REACHED` 拒绝注册、验证、找回密码、更换邮箱与邮箱验证码请求。Brevo 超出每日上限后会把 SMTP 邮件排队而非拒绝，所以这个预检查是唯一的拒绝点。额度查询失败时仍会发送，并记录 `quota-unavailable`。

## Cadence 校验

`POST /v1/internal/authorizations/validate` 接受已配置的资源服务器 Bearer 密钥与 `{productId, accessToken}`。它会检查真实的访问凭据过期时间、授权状态/产品、已验证且启用的账号，以及调用方被允许的产品。有效（active）响应只包含可信的身份/能力信息与 `validatedAt`/`expiresAt`，绝不包含刷新凭据。原生客户端不会获得资源服务器密钥。

资源配额为每个已注册资源密钥每分钟 6,000 次请求；Cadence 仍必须限制并发，并执行其五秒的新鲜度/故障截止期限。这是对当前状态的校验，而不是永久有效的身份断言。

密钥轮换支持新增主密钥，并允许至多五分钟的有界旧密钥重叠期。旧密钥需显式声明 `validUntil`；重叠期已过的密钥无法通过认证。可信的是配置固定的端点，而不是由凭据提供的签发者/密钥 URL。

## 已验证范围

在真实的隔离 PostgreSQL、真实 Mailpit SMTP 收件箱，以及位于经证书验证的本地 HTTPS 代理之后的真实 Elysia 监听器上，实际演练了：注册与邮箱验证、解码后的资料/头像、PKCE 单次交换与账号/产品隔离、原生登出与浏览器登出的相互独立、刷新凭据的重叠/重放、产品退出、覆盖两个产品的全设备登出、密码重置、Web Cookie 的独立性与登出，以及自我禁用。TypeScript 类型检查通过。五个真实的 PostgreSQL 并发/边界测试通过，涵盖一次性交换、proof 绑定、取消/过期、并发原生刷新重放吊销，以及延迟会话的授权隔离。

使用显式的夹具环境运行隔离的数据库/SMTP 集成测试套件：

```sh
TESSERA_INTEGRATION=true bun --env-file=.env.test test test/authorization.integration.test.ts
```

它会拒绝生产或非回环的签发方。其 SMTP 检查需要位于 `http://127.0.0.1:18025` 的真实 Mailpit 夹具；它绝不会通过修改账号表来创建已验证身份。

这些账号侧的实测结果**并不**证明 Cadence 的 WSS 吊销期限、实际游戏行为、负载上限、浏览器渲染/PWA 更新，或任何未执行的平台包。这些需要实施计划中的集成发布验收与真机结果。
