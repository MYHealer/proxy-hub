# proxy-hub 部署与使用手册（AI 可执行版）

本手册面向 **AI 部署代理或熟悉命令行的工程师**，将 `proxy-hub` 从零部署到可用，并完成功能验证。每一步都给出**可复制的命令**与**可验证的输出/检查点**，遇到失败时按下文【排障】处理。

> 约定：`$` 表示执行的命令，`→` 表示期望的输出或检查点。平台占位符 `<PLATFORM>` 指 `codebuddy` / `traecn` / `qoder`。

---

## 1. 前置检查

| 项 | 要求 | 检查命令 |
|----|------|---------|
| Node.js | >= 18（支持 `node:test` / `node:http` / `node:https` / `node:crypto` / `node:child_process`） | `node -v` |
| npm | 可选，仅用于 `npm test` | `npm -v` |
| 网络 | 能访问 GitHub（克隆用），及目标平台上游（运行时） | `git ls-remote https://github.com/1416277987/proxy-hub.git` |

```bash
node -v
# → v18.x.x 或更高
```

## 2. 获取代码

```bash
git clone https://github.com/1416277987/proxy-hub.git
cd proxy-hub
```

检查点（克隆后应看到）：

```bash
ls
# → adapters/  config.js  credentials.js  docs/  index.js  package.json  registry.js  sse.js  usage.js  test/  README.md
```

## 3. 安装依赖

纯 Node.js 实现、零 npm 依赖，**无需 `npm install`**：

```bash
# 无需安装任何第三方包
npm test   # 可选，跑单元测试（不依赖平台登录凭据，任意环境可跑通）
# → # tests 33 / 33 passed（或类似通过提示）
```

## 4. 启动服务

默认监听 `127.0.0.1:8787`：

```bash
node index.js
# → proxy-hub listening on http://127.0.0.1:8787
```

后台运行（如需常驻）：

```bash
nohup node index.js > proxy-hub.log 2>&1 &
```

## 5. 基础验证（无需平台账号）

另开一个终端，按顺序验证以下端点：

```bash
curl -s http://127.0.0.1:8787/health
# → {"status":"ok"}

curl -s http://127.0.0.1:8787/v1/models
# → {"object":"list","data":[...]}  列出各平台可用模型
```

## 6. 配置平台账号（按需启用）

服务会读取本机的平台登录凭据。**只在准备使用某个平台的机器上操作**，未配置的平台会自动标记为 `ready:false`，不影响其他平台。

| 平台 | 配置方式 |
|------|---------|
| CodeBuddy / WorkBuddy | 无需配置，在 WorkBuddy 桌面端登录即可；适配器自动读取 `CodeBuddyExtension/Data/Public/auth/*.info` |
| Trae CN | 无需配置，在 Trae CN IDE 登录即可；适配器自动解密 `%APPDATA%/Trae CN/User/globalStorage/storage.json` 中的 `iCubeAuthInfo` |
| TraeWork（桌面版） | 无需配置，在 TraeWork 桌面端登录即可；适配器自动解密 `%APPDATA%/TRAE SOLO CN/User/globalStorage/storage.json` 中的 `iCubeAuthInfo`（与 Trae CN 同一套 tc 算法，chat 走 `solo_work_lite`） |
| Qoder | 二选一：① `qoderclicn login` 完成 OAuth（落盘 `~/.qoderworkcn/.auth-cn/user`）；② 设置环境变量 `QODERCN_PERSONAL_ACCESS_TOKEN=<PAT>` |

查看各平台就绪状态：

```bash
curl -s http://127.0.0.1:8787/status
# → {"adapters":[{"id":"codebuddy","ready":true/false,...},{"id":"traecn",...},{"id":"traework",...},{"id":"qoder",...}]}
# ready:true 表示该平台本机凭据就绪
```

## 7. 配置代理密钥（可选，用于公网/多客户端场景）

默认无鉴权、仅本机可访问。若需暴露到局域网或公网，设置 `PROXY_HUB_KEY`：

```bash
PROXY_HUB_KEY=your-secret node index.js   # macOS / Linux (bash/sh)
$env:PROXY_HUB_KEY="your-secret"; node index.js   # Windows PowerShell
set PROXY_HUB_KEY=your-secret && node index.js     # Windows CMD
```

客户端请求须带：

```bash
curl -s -H "Authorization: Bearer your-secret" http://127.0.0.1:8787/v1/models
```

## 8. 客户端接入（OpenAI 兼容）

任何支持自定义 `base_url` 的 OpenAI 客户端（Cherry Studio、Open WebUI、Cursor、Cline 等）均可使用。

- **Base URL**：`http://127.0.0.1:8787/v1`
- **API Key**：未设 `PROXY_HUB_KEY` 时任意值/留空；设置后填对应 key
- **模型 ID**：格式 `{平台}-{模型}`，不含斜杠。例如：

```
codebuddy-deepseek-v4-pro
traecn-glm-5.2
qoder-qwen3.7-max
```

### curl 直测对话（非流式）

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<PLATFORM>-<模型>","messages":[{"role":"user","content":"你好"}]}'
# → {"id":"...","choices":[{"message":{"content":"..."},...}]}
```

### curl 直测对话（流式 SSE）

```bash
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"<PLATFORM>-<模型>","stream":true,"messages":[{"role":"user","content":"你好"}]}'
# → 逐段返回 data: {...} 的 SSE 文本
```

## 9. 用量统计

```bash
curl -s http://127.0.0.1:8787/usage
# → {"byAdapter":{...},"byDay":[...]}  按平台/模型/日期累计请求数与 token
```

## 10. 配置项速查

优先级：环境变量 > `config.json` > 默认值。

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `PROXY_HUB_PORT` | `8787` | 监听端口 |
| `PROXY_HUB_KEY` | 空 | 客户端需带 `Authorization: Bearer <key>` |
| `PROXY_HUB_TIMEOUT` | `120000` | 上游超时（ms） |
| `PROXY_ADAPTER_CODEBUDDY` / `TRAECN` / `TRAEWORK` / `QODER` | `true` | 是否启用对应适配器 |
| `QODERCN_CLI` | `qoderclicn` | Qoder CLI 命令名 |
| `QODERCN_PERSONAL_ACCESS_TOKEN` | 空 | Qoder PAT（未用 CLI 登录时） |

也可用项目根目录 `config.json` 覆盖（文件优先级最高）。

## 11. 排障

| 症状 | 检查点 / 处理 |
|------|--------------|
| `GET /status` 某平台 `ready:false` | 确认该平台本机已登录；Qoder 需 `qoderclicn login` 或设 PAT；traecn/traework 需在本机对应桌面端登录过 |
| 对话返回 401 `Adapter xxx auth failed` | 平台凭据缺失/过期，重新登录对应客户端 |
| 对话返回 404 `Unknown model` | 模型 ID 格式错误，用 `GET /v1/models` 查看可用 ID |
| 对话返回 502 `Upstream failed` | 上游超时或网络异常，结合 `PROXY_HUB_TIMEOUT` 与日志排查 |
| 返回 401 `missing or bad proxy key` | 已设 `PROXY_HUB_KEY` 但请求未带正确 Bearer |
| `node index.js` 端口冲突 | 换端口：`PROXY_HUB_PORT=9000 node index.js` |
| Cursor / Cline 连不上 | 确认 base_url 是否带 `/v1`，模型 ID 是否用 `{平台}-{模型}` 连字符格式 |

## 12. 生产建议（可选）

- 反向代理 TLS：让 Nginx/Caddy 终结 HTTPS，转发到 `127.0.0.1:8787`。
- 进程守护：用 `systemd` / `pm2` / supervisor 常驻并自动拉起。
- 鉴权：公网场景务必设置 `PROXY_HUB_KEY`，并限制来源 IP。
- 日志：重定向输出到文件并轮转。

---

部署完成。若某个检查点未达标，请将对应命令的输出与【排障】表对照后重试。
