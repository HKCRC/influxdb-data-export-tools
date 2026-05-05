import fs from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";
import ExcelJS from "exceljs";
import { v4 as uuidv4 } from "uuid";
import { buildKeepIndices, InfluxClient, isRepeatedHeader, parseInfluxCsv } from "./influx.js";
import type { DownloadConfig, InfluxConfig, ProgressPayload, QueryParams } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ROOT = path.resolve(__dirname, "../tmp/exports");
const CHUNK_MINUTES = 10;
const MAX_SHEET_ROWS = 1_048_576;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

type JobStatus = "running" | "completed" | "cancelled" | "error";
type ProgressListener = (payload: ProgressPayload) => void;

interface ExportJob {
  id: string;
  status: JobStatus;
  dir: string;
  filePath?: string;
  fileName?: string;
  totalChunks: number;
  completedChunks: number;
  totalRecords: number;
  progress?: ProgressPayload;
  error?: string;
  cancelRequested: boolean;
  controller: AbortController;
  listeners: Set<ProgressListener>;
  createdAt: number;
}

const jobs = new Map<string, ExportJob>();

export async function createExportJob(
  config: InfluxConfig,
  params: QueryParams,
  downloadConfig: DownloadConfig,
): Promise<{ jobId: string }> {
  await mkdir(EXPORT_ROOT, { recursive: true });

  const jobId = uuidv4();
  const dir = path.join(EXPORT_ROOT, jobId);
  await mkdir(dir, { recursive: true });

  const chunks = buildTimeChunks(params.start, params.stop, CHUNK_MINUTES);
  if (chunks.length === 0) {
    throw new Error("时间范围计算失败，请检查开始/结束时间");
  }

  const job: ExportJob = {
    id: jobId,
    status: "running",
    dir,
    totalChunks: chunks.length,
    completedChunks: 0,
    totalRecords: 0,
    cancelRequested: false,
    controller: new AbortController(),
    listeners: new Set(),
    createdAt: Date.now(),
  };

  jobs.set(jobId, job);

  void runExportJob(job, config, params, normalizeDownloadConfig(downloadConfig), chunks);
  return { jobId };
}

export function getJob(jobId: string): ExportJob | undefined {
  return jobs.get(jobId);
}

export function subscribeToJob(jobId: string, listener: ProgressListener): () => void {
  const job = requireJob(jobId);
  job.listeners.add(listener);
  if (job.progress) listener(job.progress);

  return () => {
    job.listeners.delete(listener);
  };
}

export function cancelJob(jobId: string): void {
  const job = requireJob(jobId);
  if (job.status !== "running") return;
  job.cancelRequested = true;
  job.controller.abort();
}

export async function cleanupOldExports(): Promise<void> {
  await mkdir(EXPORT_ROOT, { recursive: true });
  const entries = await readdir(EXPORT_ROOT, { withFileTypes: true });
  const now = Date.now();

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const fullPath = path.join(EXPORT_ROOT, entry.name);
        const info = await stat(fullPath);
        if (now - info.mtimeMs > EXPORT_TTL_MS) {
          await rm(fullPath, { recursive: true, force: true });
          jobs.delete(entry.name);
        }
      }),
  );
}

function requireJob(jobId: string): ExportJob {
  const job = jobs.get(jobId);
  if (!job) throw new Error("任务不存在或已过期");
  return job;
}

async function runExportJob(
  job: ExportJob,
  config: InfluxConfig,
  params: QueryParams,
  downloadConfig: DownloadConfig,
  chunks: Array<[string, string]>,
): Promise<void> {
  const client = new InfluxClient(config);
  const rps = downloadConfig.records_per_sec;

  let writer: ExportWriter | null = null;
  try {
    writer = createWriter(job, downloadConfig.format);

    emit(job, {
      status: "running",
      message: `准备导出：共 ${chunks.length} 块`,
      eta_seconds: null,
    });

    for (let i = 0; i < chunks.length; i += 1) {
      if (job.cancelRequested) throw new CancelledError();

      const [start, stop] = chunks[i]!;
      const chunkParams = { ...params, start, stop };
      const started = Date.now();
      const csvText = await client.queryCsv(chunkParams, job.controller.signal);
      const records = parseChunkRows(csvText);
      const chunkRecords = await writer.writeRows(records);

      job.completedChunks = i + 1;
      job.totalRecords += chunkRecords;

      const avgRecordsPerChunk = job.totalRecords / job.completedChunks;
      const estimatedTotalRecords = Math.round(avgRecordsPerChunk * chunks.length);
      const remainingRecords = Math.max(0, estimatedTotalRecords - job.totalRecords);
      const etaSeconds = Math.ceil(remainingRecords / rps);

      emit(job, {
        status: "running",
        message: `下载中：${job.completedChunks}/${job.totalChunks} 块`,
        eta_seconds: etaSeconds,
      });

      const targetMs = chunkRecords > 0 ? (chunkRecords / rps) * 1000 : 0;
      const elapsedMs = Date.now() - started;
      if (i < chunks.length - 1 && targetMs > elapsedMs) {
        await sleep(targetMs - elapsedMs);
      }
    }

    const result = await writer.finish();
    job.status = "completed";
    job.filePath = result.filePath;
    job.fileName = result.fileName;
    emit(job, {
      status: "completed",
      message: `下载完成！共 ${job.totalRecords} 条记录已保存到文件`,
      eta_seconds: 0,
      downloadUrl: `/api/exports/${job.id}/download`,
      fileName: result.fileName,
    });
  } catch (error) {
    if (writer) await writer.abort();

    if (error instanceof CancelledError || job.cancelRequested || job.controller.signal.aborted) {
      job.status = "cancelled";
      await rm(job.dir, { recursive: true, force: true });
      emit(job, {
        status: "cancelled",
        message: "下载已取消",
        eta_seconds: null,
      });
      return;
    }

    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
    emit(job, {
      status: "error",
      message: job.error,
      eta_seconds: null,
    });
  }
}

interface RowBatch {
  header: string[];
  rows: string[][];
  timeIndex: number;
}

function parseChunkRows(csvText: string): RowBatch {
  const records = parseInfluxCsv(csvText);
  if (records.length === 0) {
    return { header: [], rows: [], timeIndex: -1 };
  }

  let header = records[0] ?? [];
  let keep = buildKeepIndices(header);
  let outputHeader = keep.map((idx) => header[idx] ?? "");
  let timeIndex = outputHeader.findIndex((name) => name === "_time");
  const rows: string[][] = [];

  for (const record of records.slice(1)) {
    if (isRepeatedHeader(record, header)) {
      header = record;
      keep = buildKeepIndices(header);
      outputHeader = keep.map((idx) => header[idx] ?? "");
      timeIndex = outputHeader.findIndex((name) => name === "_time");
      continue;
    }

    const row = keep.map((idx) => record[idx] ?? "");
    if (row.every((value) => value === "")) continue;
    if (timeIndex >= 0) {
      row[timeIndex] = utcToLocalRfc3339(row[timeIndex] ?? "");
    }
    rows.push(row);
  }

  return { header: outputHeader, rows, timeIndex };
}

interface ExportWriter {
  writeRows(batch: RowBatch): Promise<number>;
  finish(): Promise<{ filePath: string; fileName: string }>;
  abort(): Promise<void>;
}

class CsvAllWriter implements ExportWriter {
  private readonly filePath: string;
  private readonly stream: fs.WriteStream;
  private headerWritten = false;

  constructor(job: ExportJob) {
    this.filePath = path.join(job.dir, "data.csv");
    this.stream = fs.createWriteStream(this.filePath);
  }

  async writeRows(batch: RowBatch): Promise<number> {
    if (batch.header.length === 0) return 0;
    if (!this.headerWritten) {
      this.stream.write(`${toCsvLine(batch.header)}\n`);
      this.headerWritten = true;
    }
    for (const row of batch.rows) {
      this.stream.write(`${toCsvLine(row)}\n`);
    }
    return batch.rows.length;
  }

  async finish(): Promise<{ filePath: string; fileName: string }> {
    await endStream(this.stream);
    return { filePath: this.filePath, fileName: path.basename(this.filePath) };
  }

  async abort(): Promise<void> {
    this.stream.destroy();
    await rm(path.dirname(this.filePath), { recursive: true, force: true });
  }
}

class CsvByDayWriter implements ExportWriter {
  private readonly files = new Map<string, { filePath: string; stream: fs.WriteStream; headerWritten: boolean }>();

  constructor(private readonly job: ExportJob) {}

  async writeRows(batch: RowBatch): Promise<number> {
    if (batch.header.length === 0 || batch.timeIndex < 0) return 0;

    for (const row of batch.rows) {
      const date = extractLocalDate(row[batch.timeIndex] ?? "");
      const target = this.ensureFile(date);
      if (!target.headerWritten) {
        target.stream.write(`${toCsvLine(batch.header)}\n`);
        target.headerWritten = true;
      }
      target.stream.write(`${toCsvLine(row)}\n`);
    }

    return batch.rows.length;
  }

  async finish(): Promise<{ filePath: string; fileName: string }> {
    for (const target of this.files.values()) {
      await endStream(target.stream);
    }

    if (this.files.size === 1) {
      const only = [...this.files.values()][0]!;
      return { filePath: only.filePath, fileName: path.basename(only.filePath) };
    }

    const zipPath = path.join(this.job.dir, "data_by_day.zip");
    await zipFiles(
      [...this.files.values()].map((file) => file.filePath),
      zipPath,
    );
    return { filePath: zipPath, fileName: path.basename(zipPath) };
  }

  async abort(): Promise<void> {
    for (const target of this.files.values()) {
      target.stream.destroy();
    }
    await rm(this.job.dir, { recursive: true, force: true });
  }

  private ensureFile(date: string): { filePath: string; stream: fs.WriteStream; headerWritten: boolean } {
    const existing = this.files.get(date);
    if (existing) return existing;

    const filePath = path.join(this.job.dir, `data_${date}.csv`);
    const target = { filePath, stream: fs.createWriteStream(filePath), headerWritten: false };
    this.files.set(date, target);
    return target;
  }
}

class XlsxByDayWriter implements ExportWriter {
  private readonly filePath: string;
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sheets = new Map<string, { worksheet: StreamingWorksheet; rows: number; part: number }>();

  constructor(job: ExportJob) {
    this.filePath = path.join(job.dir, "data_by_day.xlsx");
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: this.filePath,
      useSharedStrings: false,
      useStyles: false,
    });
  }

  async writeRows(batch: RowBatch): Promise<number> {
    if (batch.header.length === 0 || batch.timeIndex < 0) return 0;

    for (const row of batch.rows) {
      const date = extractLocalDate(row[batch.timeIndex] ?? "");
      const target = this.ensureSheet(date, batch.header);
      if (target.rows >= MAX_SHEET_ROWS) {
        const next = this.ensureSheet(date, batch.header, target.part + 1);
        next.worksheet.addRow(row).commit();
        next.rows += 1;
        continue;
      }

      target.worksheet.addRow(row).commit();
      target.rows += 1;
    }

    return batch.rows.length;
  }

  async finish(): Promise<{ filePath: string; fileName: string }> {
    await this.workbook.commit();
    return { filePath: this.filePath, fileName: path.basename(this.filePath) };
  }

  async abort(): Promise<void> {
    await rm(path.dirname(this.filePath), { recursive: true, force: true });
  }

  private ensureSheet(date: string, header: string[], requestedPart = 1) {
    let part = requestedPart;
    let key = sheetKey(date, part);
    while (this.sheets.has(key) && this.sheets.get(key)!.rows >= MAX_SHEET_ROWS) {
      part += 1;
      key = sheetKey(date, part);
    }

    const existing = this.sheets.get(key);
    if (existing) return existing;

    const worksheet = this.workbook.addWorksheet(key) as StreamingWorksheet;
    worksheet.addRow(header).commit();
    const target = { worksheet, rows: 1, part };
    this.sheets.set(key, target);
    return target;
  }
}

interface StreamingWorksheet {
  addRow(values: string[]): { commit(): void };
}

function createWriter(job: ExportJob, format: DownloadConfig["format"]): ExportWriter {
  if (format === "xlsx_by_day") return new XlsxByDayWriter(job);
  if (format === "csv_by_day") return new CsvByDayWriter(job);
  return new CsvAllWriter(job);
}

function normalizeDownloadConfig(config: DownloadConfig): DownloadConfig {
  return {
    ...config,
    records_per_sec: Math.max(100, Math.min(5000, Math.floor(config.records_per_sec || 3000))),
  };
}

function emit(
  job: ExportJob,
  patch: Pick<ProgressPayload, "status" | "message" | "eta_seconds"> & Partial<ProgressPayload>,
): void {
  const payload: ProgressPayload = {
    total_chunks: job.totalChunks,
    completed_chunks: job.completedChunks,
    total_records: job.totalRecords,
    percent: job.totalChunks === 0 ? 0 : (job.completedChunks * 100) / job.totalChunks,
    ...patch,
  };
  job.progress = payload;
  for (const listener of job.listeners) listener(payload);
}

function buildTimeChunks(start: string, stop: string, chunkMinutes: number): Array<[string, string]> {
  const startDate = parseTime(start);
  const stopDate = stop === "now()" || stop === "" ? new Date() : parseTime(stop);
  if (startDate >= stopDate) throw new Error("开始时间必须早于结束时间");

  const chunks: Array<[string, string]> = [];
  let cursor = startDate.getTime();
  const end = stopDate.getTime();
  const chunkMs = chunkMinutes * 60 * 1000;

  while (cursor < end) {
    const next = Math.min(cursor + chunkMs, end);
    chunks.push([new Date(cursor).toISOString(), new Date(next).toISOString()]);
    cursor = next;
  }

  return chunks;
}

function parseTime(value: string): Date {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) {
    return new Date(Date.now() - parseRelativeDurationMs(trimmed.slice(1)));
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间 '${value}'`);
  return date;
}

function parseRelativeDurationMs(value: string): number {
  const match = value.match(/^(\d+)(mo|[wdhm])$/);
  if (!match) throw new Error(`不支持的相对时间格式: -${value}`);

  const amount = Number(match[1]);
  const unit = match[2];
  const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : unit === "d" ? amount * 1440 : unit === "w" ? amount * 10080 : amount * 43200;
  return minutes * 60 * 1000;
}

function utcToLocalRfc3339(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(offsetAbs / 60))}:${pad(offsetAbs % 60)}`;
  const millis = String(date.getMilliseconds()).padStart(3, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${millis}${offset}`;
}

function extractLocalDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return utcToLocalRfc3339(value).slice(0, 10);
}

function sheetKey(date: string, part: number): string {
  return part === 1 ? date : `${date}_${part}`;
}

function toCsvLine(values: string[]): string {
  return values
    .map((value) => {
      if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
      return value;
    })
    .join(",");
}

function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function zipFiles(files: string[], zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.once("close", resolve);
    archive.once("error", reject);
    archive.pipe(output);
    for (const file of files) {
      archive.file(file, { name: path.basename(file) });
    }
    void archive.finalize();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

class CancelledError extends Error {}
