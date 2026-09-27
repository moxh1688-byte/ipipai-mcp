# ipipai-mcp

IP attribute lookup & network diagnostics MCP server. 16 tools, JSON-RPC 2.0,
MCP Streamable HTTP + stdio. Data sourced from local GeoLite2 / IP2Location
databases (offline) with public online fallback (ip-api.com / ipwho.is / rdap.org).

## Tools (16)

| Tool | Purpose |
|---|---|
| `ip_lookup` | Full IP attributes: geo / ASN / ISP / proxy-VPN-hosting detection |
| `my_ip` | Resolve the caller's own public IP |
| `whois_lookup` | WHOIS / RDAP domain lookup |
| `dns_resolve` | DNS A/AAAA/MX/NS/CNAME/PTR/TXT lookup |
| `ping` | ICMP latency / reachability |
| `traceroute` | Routing path (MTR-style) |
| `latency_test` | Multi-point latency measurement |
| `streaming_unlock` | Detect streaming service geoblock/unlock |
| `streaming_list` | List supported streaming services |
| `globalping` | Cross-region ping via public providers |
| `asn_changes` | ASN / BGP route change history |
| `asn_status` | Current ASN / BGP status |
| `parse_node` | Parse a network node identifier |
| `llm_detection` | Detect LLM traffic patterns |
| `streaming_detection` | Detect streaming service traffic |
| `ip_leak_detection` | Detect IP / DNS leak |

## Quick start (4 steps)

```bash
npm i
npm run build

# P0: http/both transports require MCP_AUTH_TOKEN (server refuses to start without it)
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
export MCP_TRANSPORT=http
export PORT=3300
node dist/index.js
```

stdio mode (local agent / desktop client) does NOT require a token:

```bash
MCP_TRANSPORT=stdio node dist/index.js
```

## Docker

```bash
docker build -t ipipai-mcp .
docker run -p 3300:3300 \
  -v /abs/path/to/data:/data \
  -e DATA_DIR=/data \
  -e MCP_TRANSPORT=http \
  -e MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  ipipai-mcp
```

## Connecting an MCP client

```json
{
  "mcpServers": {
    "ipipai-mcp": {
      "url": "https://<your-host>:3300/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Development

```bash
npm run dev          # tsx src/index.ts (stdio)
npm run dev:http     # tsx with MCP_TRANSPORT=http
npm run inspect      # MCP Inspector
```

## License

MIT — see `LICENSE`. The server code is MIT-licensed; the IP databases it
reads are NOT part of this license and remain under their own MaxMind /
IP2Location terms.
