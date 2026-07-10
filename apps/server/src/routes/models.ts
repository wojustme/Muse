import type { FastifyInstance } from "fastify";

const models = [
  {
    provider: "openai",
    name: "gpt-4o-mini",
    capabilities: ["streaming", "tools", "vision"],
  },
  {
    provider: "deepseek",
    name: "deepseek-chat",
    capabilities: ["streaming"],
  },
  {
    provider: "glm",
    name: "glm-4-flash",
    capabilities: ["streaming"],
  },
];

export async function modelRoutes(app: FastifyInstance) {
  app.get("/models", async () => {
    return { models };
  });
}
