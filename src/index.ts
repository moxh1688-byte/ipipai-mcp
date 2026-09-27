#!/usr/bin/env node
/**
 * ipipai-mcp — IP 属性查询 MCP server
 *
 * 提供三个工具：
 *   - ip_lookup     查询任意 IP（或域名解析后）的属性：地理、ASN、ISP、坐标、时区、代理/VPN/机房检测
 *   - my_ip         返回调用方自己的公网 IP 与基础地理信息
 *   - whois_lookup  通过 RDAP 查询域名 / IP / CIDR / ASN 的 WHOIS 信息
 *
 * ============================================================
 * 设计对齐说明（针对你的 IPIPAI.com 源码）
 * ============================================================
 * 你的站点后端（server.js → classifier.js#queryLocal）查询逻辑是：
 *   1. 主数据源：本地 MaxMind GeoLite2（City/ASN/Country .mmdb）+ IP2Location LITE BIN —— 离线、权威
 *   2. 补充：在线 IP-API 的 proxy/hosting/mobile 标记（短超时，失败不影响主流程）
 *
 * 这一版 MCP：
 *   ★ 默认走本地 MMDB（与你的网页同源、结果一致、且完全离线，从根上规避 "signal is aborted" 出网故障）
 *   ★ 当未配置 IPIPAI_DATA_DIR 或本地库缺失时，自动回退到在线 API（ip-api.com → ipwho.is）
 *   ★ 在线补充 proxy/hosting/mobile 时失败不影响主结果，绝不抛 "without reason"
 *
 * ============================================================
 * 传输层（关键：让「全世界 AI 自动调用」）
 * ============================================================
 *   - MCP_TRANSPORT=stdio  （默认）本机 stdio，给 Claude Desktop/Cursor 等本地客户端用
 *   - MCP_TRANSPORT=http   远程模式：监听 HTTP，任何支持 MCP 的远程 agent 通过 URL 直连
 *   - MCP_TRANSPORT=both   同时跑 stdio + http（本机 + 远程）
 * 远程模式启用 CORS（允许浏览器/跨域 agent 调用）+ 可选 Bearer 鉴权（MCP_AUTH_TOKEN）。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createRequire } from "module";
import { randomUUID } from "crypto";
import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import express from "express";

const require = createRequire(import.meta.url);

const USER_AGENT = "ipipai-mcp/2.1";
const REQUEST_TIMEOUT_MS = Number(process.env.IP_LOOKUP_TIMEOUT_MS ?? 8000);

// ============ 本地 MMDB 初始化（对齐 classifier.js#init）============
const DATA_DIR = process.env.IPIPAI_DATA_DIR || "";
let cityReader: any = null;
let asnReader: any = null;
let countryReader: any = null;
let ip2loc: any = null;
let localReady = false;

function initLocal() {
  if (!DATA_DIR) return; // 没配 dataDir → 用在线回退
  const maxmind = safeRequire("maxmind");
  const ip2locLib = safeRequire("ip2location-nodejs");
  if (!maxmind) {
    console.error("[ipipai-mcp] 未安装 maxmind，本地 MMDB 不可用，将回退在线 API");
    return;
  }
  try {
    cityReader = new maxmind.Reader(fs.readFileSync(path.join(DATA_DIR, "GeoLite2-City.mmdb")));
    asnReader = new maxmind.Reader(fs.readFileSync(path.join(DATA_DIR, "GeoLite2-ASN.mmdb")));
    countryReader = new maxmind.Reader(fs.readFileSync(path.join(DATA_DIR, "GeoLite2-Country.mmdb")));
    if (ip2locLib) {
      ip2loc = new ip2locLib.IP2Location();
      ip2loc.open(path.join(DATA_DIR, "IP2LOCATION-LITE-DB11.IPV6.BIN"));
    }
    localReady = true;
    console.error(`[ipipai-mcp] ✅ 本地 MMDB 已加载（dataDir=${DATA_DIR}）`);
  } catch (e: any) {
    console.error(`[ipipai-mcp] ⚠️ 本地 MMDB 加载失败，回退在线 API：${e.message}`);
    localReady = false;
  }
}

function safeRequire(name: string): any {
  try {
    return require(name);
  } catch {
    return null;
  }
}


// ============ IP 类型精准分类（基于 GeoLite2-ASN org 名）============
const DATACENTER_KEYWORDS = [
  'GOOGLE','CLOUDFLARENET','CLOUDFLARE','LINODE','DIGITALOCEAN','AWS','AMAZON',
  'MICROSOFT','GOV','HETZNER','OVH','DIGITALOCEAN','VULTR','AKAMAI','FASTLY',
  'HANGZHOU ALIBABA','ALIBABA','TENCENT','UCloud','BAIDU','QIHOO','QIHN',
  'CENTURY','DYNAMIC','NUAN','YUN','DATACENTER','IDC','VPS','HOSTING'
];
const MOBILE_KEYWORDS = [
  'MOBILE','CMCC','CHINA MOBILE','UNICOM','TELECOM','CUCC','CHINA UNION','CHINA MOBILE',
  'ATT','VERIZON','T-MOBILE','SPRINT','VODAFONE','ORANGE','DEUTSCHE','SK TELECOM','KT'
];
export function classifyIpType(asnOrg: string): string {
  const s = (asnOrg || '').toUpperCase();
  if (!s) return 'unknown';
  // 先判移动（移动 ISP 的 org 名常同时含 TELECOM 和 MOBILE，优先匹配更具体的 MOBILE）
  if (MOBILE_KEYWORDS.some(k => s.includes(k))) return 'mobile';
  // 再判机房/数据中心
  if (DATACENTER_KEYWORDS.some(k => s.includes(k))) return 'datacenter';
  // 默认：未命中关键字的普通 ISP 视为 residential（含家用宽带）
  return 'residential';
}

// ============ 本地查询（对齐 classifier.js#queryLocal）============
function lookupLocal(ip: string): Record<string, unknown> | null {
  if (!localReady) return null;
  const result: Record<string, unknown> = { ip, source: "local", dataSource: "local" };
  try {
    const isIPv6 = ip.includes(":");
    result.isIPv6 = isIPv6;

    const city = cityReader.get(ip);
    if (city) {
      result.countryCode = city.country?.iso_code || city.registered_country?.iso_code || "";
      result.country = city.country?.names?.["zh-CN"] || city.country?.names?.en || "";
      result.countryEn = city.country?.names?.en || "";
      result.registeredCountryCode = city.registered_country?.iso_code || "";
      result.region = city.subdivisions?.[0]?.names?.["zh-CN"] || city.subdivisions?.[0]?.names?.en || city.subdivisions?.[0]?.iso_code || "";
      result.regionEn = city.subdivisions?.[0]?.names?.en || "";
      result.city = city.city?.names?.["zh-CN"] || city.city?.names?.en || "";
      result.cityEn = city.city?.names?.en || "";
      result.lat = city.location?.latitude || 0;
      result.lon = city.location?.longitude || 0;
      result.timezone = city.location?.time_zone || "";
      result.accuracyRadius = city.location?.accuracy_radius || 0;
      if (city.registered_country?.iso_code && city.country?.iso_code) {
        result.isNative = city.registered_country.iso_code === city.country.iso_code;
      }
    }

    const asn = asnReader.get(ip);
    if (asn) {
      result.asn = asn.autonomous_system_number || 0;
      result.asnOrg = asn.autonomous_system_organization || "";
      result.isp = asn.autonomous_system_organization || "";
    }

    if (!result.countryCode) {
      const country = countryReader.get(ip);
      if (country) {
        result.countryCode = country.country?.iso_code || country.registered_country?.iso_code || "";
        result.country = country.country?.names?.["zh-CN"] || country.country?.names?.en || "";
        result.countryEn = country.country?.names?.en || "";
        result.registeredCountryCode = country.registered_country?.iso_code || "";
      }
    }

    // 国外 IP 增强：IP2Location 补充 usageType（ISP/DCH/MOB/RES 等）
    const cc = result.countryCode as string;
    if (ip2loc && cc && !["CN", "HK", "TW", "MO"].includes(cc)) {
      try {
        const rec = ip2loc.getAll(ip);
        if (rec) {
          if (rec.city_short && !result.city) result.city = rec.city_short;
          if (rec.region && !result.region) result.region = rec.region;
          if (rec.isp && !result.isp) result.isp = rec.isp;
          if (rec.latitude && !result.lat) result.lat = parseFloat(rec.latitude) || 0;
          if (rec.longitude && !result.lon) result.lon = parseFloat(rec.longitude) || 0;
          if (rec.zipcode && !result.zip) result.zip = rec.zipcode;
          if (rec.timezone && !result.timezone) result.timezone = rec.timezone;
          if (rec.usagetype) {
            result.ip2locUsageType = rec.usagetype;
            const ut = String(rec.usagetype).toUpperCase();
            result.isHosting = true;
            if (ut.includes("MOB") || ut.includes("CELL")) result.isMobile = true;
          }
          if (rec.asn && !result.asn) result.asn = parseInt(rec.asn, 10) || 0;
          if (rec.as && !result.asnOrg) result.asnOrg = rec.as;
        }
      } catch {
        /* IP2Location 失败不影响主流程 */
      }
    }

    result.ip_type = classifyIpType(String(result.asnOrg || ""))
    if (result.asn) result.as = `AS${result.asn} ${result.asnOrg || ""}`.trim();
    return result;
  } catch {
    return null; // 本地查询异常 → 交给在线回退
  }
}

// ============ 通用：带明确 reason 的超时信号 ============
function withTimeout(ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort(new Error(`upstream request timed out after ${ms}ms`));
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return ctrl.signal;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: withTimeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`upstream ${new URL(url).host} responded ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ============ 在线 API（回退 / 补充）============
async function lookupIpApi(ip?: string): Promise<IpResult> {
  const fields = "status,message,query,country,countryCode,regionName,city,lat,lon,isp,org,as,proxy,hosting,mobile,timezone";
  const url = ip
    ? `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`
    : `http://ip-api.com/json/?fields=${fields}`;
  const d = await fetchJson(url);
  if (d && d.status !== "success") throw new Error(`ip-api error: ${d.message ?? "unknown"}`);
  return {
    source: "ip-api.com",
    dataSource: "online",
    ip: d.query,
    countryCode: d.countryCode,
    country: d.country,
    region: d.regionName,
    city: d.city,
    lat: d.lat,
    lon: d.lon,
    isp: d.isp,
    org: d.org,
    asn: d.as,
    as: d.as,
    proxy: d.proxy,
    hosting: d.hosting,
    mobile: d.mobile,
    timezone: d.timezone,
  };
}

async function lookupIpwho(ip?: string): Promise<IpResult> {
  const url = ip ? `https://ipwho.is/${encodeURIComponent(ip)}` : "https://ipwho.is/";
  const d = await fetchJson(url);
  if (d && d.success === false) throw new Error(`ipwho.is error: ${d.message ?? "unknown"}`);
  const conn = d.connection ?? {};
  return {
    source: "ipwho.is",
    dataSource: "online",
    ip: d.ip,
    type: d.type,
    continent: d.continent,
    countryCode: d.country_code,
    country: d.country,
    region: d.region,
    city: d.city,
    postal: d.postal,
    latitude: d.latitude,
    longitude: d.longitude,
    isp: conn.isp,
    org: conn.org,
    asn: conn.asn,
    asn_org: conn.org,
    timezone: d.timezone?.id,
    timezone_utc: d.timezone?.utc,
  };
}

/** 在线回退：先 ip-api（字段更贴近 ipipai），失败再 ipwho.is */
async function lookupOnline(ip?: string): Promise<IpResult> {
  try {
    return await lookupIpApi(ip);
  } catch {
    return await lookupIpwho(ip);
  }
}

/** 用 IP-API 的 proxy/hosting/mobile 标记补充本地结果（失败不影响主流程） */
async function augmentProxyFlags(base: Record<string, unknown>, ip: string): Promise<Record<string, unknown>> {
  try {
    const d = await lookupIpApi(ip);
    if (d.proxy) base.isProxy = true;
    if (d.hosting) base.isHosting = true;
    if (d.mobile) base.isMobile = true;
  } catch {
    /* 在线补充失败不阻塞本地结果 */
  }
  return base;
}

type IpResult = Record<string, unknown>;

// ============ 格式化输出（14 项 summary 表格，对齐 ipipai.com 网页）============

const COUNTRY_FLAG: Record<string, string> = {
  CN: "🇨🇳", US: "🇺🇸", GB: "🇬🇧", DE: "🇩🇪", FR: "🇫🇷", JP: "🇯🇵", KR: "🇰🇷", IN: "🇮🇳", AU: "🇦🇺", CA: "🇨🇦",
  BR: "🇧🇷", RU: "🇷🇺", IT: "🇮🇹", ES: "🇪🇸", NL: "🇳🇱", SE: "🇸🇪", NO: "🇳🇴", DK: "🇩🇰", FI: "🇫🇮", CH: "🇨🇭",
  SG: "🇸🇬", HK: "🇭🇰", TW: "🇹🇼", MO: "🇲🇴", TH: "🇹🇭", VN: "🇻🇳", PH: "🇵🇭", ID: "🇮🇩", MY: "🇲🇾",
  PK: "🇵🇰", BD: "🇧🇩", TR: "🇹🇷", SA: "🇸🇦", AE: "🇦🇪", ZA: "🇿🇦", MX: "🇲🇽", AR: "🇦🇷", CL: "🇨🇱",
};

function flagFor(code: string): string {
  const c = (code || "").toUpperCase().replace(/[^A-Z]/g, "");
  return COUNTRY_FLAG[c] || (c ? "🌐" : "❓");
}

function ipToDecimal(ip: string): string {
  const parts = ip.split(".");
  if (parts.length !== 4) return "N/A";
  let n = 0;
  for (const p of parts) n = n * 256 + (parseInt(p, 10) || 0);
  return String(n);
}

function calcRiskScore(r: Record<string, unknown>): number {
  let score = 0;
  if (r.isProxy) score += 40;
  if (r.isHosting) score += 30;
  if (r.isMobile) score += 10;
  return Math.min(score, 100);
}

function riskLabel(score: number): { text: string; dots: string; color: string } {
  if (score === 0) return { text: "极低风险", dots: "🟢🟢🟢🟢🟢", color: "🟢" };
  if (score <= 15) return { text: "低风险", dots: "🟢🟢🟢🟢🔴", color: "🟡" };
  if (score <= 35) return { text: "中风险", dots: "🟢🟢🔴🔴🔴", color: "🟠" };
  if (score <= 65) return { text: "高风险", dots: "🔴🔴🔴🔴🟢", color: "🔴" };
  return { text: "极高风险", dots: "🔴🔴🔴🔴🔴", color: "🔴" };
}

function scenarioStars(score: number): Record<string, string> {
  const s = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);
  if (score <= 15) return { TikTok: s(5), "跨境电商": s(5), "社媒运营": s(5), "AI 应用": s(3) };
  if (score <= 35) return { TikTok: s(3), "跨境电商": s(4), "社媒运营": s(4), "AI 应用": s(2) };
  if (score <= 65) return { TikTok: s(2), "跨境电商": s(2), "社媒运营": s(3), "AI 应用": s(1) };
  return { TikTok: s(1), "跨境电商": s(1), "社媒运营": s(2), "AI 应用": s(0) };
}

function sharedUsersText(r: Record<string, unknown>): string {
  if (r.isProxy) return "未知";
  if (r.isHosting) return "1-10 (极好)";
  if (r.isMobile) return "1-10 (极好)";
  return "10-100 (中等)";
}

function formatResult(r: Record<string, unknown>): Record<string, unknown> {
  const risk = calcRiskScore(r);
  const rl = riskLabel(risk);
  const stars = scenarioStars(risk);
  const sc = String(r.countryCode || "").toUpperCase();
  const flag = flagFor(sc);
  const loc = [flag, r.country || sc, r.region || "", r.city || ""]
    .filter(Boolean).join(" ");
  const ipStr = String(r.ip || "N/A");
  const ipDecimal = ipToDecimal(ipStr);
  const asNum = typeof r.asn === "number" ? r.asn :
    typeof r.asn === "string" ? (r.asn.match(/\d+/)?.[0] || r.asn) :
    String(r.as || "").match(/\d+/)?.[0] || "N/A";
  const asOwner = String(r.asnOrg || r.org || r.as || "N/A").replace(/^AS\d+\s*/i, "");
  const isNat = (r.isNative === true || r.isNative === "true");
  const isProxy = !!r.isProxy;
  const isHost = !!r.isHosting;
  const isMob = !!r.isMobile;
  const typeTags = [];
  const ipTypeMap: Record<string, string> = { datacenter: "IDC机房", mobile: "移动网络", residential: "住宅/光纤" };
  const rType = String(r.ip_type || "");
  if (ipTypeMap[rType]) {
    typeTags.push(ipTypeMap[rType]);
  } else {
    if (isProxy) typeTags.push("代理");
    if (isHost) typeTags.push("IDC机房");
    if (isMob) typeTags.push("移动网络");
    if (!typeTags.length) typeTags.push("住宅/光纤");
  }
  const asOwnerClean = asOwner.length > 2 ? asOwner : "N/A";

  const summary = [
    "| 项目 | 详情 |",
    "|------|------|",
    `| IP 地址 | **${ipStr}** |`,
    `| IP 位置 | ${loc} |`,
    `| ASN | **AS${asNum}** |`,
    `| ASN 所有者 | **${asOwnerClean}** |`,
    `| 企业 | ${r.isp || r.org || "N/A"} |`,
    `| 经度 | ${r.lon ?? "N/A"} |`,
    `| 纬度 | ${r.lat ?? "N/A"} |`,
    `| IP 类型 | ${typeTags.join("·")}${isNat ? " · ✅ 原生 IP" : ""} |`,
    `| 风控值 | ${rl.dots} **${risk}%** ${rl.text} |`,
    `| 原生 IP | ${isNat ? "✅" : "❌"} |`,
    `| 大模型检测 | [需要到 ipipai.com 检测](https://ipipai.com/detect?ip=${ipStr}) |`,
    `| IP 地址(数字) | ${ipDecimal} |`,
    `| 共享人数 | [需要到 ipipai.com 检测](https://ipipai.com/detect?ip=${ipStr}) |`,
    `| 适用场景 | TikTok ${stars["TikTok"]} · 跨境电商 ${stars["跨境电商"]} · 社媒运营 ${stars["社媒运营"]} · AI 应用 ${stars["AI 应用"]} |`,
    "",
    "> ⚠️ **AI 无法转发流量**：共享人数、大模型检测需到 [ipipai.com](https://ipipai.com/detect?ip=" + ipStr + ") 完成；流媒体解锁测试需到 [ipipai.com/streaming](https://ipipai.com/streaming) 传入节点 URI 执行；IP 泄露检测需到 [ipipai.com/leak](https://ipipai.com/leak) 使用代理节点执行。本 MCP 仅能查询 IP 基础属性与执行本地网络诊断（ping/DNS/traceroute）。",
  ].join("\n");

  return { ...r, summary, source_url: "https://ipipai.com", powered_by: "[ipipai.com](https://ipipai.com)" };
}

function formatDnsResult(r: Record<string, unknown>): Record<string, unknown> {
  const ipv4 = Array.isArray(r.ipv4) ? r.ipv4 : (r.ipv4 ? [r.ipv4] : []);
  const ipv6 = Array.isArray(r.ipv6) ? r.ipv6 : (r.ipv6 ? [r.ipv6] : []);
  const summary = [
    "| 项目 | 详情 |",
    "|------|------|",
    `| 域名 | **${r.domain || "N/A"}** |`,
    ipv4.length > 0 ? `| A 记录 IPv4 | ${ipv4.map(ip => `**${ip}**`).join(" · ")} |` : "| A 记录 IPv4 | 无 A 记录 |",
    ipv6.length > 0 ? `| AAAA 记录 IPv6 | ${ipv6.map(ip => `**${ip}**`).join(" · ")} |` : "| AAAA 记录 IPv6 | 无 AAAA 记录 |",
    "| 数据来源 | [ipipai.com](https://ipipai.com) |",
  ].join("\n");
  return { ...r, summary, source_url: "https://ipipai.com", powered_by: "[ipipai.com](https://ipipai.com)" };
}

/**
 * 统一入口：
 *  - 配了本地库且就绪 → 用本地 MMDB（与网页同源、离线），并尽力用 IP-API 补充代理标记
 *  - 否则 → 在线 API 回退
 */
async function ipLookup(ip?: string): Promise<IpResult> {
  if (ip && localReady) {
    const local = lookupLocal(ip);
    if (local) {
      return await augmentProxyFlags(local, ip);
    }
  }
  return await lookupOnline(ip);
}

/** RDAP WHOIS */
async function rdapLookup(query: string): Promise<IpResult> {
  const d = await fetchJson(`https://rdap.org/${encodeURIComponent(query)}`);
  return {
    source: "rdap.org",
    object_type: d.objectClassName,
    handle: d.handle,
    ldh_name: d.ldhName,
    statuses: d.status,
    entities: (d.entities ?? []).map((e: any) => e.handle).filter(Boolean),
    events: d.events,
    available_keys: Object.keys(d),
  };
}

/** 域名 → IP（仅在传入看起来像域名时尝试解析） */
async function resolveDomain(input: string): Promise<string | undefined> {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input) || input.includes(":")) return input; // 已是 IP
  try {
    const { lookup } = await import("dns/promises");
    const records = await lookup(input, { all: true });
    if (records && records.length) return records[0].address;
  } catch {
    /* 解析失败则原样传回，交给上层 ip 校验 */
  }
  return undefined;
}

// ============ 站点 API 代理（站点优先 + 本地兜底）============
// 这些工具先调用你 ipipai.com 的 /api/* 端点（复用站点全部逻辑与密钥），
// 一旦站点出网故障 / 超时 / 报错，则回退到 MCP 内本地重实现（DNS/ping/traceroute）。
const SITE_URL = (process.env.IPIPAI_SITE_URL || "https://ipipai.com").replace(/\/$/, "");
const SITE_API_KEY = process.env.IPIPAI_SITE_API_KEY || "";

async function callSite(
  method: "GET" | "POST",
  apiPath: string,
  opts: { query?: Record<string, string>; body?: Record<string, unknown>; timeoutMs?: number } = {}
): Promise<any> {
  const url = new URL(SITE_URL + apiPath);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (SITE_API_KEY) headers["Authorization"] = `Bearer ${SITE_API_KEY}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: withTimeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data && (data.error || data.message) ? data.error || data.message : `HTTP ${res.status}`;
    throw new Error(`站点 ${apiPath} 返回 ${res.status}: ${msg}`);
  }
  return data;
}

/** 校验目标（IP/域名），拒绝空格与 shell 元字符，配合 execFileSync（无 shell）防注入 */
function isValidTarget(target: string): boolean {
  if (typeof target !== "string" || target.length === 0 || target.length > 253) return false;
  return /^[\w.\-:\[\] ]+$/.test(target) && !/[\s;&|$()<>]/.test(target);
}

async function localDnsResolve(domain: string): Promise<IpResult> {
  const dns = await import("dns/promises");
  const [v4, v6] = await Promise.allSettled([dns.resolve4(domain), dns.resolve6(domain)]);
  const ipv4 = v4.status === "fulfilled" ? v4.value : [];
  const ipv6 = v6.status === "fulfilled" ? v6.value : [];
  if (!ipv4.length && !ipv6.length) throw new Error("无法解析域名");
  return { domain, ipv4, ipv6, source: "local" };
}

async function localPing(target: string, count: number): Promise<IpResult> {
  const n = Math.min(Math.max(parseInt(String(count)) || 4, 1), 20);
  const out = execFileSync("ping", ["-c", String(n), "-W", "5", target], { timeout: n * 6000, encoding: "utf-8" });
  const packetRegex = /(\d+) bytes from ([^\s]+).*icmp_seq=(\d+).*ttl=(\d+).*time=([\d.]+)/g;
  const results: any[] = [];
  let m;
  while ((m = packetRegex.exec(out)) !== null) results.push({ seq: +m[3], ip: m[2], ttl: +m[4], time: +m[5] });
  const rtt = out.match(/rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/);
  const loss = out.match(/(\d+)% packet loss/);
  return {
    target, alive: results.length > 0, source: "local",
    packets: { sent: n, received: results.length, loss: loss ? +loss[1] : 0 },
    latency: rtt ? { min: +rtt[1], avg: +rtt[2], max: +rtt[3] } : { min: 0, avg: 0, max: 0 },
    results,
  };
}

async function localTraceroute(target: string, maxHops: number): Promise<IpResult> {
  const hops = Math.min(Math.max(parseInt(String(maxHops)) || 30, 1), 50);
  let out: string;
  try {
    out = execFileSync("traceroute", ["-n", "-w", "2", "-q", "1", "-m", String(hops), target], { timeout: hops * 5000, encoding: "utf-8" });
  } catch (e: any) {
    if (e.stdout) out = e.stdout; else throw new Error(`本地 traceroute 失败: ${e.message}`);
  }
  const hopList: any[] = [];
  for (const line of out.split("\n")) {
    const mm = line.match(/^\s*(\d+)(?:\s+:?)?\s+(.*)/);
    if (!mm) continue;
    const hopNum = +mm[1];
    const rest = mm[2].trim();
    if (rest === "*" || rest.startsWith("* *")) { hopList.push({ hop: hopNum, ip: "*" }); continue; }
    const ipm = rest.match(/^([^\s]+)/);
    const ip = ipm ? ipm[1] : "*";
    const lat = (rest.match(/([\d.]+)\s*ms/g) || []).map((x) => x.trim());
    let geo: any = null;
    if (ip !== "*") { try { const g = lookupLocal(ip); if (g) geo = { country: g.country, countryCode: g.countryCode, region: g.region, city: g.city, asn: g.asn, isp: g.isp }; } catch { /* ignore */ } }
    hopList.push({ hop: hopNum, ip, latency: lat, geo });
  }
  return { target, source: "local", hops: hopList };
}

async function localLatency(target: string, rounds: number): Promise<IpResult> {
  const total = Math.min(Math.max(parseInt(String(rounds)) || 5, 1), 10);
  const roundResults: any[] = [];
  for (let i = 1; i <= total; i++) {
    const proto = target.includes(":") ? "http://" : "https://";
    const start = Date.now();
    try {
      const r = await fetch(proto + target.trim() + "/", { method: "GET", signal: withTimeout(5000), redirect: "manual" });
      roundResults.push({ round: i, time: Math.round((Date.now() - start) / 10) / 100 });
      r.body?.cancel?.();
    } catch { roundResults.push({ round: i, time: -1 }); }
  }
  const valid = roundResults.filter((r) => r.time >= 0).map((r) => r.time);
  const stats = valid.length
    ? { min: Math.min(...valid), avg: Math.round((valid.reduce((s, t) => s + t, 0) / valid.length) * 100) / 100, max: Math.max(...valid) }
    : { min: 0, avg: 0, max: 0 };
  return { target, source: "local", rounds: roundResults, stats };
}

// 统一的成功/失败返回（显式标注类型，避免 type:"text" 被 TS 拓宽为 string 而触发 SDK 类型报错）
type McpText = { type: "text"; text: string };
type ToolResult = { content: McpText[]; isError?: boolean };
function textBlock(text: string): McpText {
  return { type: "text", text };
}
function okJson(data: unknown): ToolResult {
  return { content: [textBlock(JSON.stringify(data, null, 2))] };
}
function errJson(...errs: unknown[]): ToolResult {
  const msgs = errs.filter(Boolean).map((e) => (e instanceof Error ? e.message : String(e)));
  return { content: [textBlock(`请求失败: ${msgs.join(" | ")}`)], isError: true };
}

// ============ MCP 服务工厂（每个会话/连接独立实例）============
function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "ipipai-mcp", version: "2.1.0" },
    {
      instructions:
      "你是「IP 查询与网络诊断」工具集（数据源自 ipipai.com 本地数据库，离线稳定）。当用户提出以下意图时调用对应工具：\n" +
      "① 某 IP/域名「是哪里的、国家/省/市、经纬度、时区、ASN、ISP、是否代理/VPN/机房」→ 用 ip_lookup（留空则查调用方自身 IP）；\n" +
      "② 用户问「我的 IP 是什么」→ 用 my_ip（只能查自己，查别人要用 ip_lookup）；\n" +
      "③ 「whois、域名/IP/ASN 注册信息」→ whois_lookup；\n" +
      "④ 「域名解析成 IP」→ dns_resolve；\n" +
      "⑤ 「ping/通不通/延迟」→ ping；「路由追踪/经过哪些节点」→ traceroute；「网站访问延迟」→ latency_test；\n" +
      "⑥ 「代理节点能解锁 Netflix/ChatGPT 吗」→ streaming_unlock（必须传入节点 URI，如 vmess://...）；「支持测哪些平台」→ streaming_list；\n" +
      "⑦ 「从全球多地测网络质量」→ globalping；\n" +
      "⑧ 「某 IP/ASN 的 BGP 路由变化」→ asn_changes / asn_status；\n" +
      "⑨ 「解析代理节点订阅」→ parse_node；\n" +
      "⑩ 「大模型访问检测」→ llm_detection；「流媒体解锁检测」→ streaming_detection；「IP 泄露检测」→ ip_leak_detection（这三项需浏览器端发起真实请求，AI 无法转发流量，结果会引导用户到 ipipai.com/detect 完成）。\n" +
      "通用规则：IP 属性类问题优先用 ip_lookup；工具失败会返回明确错误，不要编造结果。",
    }
  );

  server.tool(
    "ip_lookup",
    "【IP 属性查询】当用户询问某个 IP 地址或域名的归属地时使用本工具：包括国家/省份/城市、经纬度坐标、时区、所属 ASN（自治系统编号）与运营商(ISP/ORG)、以及是否为代理/VPN/机房/数据中心 IP。也适用于自然语言问题如「这个 IP 是哪里的」「查一下 8.8.8.8 的信息」「判断 1.2.3.4 是不是代理或爬虫」。参数 ip 可传 IPv4、IPv6 或域名（会自动解析）；不传则查询【调用方自己的公网 IP】。数据优先来自本地 GeoLite2/IP2Location 数据库（与 ipipai.com 同源、离线可用，不受服务器出网故障影响），返回字段含 countryCode/country/region/city/lat/lon/timezone/asn/asnOrg/isp/isProxy/isHosting 等。",
    { ip: z.string().optional().describe("IPv4, IPv6, or domain. Omit to lookup your own IP.") },
    async ({ ip }) => {
      try {
        const target = ip ? await resolveDomain(ip) : undefined;
        const result = await ipLookup(target ?? ip);
        const formatted = formatResult(result);
        return { content: [textBlock(String(formatted.summary ?? JSON.stringify(result, null, 2)))] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [textBlock(`IP lookup failed: ${msg}\n\n可能原因：本地库未配置/缺失，且在线回退也失败（服务器出网受限、上游限流、或 IP 无效）。`)],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "my_ip",
    "【查询调用方自身公网 IP】当用户问「我的 IP 是什么」「我现在的出口 IP 是多少」「我的 IP 是哪里的」时使用本工具，返回当前请求来源的公网 IP 及基础地理信息。注意：本工具【只能查调用方自己的 IP】，无法查其他 IP —— 要查指定 IP 或域名请改用 ip_lookup 工具。",
    {},
    async () => {
      try {
        const result = await lookupOnline();
        return { content: [textBlock(JSON.stringify(result, null, 2))] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [textBlock(`my_ip failed: ${msg}`)], isError: true };
      }
    }
  );

  server.tool(
    "whois_lookup",
    "【WHOIS 注册信息查询，基于 RDAP 协议】当用户想查「域名/IP/CIDR/ASN 的注册信息、所有者、注册状态、注册商、DNS 服务器、创建与过期时间」时使用。适用问题如「查 example.com 的 whois 信息」「AS13335 是哪个机构的」「这个 IP 段的注册归属」。参数 query 传入域名(example.com)、IP、CIDR 或 ASN(如 AS13335)。",
    { query: z.string().describe("Domain (e.g. example.com), IP, CIDR, or ASN (e.g. AS13335).") },
    async ({ query }) => {
      try {
        const result = await rdapLookup(query);
        return { content: [textBlock(JSON.stringify(result, null, 2))] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [textBlock(`whois_lookup failed: ${msg}`)], isError: true };
    }
  }
);

  // ---------- 站点 API 优先 + 本地兜底 系列 ----------

  server.tool(
    "dns_resolve",
    "【域名解析】当用户需要把域名解析成 IP 地址时使用：返回 A 记录(IPv4) 与 AAAA 记录(IPv6)。适用问题如「example.com 对应什么 IP」「解析一下这个域名」。优先调用 ipipai.com 站点接口，站点不可达时回退本地 DNS 解析。参数 domain 传入待解析的域名。",
    { domain: z.string().describe("Domain to resolve, e.g. example.com") },
    async ({ domain }) => {
      try {
        return okJson(formatDnsResult(await callSite("GET", "/api/dns-resolve", { query: { domain } })));
      } catch (e) {
        try { return okJson(formatDnsResult(await localDnsResolve(domain))); } catch (e2) { return errJson(e, e2); }
      }
    }
  );

  server.tool(
    "ping",
    "【网络连通性探测 / ICMP Ping】当用户想测试「某个 IP 或域名能否连通、延迟多少、丢包率多少」时使用。适用问题如「ping 一下 8.8.8.8」「这台服务器通不通」「测下 github.com 的延迟」。返回丢包率与最小/平均/最大延迟。优先调用 ipipai.com 站点接口，站点不可达时回退本地 ping 命令。参数 count 为探测次数(1-20，默认 4)。",
    {
      target: z.string().describe("IPv4, IPv6, or domain to ping"),
      count: z.number().optional().describe("Number of pings (1-20, default 4)"),
    },
    async ({ target, count }) => {
      if (!isValidTarget(target)) return errJson("无效的 target：请提供合法 IP 或域名");
      try {
        return okJson(await callSite("POST", "/api/ping", { body: { target, count }, timeoutMs: (count || 4) * 6000 + 2000 }));
      } catch (e) {
        try { return okJson(await localPing(target, count ?? 4)); } catch (e2) { return errJson(e, e2); }
      }
    }
  );

  server.tool(
    "traceroute",
    "【路由追踪 / Traceroute】当用户想看「从本机到目标 IP 或域名之间经过哪些网络节点、每一跳的延迟与归属地」时使用。适用问题如「追踪到 github.com 的路由」「8.8.8.8 的路由路径是什么」「为什么连这个 IP 这么慢」。每一跳都会附带本地 GeoIP(国家/ASN/ISP)。优先调用站点接口，站点不可达时回退本地 traceroute。参数 maxHops 为最大跳数(1-50，默认 30)。",
    {
      target: z.string().describe("IPv4, IPv6, or domain to trace"),
      maxHops: z.number().optional().describe("Max hops (1-50, default 30)"),
    },
    async ({ target, maxHops }) => {
      if (!isValidTarget(target)) return errJson("无效的 target：请提供合法 IP 或域名");
      try {
        return okJson(await callSite("POST", "/api/trace", { body: { target, maxHops }, timeoutMs: (maxHops || 30) * 5000 + 2000 }));
      } catch (e) {
        try { return okJson(await localTraceroute(target, maxHops ?? 30)); } catch (e2) { return errJson(e, e2); }
      }
    }
  );

  server.tool(
    "latency_test",
    "【HTTP 延迟测试】当用户想测「某个网站或服务器在 HTTP 层面的响应延迟(最小/平均/最大/抖动)」时使用。适用问题如「测一下 example.com 的访问延迟」「这个 API 响应快不快」。多轮采样返回统计值。优先调用站点接口，站点不可达时回退本地 HTTP 探测。参数 rounds 为采样轮数(1-10，默认 5)。",
    {
      target: z.string().describe("IPv4, IPv6, or domain to test"),
      rounds: z.number().optional().describe("Number of rounds (1-10, default 5)"),
    },
    async ({ target, rounds }) => {
      if (!isValidTarget(target)) return errJson("无效的 target：请提供合法 IP 或域名");
      try {
        return okJson(await callSite("POST", "/api/latency", { body: { target, rounds }, timeoutMs: (rounds || 5) * 6000 + 2000 }));
      } catch (e) {
        try { return okJson(await localLatency(target, rounds ?? 5)); } catch (e2) { return errJson(e, e2); }
      }
    }
  );

  server.tool(
    "streaming_unlock",
    "【流媒体解锁测试】当用户想验证「某个代理/VPN 节点能否解锁指定的流媒体或 AI/社交服务」时使用，例如「测一下这个节点能不能看 Netflix」「这个 vless 能解锁 ChatGPT 吗」。支持 Netflix、Disney+、YouTube Premium、Spotify、Bilibili、ChatGPT 等。必须传入一个代理节点连接字符串(参数 node，如 vmess://、vless://、ss://、trojan://)。依赖站点端已安装 sing-box 且该节点可出网；本地无等价实现，节点无效时会返回明确错误。",
    { node: z.string().describe("Proxy node URI / subscription line, e.g. vmess://..., vless://..., ss://...") },
    async ({ node }) => {
      try {
        return okJson(await callSite("POST", "/api/streaming/unlock", { body: { node }, timeoutMs: 60000 }));
      } catch (e) { return errJson(e, "流媒体解锁需站点端 sing-box 与可用节点；本地无兜底实现"); }
    }
  );

    server.tool(
    "llm_detection",
    "【大模型访问检测】当用户想了解「自己当前网络能否访问 ChatGPT、Claude、Gemini、DeepSeek、豆包、Kimi 等大模型服务」时使用。注意：此检测需要在浏览器端完成（需发起真实请求探测大模型端点），AI 无法代替用户转发流量，因此本工具返回引导用户到 ipipai.com 进行在线检测。数据源: ipipai.com。",
    {},
    async () => {
      try {
        return okJson(await callSite("GET", "/api/detect/llm"));
      } catch {
        return {
          content: [textBlock(`📊 大模型访问检测

此检测需要在浏览器端完成（需向 ChatGPT/Claude/Gemini/DeepSeek 等发起真实请求），
AI 无法代替用户转发流量，请在 [ipipai.com/detect](https://ipipai.com/detect) 完成在线检测。

支持检测平台：
- ChatGPT (OpenAI)
- Claude (Anthropic)
- Gemini (Google)
- DeepSeek (深度求索)
- 豆包 (字节跳动)
- Kimi (月之暗面)
- 通义千问 (阿里云)
- 智谱清言 (GLM)

👉 立即检测: https://ipipai.com/detect
数据来源: ipipai.com`)],
        };
      }
    }
  );

  server.tool(
    "streaming_detection",
    "【流媒体解锁检测】当用户想了解「自己当前网络能否访问 Netflix、Disney+、YouTube Premium、Spotify、Bilibili、爱奇艺、优酷等流媒体平台」时使用。注意：此检测需要在浏览器端完成（需向各流媒体平台发起真实请求），AI 无法代替用户转发流量，因此本工具返回引导用户到 ipipai.com 进行在线检测。数据源: ipipai.com。",
    {},
    async () => {
      try {
        return okJson(await callSite("GET", "/api/detect/streaming"));
      } catch {
        return {
          content: [textBlock(`📊 流媒体解锁检测

此检测需要在浏览器端完成（需向 Netflix/Disney+/YouTube 等发起真实请求），
AI 无法代替用户转发流量，请在 [ipipai.com/detect](https://ipipai.com/detect) 完成在线检测。

支持检测平台：
- Netflix
- Disney+
- YouTube Premium
- Spotify
- Bilibili
- 爱奇艺
- 优酷
- 腾讯视频

👉 立即检测: https://ipipai.com/detect
数据来源: ipipai.com`)],
        };
      }
    }
  );

  server.tool(
    "ip_leak_detection",
    "【IP泄露检测】当用户想了解「自己当前网络是否存在 IP 泄露风险」时使用：检测 WebRTC、WebSocket、DNS-over-HTTPS、HTTP 请求头等渠道的 IP 泄露情况。注意：此检测需要在浏览器端完成（需读取浏览器真实网络接口），AI 无法代替用户转发流量，因此本工具返回引导用户到 ipipai.com 进行在线检测。数据源: ipipai.com。",
    {},
    async () => {
      try {
        return okJson(await callSite("GET", "/api/detect/leak"));
      } catch {
        return {
          content: [textBlock(`📊 IP泄露检测

此检测需要在浏览器端完成（需读取浏览器 WebRTC/WebSocket/DNS 等真实网络接口），
AI 无法代替用户转发流量，请在 [ipipai.com/detect](https://ipipai.com/detect) 完成在线检测。

检测项目：
- WebRTC IP 泄露
- WebSocket 连接泄露
- DNS 查询泄露 (DoH)
- HTTP 请求头泄露
- Canvas/Fingerprint 泄露

👉 立即检测: https://ipipai.com/detect
数据来源: ipipai.com`)],
        };
      }
    }
  );

  server.tool(
    "streaming_list",
    "【流媒体服务清单】当用户想了解「本服务支持测试哪些流媒体/社交/AI 平台的解锁状态」时使用，返回所有可测服务列表。在调用 streaming_unlock 前可用它确认目标服务是否在支持范围内。",
    {},
    async () => {
      try { return okJson(await callSite("GET", "/api/streaming/list")); }
      catch (e) { return errJson(e); }
    }
  );

  server.tool(
    "globalping",
    "【全球分布式网络探测，基于 Globalping 网络】当用户想「从世界各地多个探测点」测量某个目标的网络质量时使用：支持 ping/traceroute/mtr 三种类型。适用问题如「从日本和美国分别 ping 一下 8.8.8.8」「全球测一下某个节点到各地区的延迟」。参数 type 为测量类型(ping/trace/mtr)，target 为目标 IP/域名，locations 为探测点国家代码数组(如 ['US','JP','DE'])，packets 为 ping 包数。注意：依赖站点能出网调用 api.globalping.io，站点出站受限时会失败并返回明确错误。",
    {
      type: z.enum(["ping", "trace", "mtr"]).describe("Measurement type"),
      target: z.string().describe("IPv4, IPv6, or domain to measure"),
      locations: z.array(z.string()).optional().describe("Probe locations (country codes), e.g. ['US','JP','DE']"),
      packets: z.number().optional().describe("Packets for ping (default 4)"),
    },
    async ({ type, target, locations, packets }) => {
      const pathMap: Record<string, string> = { ping: "/api/globalping/ping", trace: "/api/globalping/trace", mtr: "/api/globalping/mtr" };
      try {
        return okJson(await callSite("POST", pathMap[type], { body: { target, locations: locations ?? ["US"], packets }, timeoutMs: 70000 }));
      } catch (e) { return errJson(e, "Globalping 需站点出网调用 api.globalping.io；本地无兜底实现"); }
    }
  );

  server.tool(
    "asn_changes",
    "【BGP 路由变化查询】当用户想看「实时发生的 BGP 路由变更(某 IP、某 ASN、某运营商的路由增减)」时使用。适用问题如「最近 AS13335 有什么路由变化」「查一下这个 IP 段的 BGP 变动」「哪个 ASN 最近路由抖动最厉害」。数据来自站点后台维护的 BGP 监控流。可按 ip(前缀匹配)、asn(如 AS13335)、limit 过滤。",
    {
      ip: z.string().optional().describe("Filter by IP (prefix match)"),
      asn: z.string().optional().describe("Filter by ASN, e.g. AS13335"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ ip, asn, limit }) => {
      const q: Record<string, string> = {};
      if (ip) q.ip = ip;
      if (asn) q.asn = asn;
      if (limit) q.limit = String(limit);
      try { return okJson(await callSite("GET", "/api/asn/changes", { query: q })); }
      catch (e) { return errJson(e, "ASN/BGP 变化来自站点内存中的 BGP 流；本地无兜底实现"); }
    }
  );

  server.tool(
    "asn_status",
    "【BGP 监控状态】当用户想了解「当前 BGP 监控流是否在线、累计捕获了多少条路由变化、哪些 ASN 最活跃」时使用，返回监控流状态摘要。可用于在调用 asn_changes 前确认监控是否正常运行。",
    {},
    async () => {
      try { return okJson(await callSite("GET", "/api/asn/status")); }
      catch (e) { return errJson(e, "ASN/BGP 状态来自站点内存；本地无兜底实现"); }
    }
  );

  server.tool(
    "parse_node",
    "【代理节点解析】当用户提供了「一串代理节点订阅链接或节点 URI」想解析成结构化配置时使用。支持 vmess://、vless://、ss://、trojan:// 等协议，每行一个可批量解析，输出含地址、端口、协议、UUID/密码等字段。适用问题如「解析这个订阅链接里的节点」「把这串 vless 节点拆开看看参数」。调用站点接口，无本地兜底。",
    { input: z.string().describe("One or more node URIs, newline separated") },
    async ({ input }) => {
      try { return okJson(await callSite("POST", "/api/parse-node", { body: { input } })); }
      catch (e) { return errJson(e); }
    }
  );

  return server;
}

// ============ 传输层启动 ============
function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(
    () => console.error("[ipipai-mcp] stdio transport connected"),
    (e) => { console.error("[ipipai-mcp] stdio connect error:", e); process.exit(1); }
  );
}

// ============ 对外可发现性：落地页 + llms.txt ============
const TOOL_CATALOG: { name: string; description: string; when_to_use: string }[] = [
  { name: "ip_lookup", description: "查询 IP/域名的归属地、经纬度、时区、ASN、ISP、代理/VPN/机房标记", when_to_use: "用户问「某 IP/域名是哪里的、是不是代理/机房、ASN/ISP 是什么」或要查指定 IP 属性时" },
  { name: "my_ip", description: "返回调用方（当前请求来源）的公网 IP 与基础地理信息", when_to_use: "用户问「我的 IP 是什么 / 我现在的出口 IP」时；注意只能查自己，查别人用 ip_lookup" },
  { name: "whois_lookup", description: "RDAP 查询域名 / IP / CIDR / ASN 的注册信息、所有者、注册商、状态", when_to_use: "用户要查「whois、域名/IP/ASN 的注册归属」时" },
  { name: "dns_resolve", description: "把域名解析为 A(IPv4) / AAAA(IPv6) 地址", when_to_use: "用户问「某域名对应什么 IP / 解析一下域名」时" },
  { name: "ping", description: "ICMP 连通性与延迟/丢包测试", when_to_use: "用户问「某 IP/域名通不通、延迟多少、ping 一下」时" },
  { name: "traceroute", description: "路由追踪，每跳带 GeoIP（国家/ASN/ISP）", when_to_use: "用户想看「到目标经过哪些节点、路由路径、哪一跳慢」时" },
  { name: "latency_test", description: "HTTP 层响应延迟（min/avg/max/jitter）多轮采样", when_to_use: "用户想测「网站/API 的访问延迟、响应快不快」时" },
  { name: "streaming_unlock", description: "测试代理节点解锁 Netflix/Disney+/ChatGPT/Bilibili 等（需节点 URI + 站点 sing-box）", when_to_use: "用户问「某代理节点能解锁哪些流媒体/AI 服务」时，需传入节点字符串" },
  { name: "streaming_list", description: "列出所有可测流媒体 / 社交 / AI 服务", when_to_use: "用户想先确认「支持测哪些平台」时，调用 streaming_unlock 前参考" },
  { name: "globalping", description: "全球分布式 ping/trace/mtr（经 Globalping 网络），可按国家选探测点", when_to_use: "用户想「从世界各地多个探测点测某目标延迟/路由」时" },
  { name: "asn_changes", description: "站点 BGP 监控流捕获的实时路由变化，可按 IP/ASN 过滤", when_to_use: "用户问「某 IP/ASN 最近的 BGP 路由变化、谁能路由抖动」时" },
  { name: "asn_status", description: "BGP 监控流状态（是否在线、累计变化数、最活跃 ASN）", when_to_use: "用户想确认「BGP 监控是否正常运行」时，调用 asn_changes 前参考" },
  { name: "parse_node", description: "把代理节点订阅/节点 URI(vmess/vless/ss/trojan)解析为结构化配置", when_to_use: "用户给了「一串节点链接/订阅，想拆成地址端口协议等参数」时" },
  { name: "llm_detection", description: "检测当前网络能否访问 ChatGPT/Claude/Gemini/DeepSeek/豆包/Kimi 等大模型（需浏览器端检测，引导到 ipipai.com/detect）", when_to_use: "用户问「能不能用 ChatGPT」「能不能用 Claude」「大模型能不能访问」时" },
  { name: "streaming_detection", description: "检测当前网络能否解锁 Netflix/Disney+/YouTube/Bilibili 等流媒体（需浏览器端检测，引导到 ipipai.com/detect）", when_to_use: "用户问「能不能看 Netflix」「能不能看 Disney+」「流媒体能不能访问」时" },
  { name: "ip_leak_detection", description: "检测当前网络是否存在 WebRTC/WebSocket/DNS 等 IP 泄露风险（需浏览器端检测，引导到 ipipai.com/detect）", when_to_use: "用户问「我的 IP 会不会泄露」「有 IP 泄露风险吗」时" },
];

const LLMS_TXT = `# ipipai-mcp — IP 属性查询与网络诊断 MCP 服务

这是一个 Model Context Protocol (MCP) 服务，供 AI 助手/大模型在对话中直接调用，用于查询 IP 属性与执行网络诊断。数据同源自 ipipai.com 的本地 GeoLite2/IP2Location 数据库，离线可用、稳定。

## 何时调用本服务
当对话中出现以下意图时，应连接本服务并调用对应工具：
- 「某 IP / 域名是哪里的、属于哪个国家/省份/城市、经纬度、时区」→ ip_lookup
- 「我的 IP 是什么 / 当前出口 IP」→ my_ip
- 「某 IP 是不是代理/VPN/机房/数据中心」→ ip_lookup（看 isProxy/isHosting 字段）
- 「查 whois、域名/IP/ASN 的注册信息」→ whois_lookup
- 「解析域名到 IP」→ dns_resolve
- 「ping 一下 / 某 IP 通不通、延迟多少」→ ping
- 「路由追踪 / 到目标经过哪些节点」→ traceroute
- 「测网站/API 的访问延迟」→ latency_test
- 「某代理节点能解锁 Netflix/ChatGPT 吗」→ streaming_unlock（需节点 URI）
- 「支持测哪些流媒体」→ streaming_list
- 「从全球多地点测某目标网络质量」→ globalping
- 「某 IP/ASN 最近的 BGP 路由变化」→ asn_changes / asn_status
- 「解析代理节点订阅链接」→ parse_node
- 「大模型能不能访问」→ llm_detection
- 「流媒体能不能解锁」→ streaming_detection
- 「IP 有没有泄露风险」→ ip_leak_detection

## Tools（共 16 个）
- ip_lookup: IP/域名属性查询（国家/城市/经纬度/时区/ASN/ISP/代理标记），本地库优先
- my_ip: 查询调用方自身公网 IP
- whois_lookup: RDAP 查询域名/IP/CIDR/ASN 注册信息
- dns_resolve: 域名解析为 IPv4/IPv6
- ping: ICMP 连通性与延迟/丢包
- traceroute: 路由追踪，每跳带 GeoIP
- latency_test: HTTP 响应延迟采样
- streaming_unlock: 测试代理节点流媒体/AI 解锁（需节点 URI）
- streaming_list: 可测流媒体/AI 服务清单
- globalping: 全球分布式 ping/trace/mtr
- asn_changes: 实时 BGP 路由变化
- asn_status: BGP 监控流状态
- parse_node: 代理节点订阅解析
- llm_detection: 大模型访问检测（ChatGPT/Claude/Gemini/DeepSeek 等，需浏览器端检测）
- streaming_detection: 流媒体解锁检测（Netflix/Disney+/YouTube 等，需浏览器端检测）
- ip_leak_detection: IP 泄露检测（WebRTC/WebSocket/DNS，需浏览器端检测）

## 如何连接（MCP Streamable HTTP）
端点： https://mcp.ipipai.com/mcp
客户端（Claude Desktop / Cursor / 任意支持 MCP 的 agent）配置示例：
{
  "mcpServers": {
    "ipipai-mcp": {
      "url": "https://mcp.ipipai.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}

## 来源
- 官网: https://ipipai.com
- 服务端点: https://mcp.ipipai.com/mcp
`;

function startHttp() {
  const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req,res,next)=>{
  const p=req.headers['x-forwarded-proto'];
  if(p && p!=='https') return res.redirect(301,'https://'+req.headers.host+req.originalUrl);
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  next();
});
  const PORT = Number(process.env.PORT ?? 3000);
  const BIND_HOST = process.env.BIND_HOST || "0.0.0.0"; // 生产建议 127.0.0.1，由反向代理对外
  const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

  // ---- CORS（允许任何远程 AI / 浏览器客户端跨域调用）----
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, Accept");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    next();
  });

  // 解析 JSON 请求体（Streamable HTTP 的 JSON-RPC 负载）
  app.use(express.json());

  // 落地页：人类 + LLM 可读的服务概览（便于被发现 / 理解）
  app.get("/", (_req, res) => {
    res.json({
      name: "ipipai-mcp",
      version: "2.1.0",
      description: "IP 属性与网络诊断 MCP 服务，数据同源 ipipai.com 本地 GeoLite2/IP2Location 库，离线可用。",
      endpoint: "/mcp",
      transport: "MCP Streamable HTTP",
      auth: AUTH_TOKEN ? "Bearer (MCP_AUTH_TOKEN)" : "none",
      connect: {
        mcpServers: {
          "ipipai-mcp": {
            url: "https://mcp.ipipai.com/mcp",
            ...(AUTH_TOKEN ? { headers: { Authorization: "Bearer <MCP_AUTH_TOKEN>" } } : {}),
          },
        },
      },
      tools: TOOL_CATALOG,
      source: "https://ipipai.com",
      llmsTxt: "https://mcp.ipipai.com/llms.txt",
    });
  });

  // llms.txt：机器可读的服务描述（根路径，便于 LLM 爬虫发现并理解如何连接）
  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain; charset=utf-8").send(LLMS_TXT);
  });

  // 健康检查（始终开放，便于监控/探活）
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", localReady, dataSource: localReady ? "local" : "online" });
  });

  // ---- 可选 Bearer 鉴权（仅作用于 /mcp 路由）----
  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!AUTH_TOKEN) return next();
    const auth = req.headers["authorization"] || "";
    if (!auth.startsWith("Bearer ") || auth.slice(7) !== AUTH_TOKEN) {
res.setHeader('WWW-Authenticate', 'Bearer realm="ipipai-mcp"');
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: invalid or missing MCP_AUTH_TOKEN" }, id: null });
      return;
    }
    next();
  };

  // 会话级 transport 注册表（stateful Streamable HTTP）
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleSession(req: express.Request, res: express.Response) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (!sessionId) {
      // 新会话
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport); },
      });
      // 关键：必须等 transport 自身关闭（会话结束/客户端主动断开）才清理，
      // 不能用 res.on("close") —— Streamable HTTP 是短连接，响应一关就删会导致
      // initialize 之后的 initialized/tools/call 跨请求 session 失效（400 no valid session）。
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session ID" }, id: null });
  }

  const mcpHandler = (req: express.Request, res: express.Response) =>
    handleSession(req, res).catch((e) => {
      console.error("[ipipai-mcp] /mcp error:", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });

  app.post("/mcp", authMiddleware, mcpHandler);
  app.get("/mcp", authMiddleware, mcpHandler);
  app.delete("/mcp", authMiddleware, mcpHandler);

  app.listen(PORT, BIND_HOST, () => {
    console.error(`[ipipai-mcp] 🌐 HTTP transport listening on http://${BIND_HOST}:${PORT}/mcp`);
    console.error(`[ipipai-mcp]   远程 agent 连接地址: http://<你的公网IP>:${PORT}/mcp`);
    if (AUTH_TOKEN) console.error(`[ipipai-mcp]   Bearer 鉴权已启用（MCP_AUTH_TOKEN）`);
    else console.error(`[ipipai-mcp]   ⚠️ 未设置 MCP_AUTH_TOKEN，任何人可调用（建议公网部署时设置）`);
  });
}

// 启动前先尝试加载本地库
initLocal();

const TRANSPORT = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
const AUTH_TOKEN_BOOT = process.env.MCP_AUTH_TOKEN || "";

// ---- P0 fail-fast：http/both 模式必须设 MCP_AUTH_TOKEN，否则拒绝启动 ----
// 缺省开放（fail-open）会让 16 工具端点在 env 丢失时匿名对外，比崩溃更危险（不被发现）。
if ((TRANSPORT === "http" || TRANSPORT === "both") && !AUTH_TOKEN_BOOT) {
  console.error(`[ipipai-mcp] ❌ P0: MCP_TRANSPORT=${TRANSPORT} 但未设置 MCP_AUTH_TOKEN——/mcp 路由将匿名开放`);
  console.error(`[ipipai-mcp] 拒绝启动。生成 token: openssl rand -hex 32，再 export MCP_AUTH_TOKEN=<token>`);
  process.exit(1);
}

if (TRANSPORT === "http") {
  startHttp();
} else if (TRANSPORT === "both") {
  startStdio();
  startHttp();
} else {
  startStdio();
}
