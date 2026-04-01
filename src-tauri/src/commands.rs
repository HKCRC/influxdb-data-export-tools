use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::collections::HashMap;
use std::time::Instant;
use std::time::Duration;

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::influxdb::InfluxClient;

// ──────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfluxConfig {
    pub url: String,
    pub token: String,
    pub org: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterCondition {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryParams {
    pub bucket: String,
    pub measurement: String,
    pub filters: Vec<FilterCondition>,
    pub start: String,
    pub stop: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadConfig {
    pub format: String, // "csv" | "xlsx_by_day"
    pub records_per_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub total_chunks: u64,
    pub completed_chunks: u64,
    pub total_records: u64,
    pub percent: f64,
    pub eta_seconds: Option<u64>,
    pub status: String,
    pub message: String,
}

// ──────────────────────────────────────────────
// App state (for download cancellation)
// ──────────────────────────────────────────────

pub struct AppState {
    pub cancel_flag: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            cancel_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

// ──────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn test_connection(config: InfluxConfig) -> Result<String, String> {
    InfluxClient::new(&config).test_connection().await
}

#[tauri::command]
pub async fn get_buckets(config: InfluxConfig) -> Result<Vec<String>, String> {
    InfluxClient::new(&config).get_buckets().await
}

#[tauri::command]
pub async fn get_measurements(
    config: InfluxConfig,
    bucket: String,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config).get_measurements(&bucket).await
}

#[tauri::command]
pub async fn get_tag_keys(
    config: InfluxConfig,
    bucket: String,
    measurement: String,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config)
        .get_tag_keys(&bucket, &measurement)
        .await
}

#[tauri::command]
pub async fn get_tag_values(
    config: InfluxConfig,
    bucket: String,
    measurement: String,
    tag: String,
    filters: Vec<FilterCondition>,
) -> Result<Vec<String>, String> {
    InfluxClient::new(&config)
        .get_tag_values(&bucket, &measurement, &tag, &filters)
        .await
}

#[tauri::command]
pub async fn preview_query(
    config: InfluxConfig,
    params: QueryParams,
) -> Result<serde_json::Value, String> {
    InfluxClient::new(&config).preview_query(&params).await
}

#[tauri::command]
pub async fn preview_query_debug(
    config: InfluxConfig,
    params: QueryParams,
) -> Result<serde_json::Value, String> {
    let client = InfluxClient::new(&config);
    let mut query = client.build_flux_query(&params);
    query.push_str("\n  |> limit(n: 5)");
    let csv = client.flux_query_raw(&query).await?;

    let head: Vec<&str> = csv.lines().take(30).collect();
    Ok(serde_json::json!({
        "query": query,
        "csv_head": head.join("\n")
    }))
}

#[tauri::command]
pub async fn start_download(
    app: AppHandle,
    config: InfluxConfig,
    params: QueryParams,
    file_path: String,
    download_config: DownloadConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.cancel_flag.store(false, Ordering::SeqCst);
    let cancel_flag = state.cancel_flag.clone();

    let client = InfluxClient::new(&config);
    // Keep chunking internal; the user controls server load via records_per_sec.
    const CHUNK_MINUTES: u64 = 10;
    let chunks = build_time_chunks(&params.start, &params.stop, CHUNK_MINUTES)?;
    let total_chunks = chunks.len() as u64;

    if total_chunks == 0 {
        return Err("时间范围计算失败，请检查开始/结束时间".to_string());
    }

    let mut total_records = 0u64;
    let is_xlsx = download_config.format == "xlsx_by_day";
    let rps = download_config.records_per_sec.clamp(100, 5000);
    let mut avg_records_per_chunk: f64 = 0.0;

    // CSV writer state
    let mut header_written = false;
    let mut writer: Option<std::io::BufWriter<std::fs::File>> = None;

    // XLSX writer state (kept in memory until save at end)
    let mut xlsx_state: Option<XlsxByDayState> = None;

    if !is_xlsx {
        let file = std::fs::File::create(&file_path)
            .map_err(|e| format!("创建文件失败: {}", e))?;
        writer = Some(std::io::BufWriter::new(file));
    } else {
        xlsx_state = Some(XlsxByDayState::new());
    }

    for (i, (chunk_start, chunk_stop)) in chunks.iter().enumerate() {
        if cancel_flag.load(Ordering::SeqCst) {
            let _ = app.emit(
                "download-progress",
                ProgressPayload {
                    total_chunks,
                    completed_chunks: i as u64,
                    total_records,
                    percent: if total_chunks == 0 {
                        0.0
                    } else {
                        (i as f64) * 100.0 / (total_chunks as f64)
                    },
                    eta_seconds: None,
                    status: "cancelled".to_string(),
                    message: "下载已取消".to_string(),
                },
            );
            return Ok(());
        }

        let mut chunk_params = params.clone();
        chunk_params.start = chunk_start.clone();
        chunk_params.stop = chunk_stop.clone();

        let started = Instant::now();
        let csv_text = match client.query_csv(&chunk_params).await {
            Ok(t) => t,
            Err(e) => {
                let _ = app.emit(
                    "download-progress",
                    ProgressPayload {
                        total_chunks,
                        completed_chunks: i as u64,
                        total_records,
                        percent: if total_chunks == 0 {
                            0.0
                        } else {
                            (i as f64) * 100.0 / (total_chunks as f64)
                        },
                        eta_seconds: None,
                        status: "error".to_string(),
                        message: format!("块 {} 下载失败: {}", i + 1, e),
                    },
                );
                return Err(e);
            }
        };

        let chunk_records = if !is_xlsx {
            let w = writer.as_mut().ok_or("内部错误: CSV writer 未初始化")?;
            write_csv_chunk(w, &csv_text, &mut header_written)
                .map_err(|e| format!("写文件失败: {}", e))?
        } else {
            let st = xlsx_state
                .as_mut()
                .ok_or("内部错误: XLSX state 未初始化")?;
            st.write_csv_chunk_by_day(&csv_text)
                .map_err(|e| format!("写文件失败: {}", e))?
        };
        total_records += chunk_records;
        avg_records_per_chunk = total_records as f64 / ((i + 1) as f64);
        let est_total_records = (avg_records_per_chunk * (total_chunks as f64)).round() as u64;
        let est_remaining_records = est_total_records.saturating_sub(total_records);
        let eta_seconds = Some((est_remaining_records as f64 / (rps as f64)).ceil() as u64);
        let percent = if total_chunks == 0 {
            0.0
        } else {
            ((i + 1) as f64) * 100.0 / (total_chunks as f64)
        };

        let _ = app.emit(
            "download-progress",
            ProgressPayload {
                total_chunks,
                completed_chunks: (i + 1) as u64,
                total_records,
                percent,
                eta_seconds,
                status: "running".to_string(),
                message: format!(
                    "下载中：{}/{} 块",
                    i + 1,
                    total_chunks,
                ),
            },
        );

        // Rate limit by records/second (best-effort).
        // We include query+write time in the budget; if it's already slow, we don't sleep extra.
        if i < chunks.len() - 1 && chunk_records > 0 {
            let target = Duration::from_secs_f64((chunk_records as f64) / (rps as f64));
            let elapsed = started.elapsed();
            if target > elapsed {
                tokio::time::sleep(target - elapsed).await;
            }
        }
    }

    if !is_xlsx {
        if let Some(mut w) = writer {
            w.flush()
                .map_err(|e| format!("刷新文件缓冲区失败: {}", e))?;
        }
    } else if let Some(st) = xlsx_state {
        st.save(&file_path)
            .map_err(|e| format!("保存 XLSX 失败: {}", e))?;
    }

    let _ = app.emit(
        "download-progress",
        ProgressPayload {
            total_chunks,
            completed_chunks: total_chunks,
            total_records,
            percent: 100.0,
            eta_seconds: Some(0),
            status: "completed".to_string(),
            message: format!("下载完成！共 {} 条记录已保存到文件", total_records),
        },
    );

    Ok(())
}

struct XlsxByDayState {
    workbook: rust_xlsxwriter::Workbook,
    sheet_map: HashMap<String, usize>, // date -> index in `worksheets`
    worksheets: Vec<rust_xlsxwriter::Worksheet>,
    next_row: Vec<u32>,                // per-sheet row cursor
    header_written: Vec<bool>,         // per-sheet header written
    header: Option<Vec<String>>,       // cleaned header columns
    keep_idxs: Vec<usize>,             // indices to keep from raw csv record
    time_col_idx_in_keep: Option<usize>,
}

impl XlsxByDayState {
    fn new() -> Self {
        Self {
            workbook: rust_xlsxwriter::Workbook::new(),
            sheet_map: HashMap::new(),
            worksheets: vec![],
            next_row: vec![],
            header_written: vec![],
            header: None,
            keep_idxs: vec![],
            time_col_idx_in_keep: None,
        }
    }

    fn ensure_sheet(&mut self, date: &str) -> usize {
        if let Some(&idx) = self.sheet_map.get(date) {
            return idx;
        }
        let mut ws = rust_xlsxwriter::Worksheet::new();
        let _ = ws.set_name(date);
        self.worksheets.push(ws);
        self.next_row.push(0);
        self.header_written.push(false);
        let idx = self.worksheets.len() - 1;
        self.sheet_map.insert(date.to_string(), idx);
        idx
    }

    fn write_header_if_needed(&mut self, sheet_idx: usize) -> Result<(), String> {
        if self.header_written[sheet_idx] {
            return Ok(());
        }
        let header = self
            .header
            .as_ref()
            .ok_or("内部错误: XLSX header 未初始化")?;
        for (col, name) in header.iter().enumerate() {
            self.worksheets[sheet_idx]
                .write_string(0, col as u16, name)
                .map_err(|e| e.to_string())?;
        }
        self.next_row[sheet_idx] = 1;
        self.header_written[sheet_idx] = true;
        Ok(())
    }

    fn write_csv_chunk_by_day(&mut self, csv_text: &str) -> Result<u64, String> {
        let mut cleaned = String::new();
        for line in csv_text.lines() {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            cleaned.push_str(t);
            cleaned.push('\n');
        }

        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_reader(cleaned.as_bytes());

        let mut header_record: Option<csv::StringRecord> = None;
        let mut count = 0u64;

        for rec in rdr.records() {
            let rec = rec.map_err(|e| e.to_string())?;

            if header_record.is_none() {
                header_record = Some(rec.clone());
                let keep_idxs = build_keep_indices(&rec);
                self.keep_idxs = keep_idxs;
                let header: Vec<String> = self
                    .keep_idxs
                    .iter()
                    .filter_map(|&i| rec.get(i))
                    .map(|s| s.to_string())
                    .collect();
                self.time_col_idx_in_keep = header.iter().position(|c| c == "_time");
                self.header = Some(header);
                continue;
            }

            // Repeated header line for another table
            if header_record.as_ref() == Some(&rec) {
                let keep_idxs = build_keep_indices(&rec);
                self.keep_idxs = keep_idxs;
                let header: Vec<String> = self
                    .keep_idxs
                    .iter()
                    .filter_map(|&i| rec.get(i))
                    .map(|s| s.to_string())
                    .collect();
                self.time_col_idx_in_keep = header.iter().position(|c| c == "_time");
                self.header = Some(header);
                continue;
            }

            let mut out: Vec<String> = self
                .keep_idxs
                .iter()
                .filter_map(|&i| rec.get(i))
                .map(|s| s.to_string())
                .collect();
            if out.iter().all(|v| v.is_empty()) {
                continue;
            }

            let time_idx = self
                .time_col_idx_in_keep
                .ok_or("XLSX 导出需要包含 _time 列")?;

            // Convert _time from UTC to local time (RFC3339 with offset).
            // Use the LOCAL date for sheet naming so sheets match what the user sees.
            let local_time_str = {
                let raw = out
                    .get(time_idx)
                    .ok_or("内部错误: _time 列越界")?
                    .trim()
                    .to_string();
                utc_to_local_rfc3339(&raw)
            };
            if let Some(v) = out.get_mut(time_idx) {
                *v = local_time_str.clone();
            }

            let date = extract_yyyy_mm_dd(&local_time_str).ok_or_else(|| {
                format!("无法解析 _time: '{}'", local_time_str)
            })?;

            let sheet_idx = self.ensure_sheet(&date);
            self.write_header_if_needed(sheet_idx)?;

            let row = self.next_row[sheet_idx];
            for (col, cell) in out.iter().enumerate() {
                self.worksheets[sheet_idx]
                    .write_string(row, col as u16, cell.as_str())
                    .map_err(|e| e.to_string())?;
            }
            self.next_row[sheet_idx] += 1;
            count += 1;
        }

        Ok(count)
    }

    fn save(mut self, file_path: &str) -> Result<(), String> {
        // stable ordering: sort sheet names (dates)
        let mut pairs: Vec<(String, usize)> = self
            .sheet_map
            .iter()
            .map(|(k, &v)| (k.clone(), v))
            .collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));

        for (_, idx) in pairs {
            let ws = std::mem::take(&mut self.worksheets[idx]);
            self.workbook.push_worksheet(ws);
        }

        self.workbook
            .save(file_path)
            .map_err(|e| e.to_string())
    }
}

fn extract_yyyy_mm_dd(s: &str) -> Option<String> {
    // Expect RFC3339 like "2026-03-30T09:05:17.350Z"
    if s.len() >= 10 {
        let d = &s[0..10];
        if d.chars()
            .enumerate()
            .all(|(i, c)| match i {
                4 | 7 => c == '-',
                _ => c.is_ascii_digit(),
            })
        {
            return Some(d.to_string());
        }
    }
    // Fallback parse
    if let Ok(dt) = s.parse::<DateTime<Utc>>() {
        return Some(dt.date_naive().to_string());
    }
    None
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn save_settings(config: InfluxConfig) -> Result<(), String> {
    let dir = dirs::config_dir()
        .ok_or("找不到配置目录")?
        .join("craner-data-inspector");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let json =
        serde_json::to_string_pretty(&config).map_err(|e| format!("序列化失败: {}", e))?;
    std::fs::write(dir.join("settings.json"), json)
        .map_err(|e| format!("写配置文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn load_settings() -> Result<Option<InfluxConfig>, String> {
    let path = match dirs::config_dir() {
        Some(d) => d.join("craner-data-inspector").join("settings.json"),
        None => return Ok(None),
    };
    if !path.exists() {
        return Ok(None);
    }
    let json =
        std::fs::read_to_string(&path).map_err(|e| format!("读配置文件失败: {}", e))?;
    let config: InfluxConfig =
        serde_json::from_str(&json).map_err(|e| format!("解析配置失败: {}", e))?;
    Ok(Some(config))
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/// Split a time range into equal-sized chunks of `chunk_minutes` each.
/// Returns a list of (start_rfc3339, stop_rfc3339) pairs.
fn build_time_chunks(
    start: &str,
    stop: &str,
    chunk_minutes: u64,
) -> Result<Vec<(String, String)>, String> {
    let now = Utc::now();

    let start_dt = parse_time(start, now)?;
    let stop_dt = if stop == "now()" || stop.is_empty() {
        now
    } else {
        parse_time(stop, now)?
    };

    if start_dt >= stop_dt {
        return Err("开始时间必须早于结束时间".to_string());
    }

    let chunk_secs = (chunk_minutes as i64) * 60;
    let mut chunks = Vec::new();
    let mut cursor = start_dt;

    while cursor < stop_dt {
        let next = (cursor + chrono::Duration::seconds(chunk_secs)).min(stop_dt);
        chunks.push((cursor.to_rfc3339(), next.to_rfc3339()));
        cursor = next;
    }

    Ok(chunks)
}

fn parse_time(s: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    let s = s.trim();

    // Relative times like "-1h", "-30d", "-15m"
    if let Some(rest) = s.strip_prefix('-') {
        return parse_relative_duration(rest, now);
    }

    // Full RFC3339 (frontend always sends proper ISO strings with timezone)
    s.parse::<DateTime<Utc>>()
        .map_err(|e| format!("无效时间 '{}': {}", s, e))
}

fn parse_relative_duration(s: &str, now: DateTime<Utc>) -> Result<DateTime<Utc>, String> {
    if let Some(n) = s.strip_suffix('h') {
        let hours: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::hours(hours))
    } else if s.ends_with("mo") {
        let n: i64 = s
            .strip_suffix("mo")
            .unwrap()
            .parse()
            .map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::days(n * 30))
    } else if let Some(n) = s.strip_suffix('d') {
        let days: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::days(days))
    } else if let Some(n) = s.strip_suffix('w') {
        let weeks: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::weeks(weeks))
    } else if let Some(n) = s.strip_suffix('m') {
        let mins: i64 = n.parse().map_err(|_| format!("无效相对时间: -{}", s))?;
        Ok(now - chrono::Duration::minutes(mins))
    } else {
        Err(format!("不支持的相对时间格式: -{}", s))
    }
}

/// Write a CSV chunk to the writer, skipping repeated headers.
/// Returns the number of data rows written.
fn write_csv_chunk(
    writer: &mut impl Write,
    csv_text: &str,
    header_written: &mut bool,
) -> std::io::Result<u64> {
    // InfluxDB CSV always includes metadata columns like `result` and `table`.
    // We strip those columns (and a possible leading empty column) from the downloaded file.
    let mut cleaned = String::new();
    for line in csv_text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        cleaned.push_str(t);
        cleaned.push('\n');
    }

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(cleaned.as_bytes());

    let mut wtr = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(writer);

    let mut header_record: Option<csv::StringRecord> = None;
    let mut keep_idxs: Vec<usize> = vec![];
    let mut time_col_in_out: Option<usize> = None;
    let mut count = 0u64;

    for rec in rdr.records() {
        let rec = rec?;
        if header_record.is_none() {
            header_record = Some(rec.clone());
            keep_idxs = build_keep_indices(&rec);
            let header: Vec<&str> = keep_idxs.iter().filter_map(|&i| rec.get(i)).collect();
            time_col_in_out = header.iter().position(|&c| c == "_time");
            if !*header_written {
                wtr.write_record(&header)?;
                *header_written = true;
            }
            continue;
        }

        // Repeated header from another table
        if header_record.as_ref() == Some(&rec) {
            keep_idxs = build_keep_indices(&rec);
            let header: Vec<&str> = keep_idxs.iter().filter_map(|&i| rec.get(i)).collect();
            time_col_in_out = header.iter().position(|&c| c == "_time");
            continue;
        }

        let mut out: Vec<String> = keep_idxs
            .iter()
            .filter_map(|&i| rec.get(i))
            .map(|s| s.to_string())
            .collect();
        if out.iter().all(|v| v.is_empty()) {
            continue;
        }
        if let Some(t_idx) = time_col_in_out {
            if let Some(v) = out.get_mut(t_idx) {
                *v = utc_to_local_rfc3339(v);
            }
        }
        wtr.write_record(&out)?;
        count += 1;
    }

    wtr.flush()?;
    Ok(count)
}

/// Convert a UTC RFC3339 timestamp to the machine's local timezone with offset.
/// e.g. "2026-03-30T01:05:17.350Z" → "2026-03-30T09:05:17.350+08:00"
fn utc_to_local_rfc3339(s: &str) -> String {
    match s.parse::<DateTime<Utc>>() {
        Ok(dt) => dt.with_timezone(&Local).to_rfc3339(),
        Err(_) => s.to_string(),
    }
}

fn build_keep_indices(header: &csv::StringRecord) -> Vec<usize> {
    let mut keep = Vec::new();
    for (i, name) in header.iter().enumerate() {
        let n = name.trim();
        if n.is_empty() {
            // Influx sometimes prefixes an empty column before "result".
            continue;
        }
        if n == "result" || n == "table" {
            continue;
        }
        keep.push(i);
    }
    keep
}
