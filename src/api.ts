import {
  DownloadConfig,
  FilterCondition,
  InfluxConfig,
  PreviewResult,
  QueryParams,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3001";

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(data?.error ?? `请求失败: HTTP ${resp.status}`);
  }

  return data as T;
}

export const apiBase = API_BASE;

export async function testConnection(config: InfluxConfig): Promise<string> {
  const data = await postJson<{ message: string }>("/api/influx/test-connection", { config });
  return data.message;
}

export async function getBuckets(config: InfluxConfig): Promise<string[]> {
  const data = await postJson<{ buckets: string[] }>("/api/influx/buckets", { config });
  return data.buckets;
}

export async function getMeasurements(config: InfluxConfig, bucket: string): Promise<string[]> {
  const data = await postJson<{ measurements: string[] }>("/api/influx/measurements", {
    config,
    bucket,
  });
  return data.measurements;
}

export async function getTagKeys(
  config: InfluxConfig,
  bucket: string,
  measurement: string,
): Promise<string[]> {
  const data = await postJson<{ tagKeys: string[] }>("/api/influx/tag-keys", {
    config,
    bucket,
    measurement,
  });
  return data.tagKeys;
}

export async function getTagValues(
  config: InfluxConfig,
  bucket: string,
  measurement: string,
  tag: string,
  filters: Array<Pick<FilterCondition, "key" | "value">>,
): Promise<string[]> {
  const data = await postJson<{ tagValues: string[] }>("/api/influx/tag-values", {
    config,
    bucket,
    measurement,
    tag,
    filters,
  });
  return data.tagValues;
}

export async function previewQuery(
  config: InfluxConfig,
  params: QueryParams,
): Promise<PreviewResult> {
  return postJson<PreviewResult>("/api/influx/preview", { config, params });
}

export async function startExport(
  config: InfluxConfig,
  params: QueryParams,
  downloadConfig: DownloadConfig,
): Promise<{ jobId: string }> {
  return postJson<{ jobId: string }>("/api/exports", { config, params, downloadConfig });
}

export async function cancelExport(jobId: string): Promise<void> {
  await postJson<{ ok: boolean }>(`/api/exports/${jobId}/cancel`, {});
}

export function exportEventsUrl(jobId: string): string {
  return `${API_BASE}/api/exports/${jobId}/events`;
}

export function exportDownloadUrl(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE}${pathOrUrl}`;
}
