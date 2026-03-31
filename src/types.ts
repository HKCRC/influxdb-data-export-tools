export interface InfluxConfig {
  url: string;
  token: string;
  org: string;
}

export interface FilterCondition {
  id: string;
  key: string;
  value: string;
}

export interface QueryParams {
  bucket: string;
  measurement: string;
  filters: Array<{ key: string; value: string }>;
  start: string;
  stop: string;
}

export interface DownloadConfig {
  format: "csv" | "xlsx_by_day";
  records_per_sec: number;
}

export interface ProgressPayload {
  total_chunks: number;
  completed_chunks: number;
  total_records: number;
  percent: number;
  eta_seconds: number | null;
  status: "running" | "completed" | "cancelled" | "error";
  message: string;
}

export interface PreviewResult {
  columns: string[];
  rows: string[][];
}

export interface PreviewDebugResult {
  query: string;
  csv_head: string;
}

export type TimeRangeMode = "relative" | "absolute";

export interface TimeRange {
  mode: TimeRangeMode;
  relative: string;
  start: string;
  stop: string;
}

export const RELATIVE_OPTIONS = [
  { label: "最近 5 分钟", value: "-5m" },
  { label: "最近 15 分钟", value: "-15m" },
  { label: "最近 1 小时", value: "-1h" },
  { label: "最近 6 小时", value: "-6h" },
  { label: "最近 12 小时", value: "-12h" },
  { label: "最近 1 天", value: "-1d" },
  { label: "最近 3 天", value: "-3d" },
  { label: "最近 7 天", value: "-7d" },
  { label: "最近 30 天", value: "-30d" },
];

export const DEFAULT_CONFIG: InfluxConfig = {
  url: "http://localhost:8086",
  token: "",
  org: "",
};

export const DEFAULT_DOWNLOAD_CONFIG: DownloadConfig = {
  format: "csv",
  records_per_sec: 3000,
};
