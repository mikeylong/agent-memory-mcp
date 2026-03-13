import { describe, expect, it } from "vitest";
import { hashProjectPath, normalizeScope, normalizeScopes, resolveSearchScopes } from "../../src/scope.js";

describe("scope normalization", () => {
  it("requires ids for project/session unless project_path metadata is provided", () => {
    expect(() => normalizeScope({ type: "project" })).toThrowError(/Scope id is required/);
    expect(() => normalizeScope({ type: "session" })).toThrowError(/Scope id is required/);

    const scope = normalizeScope(
      { type: "project" },
      { project_path: "/tmp/project-a" },
    );
    expect(scope.type).toBe("project");
    expect(scope.id).toBe(hashProjectPath("/tmp/project-a"));
  });

  it("normalizes wildcards for empty search scopes", () => {
    const scopes = normalizeScopes(undefined);
    expect(scopes).toEqual([
      { type: "global" },
      { type: "project", id: "*" },
      { type: "session", id: "*" },
    ]);
  });

  it("normalizes project path-like ids to project hash", () => {
    const direct = normalizeScope({ type: "project", id: "/tmp/project-a" });
    expect(direct.id).toBe(hashProjectPath("/tmp/project-a"));

    const scoped = normalizeScopes([{ type: "project", id: "/tmp/project-a" }]);
    expect(scoped[0].id).toBe(hashProjectPath("/tmp/project-a"));
  });

  it("uses explicit scopes exactly for search resolution", () => {
    const scopes = resolveSearchScopes({
      scopes: [{ type: "project", id: "/tmp/project-a" }],
      project_path: "/tmp/project-b",
      session_id: "session-1",
      scope_mode: "all",
    });

    expect(scopes).toEqual([{ type: "project", id: hashProjectPath("/tmp/project-a") }]);
  });

  it("resolves all-mode search to the legacy wildcard universe", () => {
    const scopes = resolveSearchScopes({ scope_mode: "all" });
    expect(scopes).toEqual([
      { type: "global" },
      { type: "project", id: "*" },
      { type: "session", id: "*" },
    ]);
  });

  it("resolves auto-mode search to global plus project when provided", () => {
    const scopes = resolveSearchScopes({
      project_path: "/tmp/project-a",
    });

    expect(scopes).toEqual([
      { type: "global" },
      { type: "project", id: hashProjectPath("/tmp/project-a") },
    ]);
  });

  it("resolves auto-mode search to global plus session when provided", () => {
    const scopes = resolveSearchScopes({
      session_id: "session-1",
    });

    expect(scopes).toEqual([
      { type: "global" },
      { type: "session", id: "session-1" },
    ]);
  });

  it("resolves auto-mode search to global plus project and session when both are provided", () => {
    const scopes = resolveSearchScopes({
      project_path: "/tmp/project-a",
      session_id: "session-1",
      scope_mode: "auto",
    });

    expect(scopes).toEqual([
      { type: "global" },
      { type: "project", id: hashProjectPath("/tmp/project-a") },
      { type: "session", id: "session-1" },
    ]);
  });

  it("resolves auto-mode search to global only when no context is provided", () => {
    const scopes = resolveSearchScopes({});
    expect(scopes).toEqual([{ type: "global" }]);
  });
});
