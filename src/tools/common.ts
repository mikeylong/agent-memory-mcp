import * as z from "zod/v4";

export const scopeTypeSchema = z.enum(["global", "project", "session"]);

export const scopeRefSchema = z.object({
  type: scopeTypeSchema,
  id: z.string().optional(),
});

export const scopeSelectorSchema = scopeRefSchema;

export function toolJsonResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}
