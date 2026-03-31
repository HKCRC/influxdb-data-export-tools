use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::commands::{FilterCondition, InfluxConfig, QueryParams};

pub struct InfluxClient {
    client: Client,
    config: InfluxConfig,
}

#[derive(Serialize)]
struct QueryRequest<'a> {
    query: &'a str,
    dialect: Dialect,
}

#[derive(Serialize)]
struct Dialect {
    annotations: Vec<String>,
    header: bool,
    delimiter: String,
}

impl InfluxClient {
    pub fn new(config: &InfluxConfig) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .unwrap_or_default(),
            config: config.clone(),
        }
    }

    fn auth_header(&self) -> String {
        format!("Token {}", self.config.token)
    }

    pub async fn test_connection(&self) -> Result<String, String> {
        let url = format!("{}/health", self.config.url.trim_end_matches('/'));
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| format!("连接失败: {}", e))?;

        if resp.status().is_success() {
            Ok("连接成功！InfluxDB 服务正常运行".to_string())
        } else {
            Err(format!("连接失败: HTTP {}", resp.status()))
        }
    }

    pub async fn get_buckets(&self) -> Result<Vec<String>, String> {
        let url = format!("{}/api/v2/buckets", self.config.url.trim_end_matches('/'));
        let mut query: Vec<(&str, &str)> = vec![("limit", "100")];
        if looks_like_org_id(&self.config.org) {
            query.push(("orgID", self.config.org.as_str()));
        } else {
            query.push(("org", self.config.org.as_str()));
        }
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.auth_header())
            .query(&query)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("获取 bucket 失败: HTTP {} - {}", status, text));
        }

        #[derive(Deserialize)]
        struct BucketList {
            buckets: Vec<Bucket>,
        }
        #[derive(Deserialize)]
        struct Bucket {
            name: String,
        }

        let data: BucketList = resp
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;

        let mut names: Vec<String> = data
            .buckets
            .into_iter()
            .map(|b| b.name)
            .filter(|n| !n.starts_with('_'))
            .collect();
        names.sort();
        Ok(names)
    }

    async fn flux_query(&self, query: &str) -> Result<String, String> {
        let url = format!(
            "{}/api/v2/query",
            self.config.url.trim_end_matches('/')
        );
        let body = QueryRequest {
            query,
            dialect: Dialect {
                // Match InfluxDB UI defaults; our parsers also tolerate these lines.
                annotations: vec![
                    "group".to_string(),
                    "datatype".to_string(),
                    "default".to_string(),
                ],
                header: true,
                delimiter: ",".to_string(),
            },
        };

        let resp = self
            .client
            .post(&url)
            .header("Authorization", self.auth_header())
            .query(&if looks_like_org_id(&self.config.org) {
                vec![("orgID", self.config.org.as_str())]
            } else {
                vec![("org", self.config.org.as_str())]
            })
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("查询失败: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("查询失败: HTTP {} - {}", status, text));
        }

        resp.text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))
    }

    pub async fn flux_query_raw(&self, query: &str) -> Result<String, String> {
        self.flux_query(query).await
    }

    /// Parse a specific column from InfluxDB's no-annotation CSV output.
    /// Handles multiple tables (each separated by an empty line with a repeated header).
    fn parse_csv_column(&self, csv: &str, col_name: &str) -> Vec<String> {
        let mut result = HashSet::new();
        let mut col_idx: Option<usize> = None;

        for line in csv.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                continue;
            }
            if trimmed.is_empty() {
                col_idx = None; // Reset for next table
                continue;
            }

            // Detect header line (starts with "result,table," or contains col_name)
            if col_idx.is_none() {
                let cols: Vec<&str> = trimmed.split(',').collect();
                if let Some(idx) = cols.iter().position(|&c| c.trim() == col_name) {
                    col_idx = Some(idx);
                }
                continue;
            }

            if let Some(idx) = col_idx {
                let parts: Vec<&str> = trimmed.split(',').collect();
                if let Some(val) = parts.get(idx) {
                    let v = val.trim().to_string();
                    if !v.is_empty() {
                        result.insert(v);
                    }
                }
            }
        }

        let mut out: Vec<String> = result.into_iter().collect();
        out.sort();
        out
    }

    pub async fn get_measurements(&self, bucket: &str) -> Result<Vec<String>, String> {
        let query = format!(
            "import \"influxdata/influxdb/schema\"\nschema.measurements(bucket: \"{}\")",
            escape_flux(bucket)
        );
        let csv = self.flux_query(&query).await?;
        Ok(self.parse_csv_column(&csv, "_value"))
    }

    pub async fn get_tag_keys(
        &self,
        bucket: &str,
        measurement: &str,
    ) -> Result<Vec<String>, String> {
        let query = format!(
            "import \"influxdata/influxdb/schema\"\nschema.tagKeys(\n  bucket: \"{}\",\n  predicate: (r) => r._measurement == \"{}\",\n  start: -30d\n)",
            escape_flux(bucket),
            escape_flux(measurement)
        );
        let csv = self.flux_query(&query).await?;
        let mut keys = self.parse_csv_column(&csv, "_value");
        keys.retain(|k| !k.starts_with('_'));
        Ok(keys)
    }

    pub async fn get_tag_values(
        &self,
        bucket: &str,
        measurement: &str,
        tag: &str,
        filters: &[FilterCondition],
    ) -> Result<Vec<String>, String> {
        let mut predicate = format!("r._measurement == \"{}\"", escape_flux(measurement));
        for f in filters {
            predicate.push_str(&format!(
                " and r[\"{}\"] == \"{}\"",
                escape_flux(&f.key),
                escape_flux(&f.value)
            ));
        }
        let query = format!(
            "import \"influxdata/influxdb/schema\"\nschema.tagValues(\n  bucket: \"{}\",\n  tag: \"{}\",\n  predicate: (r) => {},\n  start: -30d\n)",
            escape_flux(bucket),
            escape_flux(tag),
            predicate
        );
        let csv = self.flux_query(&query).await?;
        Ok(self.parse_csv_column(&csv, "_value"))
    }

    pub fn build_flux_query(&self, params: &QueryParams) -> String {
        let mut q = format!(
            "from(bucket: \"{}\")\n  |> range(start: {}, stop: {})",
            escape_flux(&params.bucket),
            params.start,
            params.stop
        );
        q.push_str(&format!(
            "\n  |> filter(fn: (r) => r[\"_measurement\"] == \"{}\")",
            escape_flux(&params.measurement)
        ));
        for f in &params.filters {
            if !f.key.is_empty() && !f.value.is_empty() {
                q.push_str(&format!(
                    "\n  |> filter(fn: (r) => r[\"{}\"] == \"{}\")",
                    escape_flux(&f.key),
                    escape_flux(&f.value)
                ));
            }
        }
        q.push_str(
            "\n  |> pivot(rowKey: [\"_time\"], columnKey: [\"_field\"], valueColumn: \"_value\")\
             \n  |> drop(columns: [\"result\", \"table\", \"_start\", \"_stop\", \"_measurement\"])",
        );
        q
    }

    pub async fn preview_query(
        &self,
        params: &QueryParams,
    ) -> Result<serde_json::Value, String> {
        let mut query = self.build_flux_query(params);
        query.push_str("\n  |> limit(n: 100)");

        let csv = self.flux_query(&query).await?;
        Ok(csv_to_json(&csv))
    }

    pub async fn query_csv(&self, params: &QueryParams) -> Result<String, String> {
        let query = self.build_flux_query(params);
        self.flux_query(&query).await
    }
}

/// Convert no-annotation InfluxDB CSV to a JSON object with columns + rows arrays.
pub fn csv_to_json(csv: &str) -> serde_json::Value {
    let mut columns: Vec<String> = vec![];
    let mut rows: Vec<Vec<String>> = vec![];
    let mut header_set = false;
    let mut header_line: Option<String> = None;

    for line in csv.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if trimmed.is_empty() {
            // Table separator – reset so we skip the repeated header
            if !header_set {
                continue;
            }
            // After first header is set, just skip blanks
            continue;
        }

        let parts: Vec<String> = trimmed.split(',').map(|s| s.trim().to_string()).collect();

        if !header_set {
            columns = parts;
            header_set = true;
            header_line = Some(trimmed.to_string());
            continue;
        }

        // Skip repeated header lines (Influx may emit multiple tables).
        // DO NOT compare only the first column: it can be empty in both header and data rows.
        if header_line.as_deref() == Some(trimmed) {
            continue;
        }

        rows.push(parts);
    }

    serde_json::json!({ "columns": columns, "rows": rows })
}

/// Escape a string for use in Flux query string literals.
fn escape_flux(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn looks_like_org_id(s: &str) -> bool {
    let t = s.trim();
    if t.len() != 16 && t.len() != 24 && t.len() != 32 {
        return false;
    }
    t.chars().all(|c| c.is_ascii_hexdigit())
}
