import { z } from "zod";

export const TextPromptDataSchema = z
  .object({
    label: z.string().default(""),
    prompt: z.string().default(""),
    optimizedPrompt: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const ImageGenDataSchema = z
  .object({
    label: z.string().default(""),
    prompt: z.string().default(""),
    negativePrompt: z.string().optional(),
    modelId: z.string().optional(),
    aspectRatio: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const VideoGenDataSchema = z
  .object({
    label: z.string().default(""),
    prompt: z.string().default(""),
    modelId: z.string().optional(),
    aspectRatio: z.string().optional(),
    duration: z.number().or(z.string()).optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const MediaAssetDataSchema = z
  .object({
    label: z.string().default(""),
    assetId: z.string().optional(),
    assetKind: z.enum(["image", "video"]).optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const BaseNodeDataSchema = z
  .object({
    label: z.string().default(""),
    prompt: z.string().optional(),
    optimizedPrompt: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const NODE_DATA_SCHEMAS: Record<string, z.ZodTypeAny> = {
  "text.prompt": TextPromptDataSchema,
  "image.gen": ImageGenDataSchema,
  "video.gen": VideoGenDataSchema,
  "media.asset": MediaAssetDataSchema,
};

export function getNodeDataSchema(type: string): z.ZodTypeAny {
  return NODE_DATA_SCHEMAS[type] ?? BaseNodeDataSchema;
}

export function parseNodeData(type: string, raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const schema = getNodeDataSchema(type);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return result.data as Record<string, unknown>;
    }
    // Fallback to raw parsed data on validation failure (for backward compatibility)
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type TextPromptData = z.infer<typeof TextPromptDataSchema>;
export type ImageGenData = z.infer<typeof ImageGenDataSchema>;
export type VideoGenData = z.infer<typeof VideoGenDataSchema>;
export type MediaAssetData = z.infer<typeof MediaAssetDataSchema>;
