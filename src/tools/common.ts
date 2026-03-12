import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { ClientClass, resolveClientClassFromServer } from "./clientPolicy.js";

export const scopeTypeSchema = z.enum(["global", "project", "session"]);

export const scopeRefSchema = z.object({
  type: scopeTypeSchema,
  id: z.string().optional(),
});

export const scopeSelectorSchema = scopeRefSchema;

function coerceNumericInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : value;
}

export function optionalNumberSchema(min: number, max: number) {
  return z.preprocess(coerceNumericInput, z.number().min(min).max(max)).optional();
}

export function optionalIntSchema(min: number, max: number) {
  return z.preprocess(coerceNumericInput, z.number().int().min(min).max(max)).optional();
}

type JsonObject = object;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatMegabytes(bytes: number): string {
  const megabytes = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1);
}

export function summarizeToolPayload(toolName: string, payload: JsonObject, _clientClass: ClientClass): string {
  const record = payload as Record<string, unknown>;

  switch (toolName) {
    case "memory_search":
    case "memory_search_compact": {
      const itemCount = asArrayLength(record.items) ?? 0;
      const total = asCount(record.total);
      return total !== null
        ? `${toolName} returned ${pluralize(itemCount, "item")} (total ${total}).`
        : `${toolName} returned ${pluralize(itemCount, "item")}.`;
    }
    case "memory_get_context": {
      const itemCount = asArrayLength(record.items) ?? 0;
      return `memory_get_context returned ${pluralize(itemCount, "item")}.`;
    }
    case "memory_upsert": {
      const id = asString(record.id);
      const action = record.created === true ? "created" : "returned";
      return id ? `memory_upsert ${action} memory ${id}.` : `memory_upsert ${action} a memory.`;
    }
    case "memory_capture": {
      const extracted = asCount(record.extracted_count) ?? 0;
      const created = asArrayLength(record.created_ids) ?? 0;
      const deduped = asArrayLength(record.deduped_ids) ?? 0;
      return `memory_capture extracted ${extracted} fact(s); created ${created}, deduped ${deduped}.`;
    }
    case "memory_delete":
      return record.deleted === true
        ? "memory_delete deleted 1 memory."
        : "memory_delete deleted 0 memories.";
    case "memory_forget_scope": {
      const deletedCount = asCount(record.deleted_count) ?? 0;
      return `memory_forget_scope deleted ${pluralize(deletedCount, "memory", "memories")}.`;
    }
    case "memory_health": {
      const db = asString(record.db) ?? "unknown";
      const embeddings = asString(record.embeddings) ?? "unknown";
      const stats = asObject(record.stats);
      const memories = asObject(stats?.memories);
      const storage = asObject(stats?.storage);
      const active = asCount(memories?.active);
      const dbBytes = asCount(storage?.db_size_bytes);

      if (active !== null && dbBytes !== null) {
        return `memory_health db=${db}, embeddings=${embeddings}, active=${active}, db_mb=${formatMegabytes(dbBytes)}.`;
      }

      return `memory_health db=${db}, embeddings=${embeddings}.`;
    }
    default:
      return `${toolName} completed.`;
  }
}

export function buildToolResultEnvelope<T extends JsonObject>(
  toolName: string,
  payload: T,
  clientClass: ClientClass,
) {
  const summary = summarizeToolPayload(toolName, payload, clientClass);

  return {
    content: [
      {
        type: "text" as const,
        text: summary,
      },
    ],
    structuredContent: payload,
  };
}

export function toolJsonResult<T extends JsonObject>(server: McpServer, toolName: string, payload: T) {
  const clientClass = resolveClientClassFromServer(server);
  return buildToolResultEnvelope(toolName, payload, clientClass);
}
