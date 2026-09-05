import { S3Config } from "./types";

/** OSS uses its S3 compatibility API, not the native OSS signature protocol. */
export function resolveStorageConfig(config: S3Config): S3Config {
  if (config.provider !== "oss") return { ...config };
  const region = config.region.trim().replace(/^oss-/, "");
  if (!/^[a-z]{2,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region)) {
    throw new Error("OSS Region 无效 / Invalid OSS region (e.g. cn-hangzhou)");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucketName)) {
    throw new Error("OSS Bucket 名称无效 / Invalid OSS bucket name");
  }
  return { ...config, region, endpoint: `https://s3.oss-${region}.aliyuncs.com` };
}

export function storageAddressing(config: S3Config): "path" | "virtual" {
  return config.provider === "oss" ? "virtual" : "path";
}

export function encodeObjectKey(key: string): string {
  return key.split("/").map(part => encodeURIComponent(part)
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

export function storageRequestUrl(config: S3Config, key = ""): string {
  const resolved = resolveStorageConfig(config);
  // URL normalizes dot segments; reject them rather than targeting a different object.
  if (key.split("/").some(part => part === "." || part === "..")) {
    throw new Error("对象路径不能包含 . 或 .. / Object key cannot contain dot segments");
  }
  const endpoint = new URL(resolved.endpoint);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("无效的存储端点 / Invalid storage endpoint");
  }
  if (storageAddressing(config) === "virtual") {
    endpoint.hostname = `${resolved.bucketName}.${endpoint.hostname}`;
    return `${endpoint.origin}/${encodeObjectKey(key)}`;
  }
  return `${resolved.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(resolved.bucketName)}/${encodeObjectKey(key)}`;
}
