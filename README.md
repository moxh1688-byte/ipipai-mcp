# IPIPAI MCP Server — IP 属性查询 & 网络诊断 MCP 服务

> **在线服务地址：[https://mcp.ipipai.com](https://mcp.ipipai.com)**
>
> 一个基于 MCP (Model Context Protocol) 协议的 IP 属性查询与网络诊断服务，支持 16 种工具，覆盖 IP 地理定位、ASN/ISP 查询、代理/VPN/机房检测、WHOIS、DNS、Ping、Traceroute、流媒体解锁检测、LLM 流量识别等能力。任何支持 MCP 协议的 AI 客户端（Claude Desktop、Cursor、ChatGPT、Cline 等）均可接入调用。

[![MCP Server](https://img.shields.io/badge/MCP-Streamable%20HTTP-blue)](https://mcp.ipipai.com)
[![Protocol](https://img.shields.io/badge/JSON--RPC-2.0-green)](https://mcp.ipipai.com/mcp)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](https://github.com/moxh1688-byte/ipipai-mcp/blob/main/LICENSE)
[![Live Demo](https://img.shields.io/badge/Live-mcp.ipipai.com-brightgreen)](https://mcp.ipipai.com)

## 为什么用 IPIPAI MCP

- 🛰️ **16 种网络工具**：IP 查询、WHOIS、DNS、Ping、Traceroute、流媒体解锁检测、ASN 变更追踪等一站式覆盖
- 🔒 **企业级安全**：HTTPS + HTTP/3、Bearer Token 鉴权、安全响应头、HSTS、防指纹泄漏
- ⚡ **低延迟**：多数据源聚合查询，毫秒级响应
- 🤖 **AI 原生**：遵循 MCP Streamable HTTP 协议，所有主流 AI 客户端即插即用
- 🌍 **全球可用**：部署在 Cloudflare 边缘，全球低延迟访问

## 服务地址

| 项目 | 地址 |
|---|---|
| 服务主页 | [https://mcp.ipipai.com](https://mcp.ipipai.com) |
| MCP 端点 | `https://mcp.ipipai.com/mcp` |
| 健康检查 | `https://mcp.ipipai.com/health` |

## 支持的工具 (16)

| 工具 | 功能说明 |
|---|---|
| `ip_lookup` | IP 全属性查询：地理位置 / ASN / ISP / 代理-VPN-机房检测 / 风险评分 |
| `my_ip` | 查询调用方自身的公网 IP |
| `whois_lookup` | WHOIS / RDAP 域名注册信息查询 |
| `dns_resolve` | DNS 解析（A/AAAA/MX/NS/CNAME/PTR/TXT） |
| `ping` | ICMP 延迟与可达性检测 |
| `traceroute` | 路由路径追踪（MTR 风格） |
| `latency_test` | 多点延迟测量 |
| `streaming_unlock` | 流媒体地理封锁/解锁状态检测（Netflix、Disney+、TikTok 等） |
| `streaming_list` | 列出支持的流媒体服务 |
| `globalping` | 跨地域 Ping 检测 |
| `asn_changes` | ASN / BGP 路由变更历史 |
| `asn_status` | 当前 ASN / BGP 状态 |
| `parse_node` | 网络节点标识符解析 |
| `llm_detection` | LLM / AI 爬虫流量模式识别 |
| `streaming_detection` | 流媒体服务流量识别 |
| `ip_leak_detection` | IP / DNS 泄漏检测 |

## 如何接入（AI 客户端配置）

在支持 MCP 的客户端中添加以下配置：

```json
{
  "mcpServers": {
    "ipipai-mcp": {
      "url": "https://mcp.ipipai.com/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <YOUR_AUTH_TOKEN>"
      }
    }
  }
}
```

> 访问 [https://mcp.ipipai.com](https://mcp.ipipai.com) 获取接入令牌与详细文档。

## 许可证

MIT License。

---

**访问 [https://mcp.ipipai.com](https://mcp.ipipai.com) 开始使用，或查看 [ipipai.com](https://ipipai.com) 获取更多 IP 检测工具。**
