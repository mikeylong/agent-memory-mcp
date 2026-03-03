import { describe, expect, it } from "vitest";
import { hashProjectPath, normalizeScope, normalizeScopes } from "../../src/scope.js";

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
});
