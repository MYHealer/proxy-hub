# proxy-hub

单进程、多平台 AI 反向代理框架，把本地多个 AI 编程平台的登录凭据/额度统一包装成**单个 OpenAI 兼容服务**，供 Cherry Studio、Open WebUI、Cursor、Cline 等客户端切换使用。

纯 Node.js，零 npm 依赖。

## 环境要求

- Node.js >= 18（需支持 `node:test`、`node:http`、`node:https`、`node:crypto`、`node:child_process`）

## 快速开始

```bash
cd proxy-hub
node index.js
# proxy-hub listening on http://127.0.0.1:8787
```

测试：`npm test`

## 支持的平台

| 平台 | 模型 ID 前缀 | 需要的前提 |
|------|-------------|-----------|
| CodeBuddy / WorkBuddy | `codebuddy-` | 本机登录 WorkBuddy 桌面端（自动读凭据） |
| Trae 国内版（CN） | `traecn-` | 本机登录 Trae CN IDE（自动 tc 解密凭据） |
| TraeWork（桌面版） | `traework-` | 本机登录 TraeWork 桌面端（自动读 %APPDATA%\TRAE SOLO CN） |
| Qoder（CN） | `qoder-` | `qoderclicn login` 一次登录，或设置 `QODERCN_PERSONAL_ACCESS_TOKEN` |

模型 ID 使用连字符（不含斜杠），格式 `{平台}-{模型}`，例如：

```
codebuddy-deepseek-v4-pro
traecn-glm-5.2
traework-glm-5.2
qoder-qwen3.7-max
```

## 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/v1/models` | 可用模型列表 |
| `GET` | `/v1/models/matrix` | 跨平台模型能力矩阵（按模型家族分组合并） |
| `POST` | `/v1/chat/completions` | 对话（OpenAI 协议，流式/非流式） |
| `GET` | `/usage` | 各平台用量统计 |
| `GET` | `/status` | 各适配器就绪状态 |

客户端任意 `base_url` 指向 `http://127.0.0.1:8787/v1`，`model` 填上述 `{平台}-{模型}` 值。

## 配置方式

优先级：环境变量 > `config.json` > 默认值。

| 配置 | 默认 | 说明 |
|------|------|------|
| `PROXY_HUB_PORT` | `8787` | 监听端口 |
| `PROXY_HUB_KEY` | 空 | 若设置，客户端需带 `Authorization: Bearer <key>` |
| `PROXY_HUB_TIMEOUT` | `120000` | 上游超时（ms） |
| `PROXY_ADAPTER_CODEBUDDY` / `TRAECN` / `TRAEWORK` / `QODER` | `true` | 是否启用对应适配器 |
| `QODERCN_CLI` | `qoderclicn` | Qoder CLI 命令名 |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | 空 | Qoder PAT（未用 CLI 登录时） |

## 各平台账号配置

- **CodeBuddy / WorkBuddy**：无需配置。在 WorkBuddy 桌面端登录即可，凭据从 `CodeBuddyExtension/Data/Public/auth/*.info` 自动读取，token 由桌面端自动刷新。
- **Trae CN**：无需配置。在 Trae CN IDE 登录即可，适配器自动解密 `%APPDATA%/Trae CN/User/globalStorage/storage.json` 中的 `iCubeAuthInfo`。
- **TraeWork（桌面版）**：无需配置。在 TraeWork 桌面端登录即可，适配器自动解密 `%APPDATA%/TRAE SOLO CN/User/globalStorage/storage.json` 中的 `iCubeAuthInfo`（与 Trae CN 同一套 tc 算法；chat 走 `solo_work_lite` 轻排队）。token 过期或上游返回 401 时，会用本地 `refreshToken` 调 Trae OAuth `ExchangeToken` 自动换新，无需手动重登。
- **Qoder**：二选一。① 终端执行 `qoderclicn login` 完成 OAuth 登录（落盘到 `~/.qoderworkcn/.auth-cn/user`）；② 或设置环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN=<PAT>`。

可用 `GET /status` 查看每个平台是否就绪、缺失原因。

## 用量统计

`GET /usage` 返回按平台/模型/日期累计的请求数与 token 数。用量来源：优先用上游返回的 `usage` 字段（如 CodeBuddy 上游 `copilot.tencent.com` 会返回真实 token）；上游未返回时（如 Trae CN / TraeWork 的私有事件）由网关按字符长度估算（chars/4），因此 token 精度取决于各上游是否上报 usage，跨平台数字仅供参考、不可直接横向精确比较。

## 模型能力对比

`GET /v1/models/matrix` 按模型家族（如 `glm`、`deepseek`、`kimi`、`qwen`）分组合并各平台，一眼看出同一模型家族在哪些平台可用、各平台的具体版本：

```bash
curl http://127.0.0.1:8787/v1/models/matrix
# → {"families":{"glm":{models:[...],"providers":{codebuddy:[...],"traecn":[...],...}},...}}
```

> 各平台采用订阅/积分制计费，无公开单 token 单价，本接口只做模型能力对比，不含精确价格。

## 验证

```bash
npm test
```

冒烟：先 `node index.js`，再 `curl http://127.0.0.1:8787/status` 查看各平台就绪状态。

> 提示：真实对话验证需要本机有对应平台的登录凭据。单元测试本身不依赖凭据，可在任意环境跑通。

## 设计说明

- 架构：`index.js`（HTTP 入口）→ `registry.js`（模型前缀路由）→ 各 `adapters/*.js`（auth / models / request / stream 四职责）
- 公共组件：`credentials.js`（凭据缓存 TTL+去重）、`sse.js`（统一出口）、`usage.js`（用量统计）
- 遵循 OCP：新增平台只需在 `adapters/` 下加一个文件并接入 `index.js`
- 本README仅为使用说明，完整设计与实现规范见 `docs/superpowers/` 下 spec 与 plan。
