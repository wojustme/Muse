import { z } from "zod";

export const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  modelProvider: z.string().optional(),
  modelName: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;
