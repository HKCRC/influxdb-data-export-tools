import { z } from "zod";

export const influxConfigSchema = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  org: z.string().min(1),
});

export const filterConditionSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const queryParamsSchema = z.object({
  bucket: z.string().min(1),
  measurement: z.string().min(1),
  filters: z.array(filterConditionSchema),
  start: z.string().min(1),
  stop: z.string().min(1),
});

export const downloadConfigSchema = z.object({
  format: z.enum(["csv", "csv_by_day", "xlsx_by_day"]),
  records_per_sec: z.number().finite().min(1),
});

export type InfluxConfig = z.infer<typeof influxConfigSchema>;
export type FilterCondition = z.infer<typeof filterConditionSchema>;
export type QueryParams = z.infer<typeof queryParamsSchema>;
export type DownloadConfig = z.infer<typeof downloadConfigSchema>;

export type ProgressStatus = "running" | "completed" | "cancelled" | "error";

export interface ProgressPayload {
  total_chunks: number;
  completed_chunks: number;
  total_records: number;
  percent: number;
  eta_seconds: number | null;
  status: ProgressStatus;
  message: string;
  downloadUrl?: string;
  fileName?: string;
}

export interface PreviewResult {
  columns: string[];
  rows: string[][];
}
