# IPIPAI MCP — IP 情报 & 网络诊断 MCP 服务

> **在线服务：[https://mcp.ipipai.com](https://mcp.ipipai.com) ｜ 主站工具：[ipipai.com](https://ipipai.com)**
>
> 一个基于 MCP（Model Context Protocol）协议的 IP 属性查询与网络诊断服务。任何支持 MCP 的 AI 客户端（Claude、ChatGPT、Cursor、Cline、Gemini 等）都能**自动发现并调用**这里的 16 个工具——无需翻阅 API 文档。

[![MCP Streamable HTTP](https://img.shields.io/badge/MCP-Streamable%20HTTP-blue)](https://mcp.ipipai.com/mcp)
[![JSON-RPC 2.0](https://img.shields.io/badge/JSON--RPC-2.0-green)](https://mcp.ipipai.com/mcp)
[![Live](https://img.shields.io/badge/Live-mcp.ipipai.com-brightgreen)](https://mcp.ipipai.com)

## 为什么用 IPIPAI MCP

- 🛰️ **16 个工具一站式**：IP 属性、WHOIS、DNS、Ping、Traceroute、流媒体解锁、BGP/ASN、LLM 流量识别
- 🔒 **企业级安全**：HTTPS + HSTS、Bearer 鉴权、全套安全响应头、防指纹泄漏
- 🤖 **AI 原生**：遵循 MCP Streamable HTTP + JSON-RPC 2.0，AI 客户端即插即用
- ⚡ **低延迟**：服务部署在 Cloudflare 边缘，全球毫秒级响应

## 快速接入

| 项目 | 值 |
|---|---|
| MCP 端点 | `https://mcp.ipipai.com/mcp` |
| 传输方式 | `streamable-http`（HTTP 长连接，支持流式） |
| 鉴权 | `Authorization: Bearer <MCP_AUTH_TOKEN>` |
| 健康检查 | `https://mcp.ipipai.com/health` |

在支持 MCP 的客户端里加入这段配置（替换 `<MCP_AUTH_TOKEN>` 为你在 [mcp.ipipai.com](https://mcp.ipipai.com) 获取的令牌）：

```json
{
  "mcpServers": {
    "ipipai-mcp": {
      "url": "https://mcp.ipipai.com/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

`curl` 自检（应返回 401 + `WWW-Authenticate: Bearer`，说明端点与鉴权链路正常）：

```bash
curl -i https://mcp.ipipai.com/mcp -H "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## 工具清单（16）

| 工具 | 作用 | 何时用 |
|---|---|---|
| `ip_lookup` | 查 IP/域名归属地、经纬度、时区、ASN、ISP，及代理/VPN/机房标记 | 问「某 IP/域名是哪里的、是不是代理/机房」 |
| `my_ip` | 返回调用方自身的公网 IP 与基础地理信息 | 问「我现在的出口 IP 是什么」（查自己；查别人用 `ip_lookup`） |
| `whois_lookup` | RDAP 查域名 / IP / CIDR / ASN 的注册信息、所有者、注册商、状态 | 查「域名/IP/ASN 的注册归属」 |
| `dns_resolve` | 解析域名的 A(IPv4) / AAAA(IPv6) 地址 | 问「某域名对应什么 IP」 |
| `ping` | ICMP 连通性与延迟/丢包 | 问「某 IP/域名通不通、延迟多少」 |
| `traceroute` | 路由追踪，每跳带 GeoIP（国家/ASN/ISP） | 看「到目标经过哪些节点、哪一跳慢」 |
| `latency_test` | HTTP 响应延迟 min/avg/max/jitter 多轮采样 | 测「网站/API 访问快不快」 |
| `streaming_unlock` | 测试代理节点解锁 Netflix/Disney+/ChatGPT/Bilibili 等 | 问「某代理节点能解锁哪些平台」（需传入节点） |
| `streaming_list` | 列出所有可测流媒体 / 社交 / AI 服务 | 先确认「支持测哪些平台」 |
| `globalping` | 全球分布式 ping/trace/mtr，可按国家选探测点 | 想「从世界各地多个点测目标延迟/路由」 |
| `asn_changes` | 站点 BGP 监控流捕获的实时路由变化，可按 IP/ASN 过滤 | 问「某 IP/ASN 最近的 BGP 路由变化」 |
| `asn_status` | BGP 监控流状态（在线、累计变化、最活跃 ASN） | 确认「BGP 监控是否正常运行」 |
| `parse_node` | 把节点 URI（vmess/vless/ss/trojan）解析为结构化配置 | 给了「一串节点链接，想拆成参数」 |
| `llm_detection` | 检测当前网络能否访问 ChatGPT/Claude/Gemini/DeepSeek 等大模型 | 问「能不能用 ChatGPT / Claude」 |
| `streaming_detection` | 检测当前网络能否解锁 Netflix/Disney+/YouTube/Bilibili | 问「能不能看 Netflix / Disney+」 |
| `ip_leak_detection` | 检测 WebRTC/WebSocket/DNS 等 IP 泄露风险 | 问「我的 IP 会不会泄露」 |

> 注：`llm_detection` / `streaming_detection` / `ip_leak_detection` 需浏览器端检测能力，服务会引导你到 [ipipai.com/detect](https://ipipai.com/detect) 完成。

## 主站功能（[ipipai.com](https://ipipai.com)）

需要网页直接查（不用 AI 客户端）时，主站提供 15 个在线工具：

| 工具 | 页面 |
|---|---|
| IP 查询（归属 / 风险） | [ipipai.com/ip-lookup.html](https://ipipai.com/ip-lookup.html) |
| 流媒体解锁检测 | [ipipai.com/unlock-test.html](https://ipipai.com/unlock-test.html) |
| Whois 查询 | [ipipai.com/whois.html](https://ipipai.com/whois.html) |
| MAC 厂商查询 | [ipipai.com/mac-lookup.html](https://ipipai.com/mac-lookup.html) |
| IMEI 检测 | [ipipai.com/imei-check.html](https://ipipai.com/imei-check.html) |
| Ping 测试 | [ipipai.com/ping-test.html](https://ipipai.com/ping-test.html) |
| 路由追踪 | [ipipai.com/traceroute.html](https://ipipai.com/traceroute.html) |
| 网速测试 | [ipipai.com/speed-test.html](https://ipipai.com/speed-test.html) |
| WebRTC 泄漏检测 | [ipipai.com/webrtc-leak-test.html](https://ipipai.com/webrtc-leak-test.html) |
| 浏览器指纹检测 | [ipipai.com/browser-check.html](https://ipipai.com/browser-check.html) |
| 网站可用性检测 | [ipipai.com/availability-check.html](https://ipipai.com/availability-check.html) |
| 服务状态监控 | [ipipai.com/service-status.html](https://ipipai.com/service-status.html) |
| 代理规则测试 | [ipipai.com/proxy-test.html](https://ipipai.com/proxy-test.html) |
| ASN 历史 | [ipipai.com/asn-history.html](https://ipipai.com/asn-history.html) |
| 130 项安全检查 | [ipipai.com/security-checklist.html](https://ipipai.com/security-checklist.html) |

## 相关博客（[ipipai.com/blog](https://ipipai.com/blog)）

深入原理与踩坑经验，按主题查阅：

- **IP 检测基础** — [ipipai.com/blog](https://ipipai.com/blog)（IP 纯净度、IP 质量、住宅 vs 机房）
- **VPN 与安全** — [ipipai.com/blog](https://ipipai.com/blog)（VPN 检测、DNS/WebRTC 泄漏、浏览器指纹）
- **流媒体解锁** — [ipipai.com/blog](https://ipipai.com/blog)（Netflix / Disney+ / ChatGPT 解锁）
- **TikTok 运营与 IP** — [ipipai.com/blog](https://ipipai.com/blog)（养号、纯净 IP、降权信号）
- **网络工具 & MCP 进阶** — [ipipai.com/blog](https://ipipai.com/blog)（MCP 入门、Tool Calling、连接排查）

## 关键词 & GEO（供 AI / 搜索引擎发现）

本服务面向以下检索意图（中英对照）：

**MCP / AI 工具调用**
- 中文：MCP 服务器、MCP 协议、模型上下文协议、AI 工具调用、JSON-RPC、MCP 接入、MCP 排查
- English: MCP server, Model Context Protocol, MCP JSON-RPC, AI tool calling, MCP integration, MCP connection troubleshooting

**IP 情报 / 风险**
- 中文：IP 检测、IP 纯净度、IP 质量评分、IP 风险评分、IP 黑名单查询、IP 信誉、代理/VPN/机房检测、原生 IP、广播 IP
- English: IP lookup, IP purity score, IP quality / risk score, IP reputation check, residential vs datacenter IP, native IP / broadcast IP, VPN / proxy / datacenter detection

**流媒体 / AI 解锁**
- 中文：流媒体解锁、Netflix 解锁、Disney+ 解锁、ChatGPT 可用区、机房 IP 被封锁、解锁节点选择
- English: streaming unlock, Netflix / Disney+ region, ChatGPT region available, datacenter IP detection, unlock node selection

**网络诊断**
- 中文：Ping 测试、路由追踪、全球多点测速、BGP/ASN 变更、DNS 解析
- English: ping test, traceroute / MTR, global multi-location speed test, BGP / ASN changes, DNS lookup

> 给 AI 的入口：[https://mcp.ipipai.com/llms.txt](https://mcp.ipipai.com/llms.txt)（机器可读能力说明），主站能力索引 [https://ipipai.com/llms.txt](https://ipipai.com/llms.txt)。

## IP 数据来源（公开）

`ip_lookup` 等工具背后的 IP 属性结果由**多数据源融合**得出。以下为当前使用的全部数据来源：

| # | 数据源 | 类型 | 用途 |
|---|---|---|---|
| 1 | **MaxMind GeoLite2**（City / ASN / Country，`.mmdb`） | 离线数据库 | 国家、省/州、城市、经纬度、时区、ASN 与 ISP 基础信息 |
| 2 | **ip2region**（`.xdb`，官方 Node 绑定） | 离线数据库 | 中国大陆 / 港澳台 IP 精准定位（省、市、运营商），覆盖 MaxMind 结果 |
| 3 | **IP2Location LITE DB11**（IPv4+IPv6 `.BIN`，~217MB） | 离线数据库（自动更新） | 境外 IP 精准定位：城市、邮编、ISP、使用类型（`usagetype`），版本每日检查、热重载 |
| 4 | **firehol / blocklist-ipsets**（Tor、SOCKS、SSL 代理、Spamhaus DROP/EDROP） | 开源黑名单 | 代理 / Tor / 滥用 IP 匹配（导入 MySQL 管理） |
| 5 | **ASN 类型表**（`asn-type.json`） | 本地映射表 | ASN → 类型（isp / mobile / hosting / education / government / business） |
| 6 | **ip-api.com** | 在线 API | 代理 / 机房 / 移动标志（比本地数据库更准；带 429 退避 + 每日额度护栏） |
| 7 | **IPinfo.io** | 在线 API | 地理与隐私属性补充 |
| 8 | **VPNAPI.io** | 在线 API | VPN / 代理 / Tor 安全属性 |
| 9 | **Shodan InternetDB** | 在线 API | 开放端口特征（辅助机房识别） |
| 10 | **Globalping**（API） | 在线服务 | 全球分布式 Ping / Traceroute（`globalping` 工具） |
| 11 | **RDAP 注册局**（IANA / RIR / ccTLD） | 在线协议 | WHOIS / 域名 / IP / ASN 注册信息（`whois_lookup`） |

**离线优先 + 在线增强**：主流程基于本地离线数据库（1–5 项）完成定位与分类，在线数据源（6–9 项）按需增强代理 / 机房 / 隐私判断，任一在线源失败不影响主流程。

> 注：具体的融合评分算法与实现细节属于闭源核心，不在本仓库范围内（见「开源说明 & 边界」）。

## 开源说明 & 边界

- **本仓库开源的是 MCP 服务的接口与接入方式**（协议、端点、鉴权、16 个工具清单、客户端配置），MIT 许可。
- **数据来源公开**：见「IP 数据来源（公开）」章节——列出全部 11 个数据源及其用途，方便你了解 `ip_lookup` 结果基于哪些数据。
- **算法与采集/实现细节不公开**：多源融合的评分权重、分类规则、黑名单构建等属于产品核心，不在本仓库范围内。
- 仓库不含任何 IP 数据库文件（`.mmdb` / `.xdb` / `.BIN` 等已在 `.gitignore` 中排除）。

---

**接入起点：[https://mcp.ipipai.com](https://mcp.ipipai.com) ｜ 网页工具：[ipipai.com](https://ipipai.com)**
