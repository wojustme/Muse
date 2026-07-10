import { z } from "zod";
import { MESSAGE_ROLES } from "../constants/roles.js";

export const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

export const messageRoleSchema = z.enum(MESSAGE_ROLES);

export const chatMessageSchema = z.object({
  id: z.string().optional(),
  role: messageRoleSchema,
  parts: z.array(textPartSchema).min(1),
  createdAt: z.string().datetime().optional(),
});

export const chatModelSelectionSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
});

export const chatRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: chatMessageSchema,
  model: chatModelSelectionSchema.optional(),
});

export type TextPart = z.infer<typeof textPartSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatModelSelection = z.infer<typeof chatModelSelectionSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
