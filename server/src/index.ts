import express from "express";
import cors from "cors";
import path from "node:path";
import "./env.js";
import {
  cancelJob,
  cleanupOldExports,
  createExportJob,
  getJob,
  subscribeToJob,
} from "./exportJobs.js";
import {
  clearSession,
  createChildUser,
  deleteChildUser,
  getCurrentUser,
  initAuthStore,
  listChildUsers,
  login,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  updateChildUser,
  type PublicUser,
} from "./auth.js";
import { InfluxClient } from "./influx.js";
import {
  childUserInputSchema,
  downloadConfigSchema,
  influxConfigSchema,
  queryParamsSchema,
  type FilterCondition,
  type InfluxConfig,
  type QueryParams,
} from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:1420";

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const username = stringParam(req.body.username, "username");
  const password = stringParam(req.body.password, "password");
  const result = await login(username, password);
  setSessionCookie(res, result.token);
  res.json({ user: result.user });
}));

app.post("/api/auth/logout", requireAuth, (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: getCurrentUser(req) });
});

app.get("/api/admin/users", requireAuth, requireAdmin, (_req, res) => {
  res.json({ users: listChildUsers() });
});

app.post("/api/admin/users", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const input = childUserInputSchema.parse(req.body);
  if (!input.password) throw new Error("密码不能为空");
  res.status(201).json({ user: await createChildUser({ ...input, password: input.password }) });
}));

app.put("/api/admin/users/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const input = childUserInputSchema.parse(req.body);
  res.json({ user: await updateChildUser(stringParam(req.params.id, "id"), input) });
}));

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  await deleteChildUser(stringParam(req.params.id, "id"));
  res.json({ ok: true });
}));

app.use("/api/influx", requireAuth);
app.use("/api/exports", requireAuth);

app.get("/api/influx/config-status", (_req, res) => {
  res.json({ configured: hasEnvInfluxConfig() });
});

app.post("/api/influx/test-connection", asyncHandler(async (req, res) => {
  const config = resolveInfluxConfig(req.body);
  const message = await new InfluxClient(config).testConnection();
  res.json({ message });
}));

app.post("/api/influx/buckets", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const buckets = await new InfluxClient(config).getBuckets();
  res.json({ buckets: filterBuckets(user, buckets) });
}));

app.post("/api/influx/measurements", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const bucket = stringParam(req.body.bucket, "bucket");
  assertBucketAllowed(user, bucket);
  const measurements = await new InfluxClient(config).getMeasurements(bucket);
  res.json({ measurements: filterMeasurements(user, bucket, measurements) });
}));

app.post("/api/influx/tag-keys", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const bucket = stringParam(req.body.bucket, "bucket");
  const measurement = stringParam(req.body.measurement, "measurement");
  assertMeasurementAllowed(user, bucket, measurement);
  res.json({ tagKeys: await new InfluxClient(config).getTagKeys(bucket, measurement) });
}));

app.post("/api/influx/tag-values", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const bucket = stringParam(req.body.bucket, "bucket");
  const measurement = stringParam(req.body.measurement, "measurement");
  const tag = stringParam(req.body.tag, "tag");
  const filters = applyTagValuePermission(
    user,
    bucket,
    measurement,
    tag,
    (req.body.filters ?? []) as FilterCondition[],
  );
  if (filters === "topic-list") {
    res.json({ tagValues: allowedTopics(user, bucket, measurement) });
    return;
  }
  res.json({
    tagValues: await new InfluxClient(config).getTagValues(bucket, measurement, tag, filters),
  });
}));

app.post("/api/influx/preview", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const params = queryParamsSchema.parse(req.body.params);
  assertQueryAllowed(user, params);
  res.json(await new InfluxClient(config).previewQuery(params));
}));

app.post("/api/exports", asyncHandler(async (req, res) => {
  const user = getCurrentUser(req);
  const config = resolveInfluxConfig(req.body);
  const params = queryParamsSchema.parse(req.body.params);
  const downloadConfig = applyDownloadLimit(user, downloadConfigSchema.parse(req.body.downloadConfig));
  assertQueryAllowed(user, params);
  res.status(202).json(await createExportJob(config, params, downloadConfig));
}));

app.get("/api/exports/:jobId/events", (req, res) => {
  const jobId = req.params.jobId;

  try {
    getJobOrThrow(jobId);
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = subscribeToJob(jobId, send);
  req.on("close", unsubscribe);
});

app.get("/api/exports/:jobId/download", (req, res) => {
  try {
    const job = getJobOrThrow(req.params.jobId);
    if (job.status !== "completed" || !job.filePath || !job.fileName) {
      res.status(409).json({ error: "任务尚未完成" });
      return;
    }

    res.download(job.filePath, job.fileName);
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

app.post("/api/exports/:jobId/cancel", (req, res) => {
  try {
    cancelJob(req.params.jobId);
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: errorMessage(error) });
  }
});

app.use(express.static(path.resolve("dist")));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: errorMessage(err) });
});

setInterval(() => {
  cleanupOldExports().catch((error) => {
    console.error("cleanup failed", error);
  });
}, 60 * 60 * 1000).unref();

await initAuthStore();

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

function resolveInfluxConfig(body: { config?: unknown }): InfluxConfig {
  const envConfig = {
    url: process.env.INFLUX_URL ?? "",
    token: process.env.INFLUX_TOKEN ?? "",
    org: process.env.INFLUX_ORG ?? "",
  };
  if (hasEnvInfluxConfig()) return envConfig;
  return influxConfigSchema.parse(body.config);
}

function hasEnvInfluxConfig(): boolean {
  return Boolean(process.env.INFLUX_URL && process.env.INFLUX_TOKEN && process.env.INFLUX_ORG);
}

function filterBuckets(user: PublicUser, buckets: string[]): string[] {
  if (user.role === "admin") return buckets;
  const allowed = new Set(user.permissions.map((permission) => permission.bucket));
  return buckets.filter((bucket) => allowed.has(bucket));
}

function filterMeasurements(user: PublicUser, bucket: string, measurements: string[]): string[] {
  if (user.role === "admin") return measurements;
  const allowed = new Set(
    user.permissions
      .filter((permission) => permission.bucket === bucket)
      .map((permission) => permission.measurement),
  );
  return measurements.filter((measurement) => allowed.has(measurement));
}

function assertBucketAllowed(user: PublicUser, bucket: string): void {
  if (user.role === "admin") return;
  if (!user.permissions.some((permission) => permission.bucket === bucket)) {
    throw new Error("没有权限访问该 bucket");
  }
}

function assertMeasurementAllowed(user: PublicUser, bucket: string, measurement: string): void {
  if (user.role === "admin") return;
  if (
    !user.permissions.some(
      (permission) => permission.bucket === bucket && permission.measurement === measurement,
    )
  ) {
    throw new Error("没有权限访问该 measurement");
  }
}

function assertQueryAllowed(user: PublicUser, params: QueryParams): void {
  if (user.role === "admin") return;
  const topicFilter = params.filters.find((filter) => filter.key === "topic")?.value;
  const permitted = user.permissions.some((permission) => {
    if (permission.bucket !== params.bucket || permission.measurement !== params.measurement) return false;
    if (!permission.topic) return true;
    return topicFilter === permission.topic;
  });
  if (!permitted) throw new Error("没有权限查询该 topic");
}

function allowedTopics(user: PublicUser, bucket: string, measurement: string): string[] {
  if (user.role === "admin") return [];
  const topics = new Set<string>();
  for (const permission of user.permissions) {
    if (permission.bucket === bucket && permission.measurement === measurement && permission.topic) {
      topics.add(permission.topic);
    }
  }
  return [...topics].sort();
}

function hasAllTopicPermission(user: PublicUser, bucket: string, measurement: string): boolean {
  return (
    user.role === "admin" ||
    user.permissions.some(
      (permission) =>
        permission.bucket === bucket && permission.measurement === measurement && !permission.topic,
    )
  );
}

function applyTagValuePermission(
  user: PublicUser,
  bucket: string,
  measurement: string,
  tag: string,
  filters: FilterCondition[],
): FilterCondition[] | "topic-list" {
  assertMeasurementAllowed(user, bucket, measurement);
  if (user.role === "admin" || hasAllTopicPermission(user, bucket, measurement)) return filters;

  const topics = allowedTopics(user, bucket, measurement);
  if (tag === "topic") return "topic-list";

  const existingTopic = filters.find((filter) => filter.key === "topic")?.value;
  if (existingTopic && topics.includes(existingTopic)) return filters;
  if (topics.length === 1) return [{ key: "topic", value: topics[0]! }, ...filters];
  throw new Error("请先选择有权限的 topic");
}

function applyDownloadLimit(user: PublicUser, config: ReturnType<typeof downloadConfigSchema.parse>) {
  if (user.role === "admin") return config;
  return { ...config, records_per_sec: user.maxRecordsPerSec };
}

function getJobOrThrow(jobId: string) {
  const job = getJob(jobId);
  if (!job) throw new Error("任务不存在或已过期");
  return job;
}

function stringParam(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} 不能为空`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asyncHandler(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
