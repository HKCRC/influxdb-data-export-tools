import { parse } from "csv-parse/sync";
import type { FilterCondition, InfluxConfig, PreviewResult, QueryParams } from "./types.js";

interface QueryRequest {
  query: string;
  dialect: {
    annotations: string[];
    header: boolean;
    delimiter: string;
  };
}

export class InfluxClient {
  constructor(private readonly config: InfluxConfig) {}

  async testConnection(): Promise<string> {
    const resp = await fetch(`${trimUrl(this.config.url)}/health`, {
      headers: { Authorization: this.authHeader() },
    });

    if (!resp.ok) {
      throw new Error(`连接失败: HTTP ${resp.status} - ${await resp.text()}`);
    }

    return "连接成功！InfluxDB 服务正常运行";
  }

  async getBuckets(): Promise<string[]> {
    const url = new URL(`${trimUrl(this.config.url)}/api/v2/buckets`);
    url.searchParams.set(looksLikeOrgId(this.config.org) ? "orgID" : "org", this.config.org);
    url.searchParams.set("limit", "100");

    const data = await this.requestJson<{ buckets?: Array<{ name: string }> }>(url);
    return (data.buckets ?? [])
      .map((bucket) => bucket.name)
      .filter((name) => !name.startsWith("_"))
      .sort();
  }

  async getMeasurements(bucket: string): Promise<string[]> {
    const query = `import "influxdata/influxdb/schema"\nschema.measurements(bucket: "${escapeFlux(bucket)}")`;
    const csv = await this.fluxQuery(query);
    return parseCsvColumn(csv, "_value");
  }

  async getTagKeys(bucket: string, measurement: string): Promise<string[]> {
    const query = `import "influxdata/influxdb/schema"\nschema.tagKeys(
  bucket: "${escapeFlux(bucket)}",
  predicate: (r) => r._measurement == "${escapeFlux(measurement)}",
  start: -30d
)`;
    const keys = parseCsvColumn(await this.fluxQuery(query), "_value");
    return keys.filter((key) => !key.startsWith("_"));
  }

  async getTagValues(
    bucket: string,
    measurement: string,
    tag: string,
    filters: FilterCondition[],
  ): Promise<string[]> {
    let predicate = `r._measurement == "${escapeFlux(measurement)}"`;
    for (const filter of filters) {
      predicate += ` and r["${escapeFlux(filter.key)}"] == "${escapeFlux(filter.value)}"`;
    }

    const query = `import "influxdata/influxdb/schema"\nschema.tagValues(
  bucket: "${escapeFlux(bucket)}",
  tag: "${escapeFlux(tag)}",
  predicate: (r) => ${predicate},
  start: -30d
)`;
    return parseCsvColumn(await this.fluxQuery(query), "_value");
  }

  buildFluxQuery(params: QueryParams): string {
    let query = `from(bucket: "${escapeFlux(params.bucket)}")
  |> range(start: ${params.start}, stop: ${params.stop})
  |> filter(fn: (r) => r["_measurement"] == "${escapeFlux(params.measurement)}")`;

    for (const filter of params.filters) {
      if (filter.key && filter.value) {
        query += `\n  |> filter(fn: (r) => r["${escapeFlux(filter.key)}"] == "${escapeFlux(filter.value)}")`;
      }
    }

    query += `
  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> drop(columns: ["result", "table", "_start", "_stop", "_measurement"])`;

    return query;
  }

  async previewQuery(params: QueryParams): Promise<PreviewResult> {
    const csv = await this.fluxQuery(`${this.buildFluxQuery(params)}\n  |> limit(n: 100)`);
    return csvToPreview(csv, 100);
  }

  async queryCsv(params: QueryParams, signal?: AbortSignal): Promise<string> {
    return this.fluxQuery(this.buildFluxQuery(params), signal);
  }

  private async fluxQuery(query: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(`${trimUrl(this.config.url)}/api/v2/query`);
    url.searchParams.set(looksLikeOrgId(this.config.org) ? "orgID" : "org", this.config.org);

    const body: QueryRequest = {
      query,
      dialect: {
        annotations: ["group", "datatype", "default"],
        header: true,
        delimiter: ",",
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      throw new Error(`查询失败: HTTP ${resp.status} - ${await resp.text()}`);
    }

    return resp.text();
  }

  private async requestJson<T>(url: URL): Promise<T> {
    const resp = await fetch(url, {
      headers: { Authorization: this.authHeader() },
    });

    if (!resp.ok) {
      throw new Error(`请求失败: HTTP ${resp.status} - ${await resp.text()}`);
    }

    return resp.json() as Promise<T>;
  }

  private authHeader(): string {
    return `Token ${this.config.token}`;
  }
}

export function csvToPreview(csvText: string, limit: number): PreviewResult {
  const records = parseInfluxCsv(csvText);
  if (records.length === 0) return { columns: [], rows: [] };

  const header = records[0] ?? [];
  const keep = buildKeepIndices(header);
  const columns = keep.map((idx) => header[idx] ?? "");
  const rows: string[][] = [];

  for (const record of records.slice(1)) {
    if (isRepeatedHeader(record, header)) continue;
    const row = keep.map((idx) => record[idx] ?? "");
    if (row.every((value) => value === "")) continue;
    rows.push(row);
    if (rows.length >= limit) break;
  }

  return { columns, rows };
}

export function parseInfluxCsv(csvText: string): string[][] {
  const cleaned = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");

  if (!cleaned) return [];

  return parse(cleaned, {
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];
}

export function buildKeepIndices(header: string[]): number[] {
  const keep: number[] = [];
  for (let i = 0; i < header.length; i += 1) {
    const name = (header[i] ?? "").trim();
    if (!name || name === "result" || name === "table") continue;
    keep.push(i);
  }
  return keep;
}

export function isRepeatedHeader(record: string[], header: string[]): boolean {
  return record.length === header.length && record.every((value, idx) => value === header[idx]);
}

function parseCsvColumn(csvText: string, colName: string): string[] {
  const values = new Set<string>();
  let header: string[] | null = null;
  let idx = -1;

  for (const record of parseInfluxCsv(csvText)) {
    if (!header || isRepeatedHeader(record, header)) {
      header = record;
      idx = record.findIndex((value) => value.trim() === colName);
      continue;
    }

    if (idx >= 0) {
      const value = (record[idx] ?? "").trim();
      if (value) values.add(value);
    }
  }

  return [...values].sort();
}

function escapeFlux(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function looksLikeOrgId(value: string): boolean {
  const trimmed = value.trim();
  return [16, 24, 32].includes(trimmed.length) && /^[0-9a-fA-F]+$/.test(trimmed);
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
