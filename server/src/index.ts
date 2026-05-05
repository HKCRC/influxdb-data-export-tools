import express from "express";
import cors from "cors";
import path from "node:path";
import {
  cancelJob,
  cleanupOldExports,
  createExportJob,
  getJob,
  subscribeToJob,
} from "./exportJobs.js";
import { InfluxClient } from "./influx.js";
import {
  downloadConfigSchema,
  influxConfigSchema,
  queryParamsSchema,
  type FilterCondition,
} from "./types.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:1420";

app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/influx/test-connection", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const message = await new InfluxClient(config).testConnection();
  res.json({ message });
}));

app.post("/api/influx/buckets", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  res.json({ buckets: await new InfluxClient(config).getBuckets() });
}));

app.post("/api/influx/measurements", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const bucket = stringParam(req.body.bucket, "bucket");
  res.json({ measurements: await new InfluxClient(config).getMeasurements(bucket) });
}));

app.post("/api/influx/tag-keys", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const bucket = stringParam(req.body.bucket, "bucket");
  const measurement = stringParam(req.body.measurement, "measurement");
  res.json({ tagKeys: await new InfluxClient(config).getTagKeys(bucket, measurement) });
}));

app.post("/api/influx/tag-values", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const bucket = stringParam(req.body.bucket, "bucket");
  const measurement = stringParam(req.body.measurement, "measurement");
  const tag = stringParam(req.body.tag, "tag");
  const filters = (req.body.filters ?? []) as FilterCondition[];
  res.json({
    tagValues: await new InfluxClient(config).getTagValues(bucket, measurement, tag, filters),
  });
}));

app.post("/api/influx/preview", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const params = queryParamsSchema.parse(req.body.params);
  res.json(await new InfluxClient(config).previewQuery(params));
}));

app.post("/api/exports", asyncHandler(async (req, res) => {
  const config = influxConfigSchema.parse(req.body.config);
  const params = queryParamsSchema.parse(req.body.params);
  const downloadConfig = downloadConfigSchema.parse(req.body.downloadConfig);
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

app.listen(port, () => {
  console.log(`API server listening on http://localhost:${port}`);
});

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
