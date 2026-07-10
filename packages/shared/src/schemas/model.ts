import { z } from "zod";

export const modelCapabilitySchema = z.enum([
  "streaming",
  "tools",
  "vision",
  "reasoning",
  "computerUse",
]);

export const modelProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(z.string().min(1)),
  capabilities: z.array(modelCapabilitySchema),
});

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;
export type ModelProviderDefinition = z.infer<typeof modelProviderSchema>;
