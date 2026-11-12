# Cloudflare AI Translator

基于 Cloudflare Workers AI 的自托管翻译 API，兼容[沉浸式翻译自定义接口](https://immersivetranslate.com/docs/services/custom/)。默认使用 `@cf/qwen/qwen3-30b-a3b-fp8`，关闭思考模式，验证结构化响应与网页占位符。

本仓库提供代码，不提供公共翻译服务。请部署到你自己的 Cloudflare 账户。

## 功能

- `text_list` 批量翻译，自动识别源语言，按输入顺序返回。
- 保留 `{0}`、`{1}` 和 `<b0></b0>` 等占位符；损坏的占位符返回 502。
- 每批 1–5 段，每段最多 2,000 个 Unicode 字符，总计最多 6,000；请求体最多 32 KiB，context 最多 500 字符。
- 每 IP 300 次/60 秒；Cloudflare 按节点近似执行，非全网严格计数。
- 账户当天已上报用量达到 9,500 Neurons 后停止新推理。
- D1 共享统计缓存和并发刷新租约，每分钟 Cron 同步。
- 客户端无需密钥，允许 CORS `*`，无登录、无会话。访问控制需自行添加。
- 保留旧 `text` 数组和表单重复 `text` 参数兼容。

## 部署

需要 Node.js 24+、npm 和自己的 Cloudflare 账户。部署依赖 Workers AI、D1 和 Rate Limiting binding。使用前核对所在账户的服务可用性与当前价格。

```bash
git clone https://github.com/xushibo/cloudflare-ai-translator.git
cd cloudflare-ai-translator
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create translator-budget
```

编辑 `wrangler.jsonc`（示例中的全零值是占位符，不能用于真实部署）：

| 配置 | 如何填写 |
| --- | --- |
| `name` | 自己的 Worker 名称；同一账号不能与已有服务重名 |
| `vars.CF_ACCOUNT_ID` | `whoami` 显示的账号 ID |
| `d1_databases[0].database_id` | 创建 D1 后返回的数据库 ID |
| `d1_databases[0].database_name` | 与实际数据库名称一致 |
| `vars.API_BASE_PATH` | 默认空字符串，入口为 `/translate`、`/languages`；填 `/api` 则为 `/api/translate`、`/api/languages`。不带末尾斜线 |
| `vars.DAILY_NEURON_BUDGET` | 1–9500 的整数；默认 9500 |
| `ratelimits[0].namespace_id` | 账户内为此限速器选择的数值字符串；多个应用需要独立限速时使用不同 ID |

多账号用户可在配置顶层加 `account_id`，与 `CF_ACCOUNT_ID` 保持一致。默认通过 workers.dev 访问，不绑定任何个人域名。

在 Cloudflare 创建一个 **Account Analytics Read** Token，仅限部署账户。设置 Worker Secret，按隐藏提示输入 Token：

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN
```

首次执行时 Wrangler 可能提示创建一个占位 Worker；确认目标名称后继续。不要将 Token 写入命令参数、源码、`vars` 或 Git。

```bash
npx wrangler d1 migrations apply translator-budget --remote
npm run typegen
npm run typecheck
npm test
npm run deploy:check
npm run deploy
```

若你修改了数据库名，迁移命令也要使用新名称。部署输出会给出实际 workers.dev URL。Token 权限或账户填写不正确时，非空翻译会返回 503。

可选自定义域名：在 Workers 控制台为该 Worker 添加 Custom Domain，或在配置中增加：

```json
"routes": [{ "pattern": "translate.example.com", "custom_domain": true }]
```

该域名的 Zone 需位于部署账户。修改配置后重新部署；若只允许自定义域名访问，可同时将 `workers_dev` 设为 `false`。

## 调用与沉浸式翻译

将下面示例域名换成部署后得到的地址：

```bash
curl 'https://translate.example.com/translate' \
  -H 'Content-Type: application/json' \
  --data '{"text_list":["Hello, world!"],"source_lang":"auto","target_lang":"zh-CN"}'
```

```json
{"translations":[{"detected_source_lang":"en","text":"你好，世界！"}]}
```

沉浸式翻译中选择「自定义 API」（非 DeepL），填完整的翻译 URL，不填写密钥或 Authorization。如果设置了 `API_BASE_PATH`，记得包含该路径前缀。

| 字段 | 说明 |
| --- | --- |
| `text_list` | 必填，1–5 个字符串；空白文本原样返回，不调用 AI |
| `target_lang` | 必填，例如 `zh-CN`、`zh-TW`、`en`、`ja`；不可为 auto |
| `source_lang` | 可选，省略或 auto 时自动检测 |
| `context` | 可选，最多 500 字符的背景，不作为指令执行 |

`GET /languages` 返回支持的语言代码；接受代码不代表模型在所有语言上的质量一致。旧 `text` 协议返回 `detected_source_language`，新协议返回 `detected_source_lang`；不能同时使用两种文本字段。

错误码：400 参数错误；405 方法错误；413 超长；415 Content-Type 错误；429 限速（Retry-After: 60）；456 当日用量达到阈值；503 统计、数据库或配置不可用；502 模型响应错误、截断或占位符损坏。根路径返回 404；公网 HTTP 跳转 HTTPS，本地 HTTP 可直接调试。

## 用量保护与费用

Cloudflare 的免费 AI 配额当前为账户共享的 10,000 Neurons/天，UTC 00:00（北京时间 08:00）重置，其他应用也消耗同一配额。具体以[官方价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)及账户套餐为准；付费套餐超额可能收费。

用量保护查询官方 GraphQL `aiInferenceAdaptiveGroups.sum.totalNeurons`，不按最大输出 token 预扣。普通请求使用最多 60 秒的 D1 快照；每分钟 Cron 允许提前 5 秒刷新。统计失败后退避 15 秒，拒绝使用失败或过期的低用量记录，不把错误视为零。当天记录只增不减，达到阈值后持续拦截到下一 UTC 日。每条非空文本推理前都检查，批次中途达到限额会返回错误，已经发生的推理仍会消耗额度。

这是**延迟统计软限额**：上报延迟、缓存、在途推理和其他应用都可能造成超出 9500，不能保证零费用。Cron 不调用 AI，但会消耗 Workers、D1 与管理 API 用量。`daily_budget` 为历史表，不参与现行拦截；`ai_daily_usage` 保存统计和固定错误分类。不要删除旧迁移文件。

## 本地开发与测试

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入自己的只读统计 Token
npx wrangler d1 migrations apply translator-budget --local
npm run typegen
npm run dev
```

本地 AI binding 连接远端，真实翻译会消耗自己账户额度。默认本地入口是 `http://localhost:8787/translate`。

```bash
npm run typegen
npm run typecheck
npm test
npm run deploy:check
```

自动化测试不需要登录、不使用真实 Token、不调用真实 AI。覆盖协议、语言代码、占位符、限速、SQL 租约、并发合并、跨日、阈值、失败关闭，以及真实 workerd Request/D1 接口。GitHub Actions 执行相同检查，不执行自动部署，不需要仓库 Secrets。

## 隐私与许可

应用不在日志或数据库记录翻译原文/译文；内容仍会发往 Cloudflare Workers AI，遵守其服务及数据政策。LLM 翻译不保证完全准确或抵抗所有提示注入。不支持任意文档翻译、术语表或完整 HTML/XML 解析。

项目代码采用 [MIT](LICENSE)。Cloudflare 服务、模型权重和第三方依赖保留各自条款；MIT 不赋予这些服务或模型额外权利。贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全报告见 [SECURITY.md](SECURITY.md)。

官方参考：[API Token 权限](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)、[Workers 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[模型说明](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)。
