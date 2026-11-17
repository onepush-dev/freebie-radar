import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { config, isPublicSite } from "./config.ts";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(network, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16]] as const) blocked.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
  return false;
}

export function validateWebhookUrl(raw: string, allowPrivate = !isPublicSite && config.webhookAllowPrivate): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Webhook 地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || raw.length > 500) {
    throw new Error("Webhook 必须是无用户名、密码或片段的 HTTP(S) 地址");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || (isIP(host) && !isPublicAddress(host)))) {
    throw new Error("Webhook 不允许访问本机、内网或保留地址");
  }
  return url;
}

export type ResolvedAddress = { address: string; family: number };
export async function resolveWebhookTarget(url: URL, resolver = lookup, allowPrivate = !isPublicSite && config.webhookAllowPrivate): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host, { all: true, verbatim: true });
  if (!addresses.length || (!allowPrivate && addresses.some((a) => !isPublicAddress(a.address)))) {
    throw new Error("Webhook 域名解析到了内网或保留地址");
  }
  return addresses[0]!;
}

/** DNS validated once, then pinned in the actual socket lookup; redirects are never followed. */
export async function postWebhook(urlString: string, text: string, secret = "", resolver = lookup): Promise<void> {
  const url = validateWebhookUrl(urlString);
  const signal = AbortSignal.timeout(15_000);
  const target = await Promise.race([
    resolveWebhookTarget(url, resolver),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Webhook DNS 查询超时")), { once: true })),
  ]);
  await new Promise<void>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(url, {
      method: "POST",
      agent: false,
      signal,
      headers: { "content-type": "application/json", ...(secret ? { "x-radar-secret": secret } : {}) },
      lookup: (_hostname, options, callback) => {
        if (options.all) {
          (callback as unknown as (err: null, addresses: ResolvedAddress[]) => void)(null, [target]);
        } else callback(null, target.address, target.family);
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      if (status >= 200 && status < 300) resolve();
      else reject(new Error(status >= 300 && status < 400 ? "Webhook 不允许重定向，请填写最终地址" : `Webhook 返回 ${status}`));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ source: "freebie-radar", text, sentAt: new Date().toISOString() }));
  });
}
