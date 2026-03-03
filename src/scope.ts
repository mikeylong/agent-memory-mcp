import crypto from "node:crypto";
import path from "node:path";
import { ScopeRef, ScopeSelector } from "./types.js";

export function hashProjectPath(projectPath: string): string {
  const normalized = path.resolve(projectPath);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function isPathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~") ||
    value.includes(path.sep)
  );
}

function normalizeProjectScopeId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error("Project scope id cannot be empty");
  }

  if (isSha256Hex(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (isPathLike(trimmed)) {
    return hashProjectPath(trimmed);
  }

  return trimmed;
}

export function normalizeScope(
  scope: ScopeRef,
  metadata?: Record<string, unknown>,
): ScopeRef {
  if (scope.type === "global") {
    return { type: "global" };
  }

  if (scope.id && scope.id.trim().length > 0) {
    if (scope.type === "project") {
      return { type: "project", id: normalizeProjectScopeId(scope.id) };
    }

    return { type: scope.type, id: scope.id.trim() };
  }

  if (scope.type === "project") {
    const projectPath = metadata?.project_path;
    if (typeof projectPath === "string" && projectPath.trim().length > 0) {
      return {
        type: "project",
        id: hashProjectPath(projectPath),
      };
    }
  }

  throw new Error(`Scope id is required for scope type '${scope.type}'`);
}

export function normalizeScopes(scopes?: ScopeSelector[]): ScopeSelector[] {
  if (!scopes || scopes.length === 0) {
    return [
      { type: "global" },
      { type: "project", id: "*" },
      { type: "session", id: "*" },
    ];
  }

  return scopes.map((scope) => {
    if (scope.type === "global") {
      return { type: "global" };
    }

    if (!scope.id || scope.id.trim().length === 0) {
      throw new Error(`Scope id is required for scope type '${scope.type}'`);
    }

    return {
      type: scope.type,
      id:
        scope.type === "project"
          ? normalizeProjectScopeId(scope.id)
          : scope.id.trim(),
    };
  });
}

export function scopeWhereClause(
  scopes: ScopeSelector[],
  alias: string,
): { clause: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];

  for (const scope of scopes) {
    if (scope.type === "global") {
      conditions.push(`${alias}.scope_type = 'global'`);
      continue;
    }

    if (!scope.id || scope.id === "*") {
      conditions.push(`${alias}.scope_type = ?`);
      params.push(scope.type);
      continue;
    }

    conditions.push(`(${alias}.scope_type = ? AND ${alias}.scope_id = ?)`);
    params.push(scope.type, scope.id);
  }

  if (conditions.length === 0) {
    return { clause: "1=0", params: [] };
  }

  return {
    clause: `(${conditions.join(" OR ")})`,
    params,
  };
}
