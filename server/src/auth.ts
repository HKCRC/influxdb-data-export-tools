import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { QueryPermission } from "./types.js";

export type UserRole = "admin" | "user";

export interface PublicUser {
  id: string;
  username: string;
  role: UserRole;
  maxRecordsPerSec: number;
  permissions: QueryPermission[];
}

interface UserRecord extends PublicUser {
  passwordHash: string;
  passwordSalt: string;
  createdAt: string;
  updatedAt: string;
}

interface UserDbFile {
  users: UserRecord[];
}

interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

const USER_DB_PATH = process.env.USER_DB_PATH ?? path.resolve("server/data/users.json");
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "craner_session";
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 4) * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS_PER_SEC = 3000;
const sessions = new Map<string, SessionRecord>();

let users: UserRecord[] = [];

export async function initAuthStore(): Promise<void> {
  users = await readUsers();
  await ensureAdminUser();
  cleanupSessions();
  setInterval(cleanupSessions, 10 * 60 * 1000).unref();
}

export async function login(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
  const user = users.find((item) => item.username === username);
  if (!user || !(await verifyPassword(password, user))) {
    throw new Error("用户名或密码错误");
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    token,
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return { token, user: toPublicUser(user) };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE === "true",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSession(req: Request, res: Response): void {
  const token = readSessionToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = readSessionToken(req);
  if (!token) {
    res.status(401).json({ error: "请先登录" });
    return;
  }

  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    res.status(401).json({ error: "登录已过期，请重新登录" });
    return;
  }

  const record = users.find((item) => item.id === session.userId);
  if (!record) {
    sessions.delete(token);
    res.status(401).json({ error: "用户不存在，请重新登录" });
    return;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  req.user = toPublicUser(record);
  next();
};

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "需要管理员权限" });
    return;
  }
  next();
};

export function getCurrentUser(req: Request): PublicUser {
  if (!req.user) throw new Error("请先登录");
  return req.user;
}

export function listChildUsers(): PublicUser[] {
  return users.filter((user) => user.role === "user").map(toPublicUser);
}

export async function createChildUser(input: {
  username: string;
  password: string;
  maxRecordsPerSec: number;
  permissions: QueryPermission[];
}): Promise<PublicUser> {
  const username = normalizeUsername(input.username);
  if (users.some((user) => user.username === username)) throw new Error("用户名已存在");
  if (!input.password) throw new Error("密码不能为空");

  const now = new Date().toISOString();
  const record: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role: "user",
    maxRecordsPerSec: normalizeRecordsPerSec(input.maxRecordsPerSec),
    permissions: normalizePermissions(input.permissions),
    ...(await hashPassword(input.password)),
    createdAt: now,
    updatedAt: now,
  };

  users.push(record);
  await saveUsers();
  return toPublicUser(record);
}

export async function updateChildUser(
  id: string,
  input: {
    username: string;
    password?: string;
    maxRecordsPerSec: number;
    permissions: QueryPermission[];
  },
): Promise<PublicUser> {
  const record = users.find((user) => user.id === id && user.role === "user");
  if (!record) throw new Error("子用户不存在");

  const username = normalizeUsername(input.username);
  if (users.some((user) => user.id !== id && user.username === username)) {
    throw new Error("用户名已存在");
  }

  record.username = username;
  record.maxRecordsPerSec = normalizeRecordsPerSec(input.maxRecordsPerSec);
  record.permissions = normalizePermissions(input.permissions);
  if (input.password) {
    Object.assign(record, await hashPassword(input.password));
  }
  record.updatedAt = new Date().toISOString();

  await saveUsers();
  return toPublicUser(record);
}

export async function deleteChildUser(id: string): Promise<void> {
  const idx = users.findIndex((user) => user.id === id && user.role === "user");
  if (idx < 0) throw new Error("子用户不存在");
  users.splice(idx, 1);
  for (const [token, session] of sessions) {
    if (session.userId === id) sessions.delete(token);
  }
  await saveUsers();
}

export function authErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

function readSessionToken(req: Request): string | null {
  const auth = req.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim() || null;
  const queryToken = typeof req.query.session === "string" ? req.query.session : "";
  if (queryToken) return queryToken;

  const raw = req.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return decodeURIComponent(valueParts.join("="));
  }
  return null;
}

async function readUsers(): Promise<UserRecord[]> {
  try {
    const raw = await readFile(USER_DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as UserDbFile;
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function saveUsers(): Promise<void> {
  await mkdir(path.dirname(USER_DB_PATH), { recursive: true });
  const tmpPath = `${USER_DB_PATH}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify({ users }, null, 2)}\n`, "utf8");
  await rename(tmpPath, USER_DB_PATH);
}

async function ensureAdminUser(): Promise<void> {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD ?? "admin";
  const existing = users.find((user) => user.role === "admin" && user.username === username);
  if (existing) {
    if (process.env.ADMIN_PASSWORD) {
      Object.assign(existing, await hashPassword(password));
      existing.updatedAt = new Date().toISOString();
      await saveUsers();
    }
    return;
  }

  const now = new Date().toISOString();
  users.push({
    id: crypto.randomUUID(),
    username,
    role: "admin",
    maxRecordsPerSec: DEFAULT_MAX_RECORDS_PER_SEC,
    permissions: [],
    ...(await hashPassword(password)),
    createdAt: now,
    updatedAt: now,
  });
  await saveUsers();
}

function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    maxRecordsPerSec: user.maxRecordsPerSec,
    permissions: user.permissions,
  };
}

async function hashPassword(password: string): Promise<{ passwordHash: string; passwordSalt: string }> {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await scrypt(password, passwordSalt);
  return { passwordHash, passwordSalt };
}

async function verifyPassword(password: string, user: UserRecord): Promise<boolean> {
  const hash = await scrypt(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.passwordHash, "hex"));
}

function scrypt(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function normalizeUsername(value: string): string {
  const username = value.trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(username)) {
    throw new Error("用户名只能包含 2-32 位字母、数字、下划线或连字符");
  }
  return username;
}

function normalizeRecordsPerSec(value: number): number {
  return Math.max(100, Math.min(5000, Math.floor(Number(value) || DEFAULT_MAX_RECORDS_PER_SEC)));
}

function normalizePermissions(value: QueryPermission[]): QueryPermission[] {
  const seen = new Set<string>();
  const permissions: QueryPermission[] = [];
  for (const item of value) {
    const bucket = item.bucket.trim();
    const measurement = item.measurement.trim();
    const topic = item.topic?.trim() || undefined;
    if (!bucket || !measurement) throw new Error("权限必须包含 bucket 和 measurement");
    const key = `${bucket}\n${measurement}\n${topic ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    permissions.push({ bucket, measurement, topic });
  }
  if (permissions.length === 0) throw new Error("子用户至少需要一条查询权限");
  return permissions;
}
