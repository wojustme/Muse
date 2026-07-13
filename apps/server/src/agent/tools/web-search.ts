import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getWebSearchConfig } from "../../config/web-search-config.js";
import type { ToolExecutionContext } from "../types.js";

// Tavily 搜索接口：为 LLM agent 优化，返回已抽取的正文片段与可选的直接答案。
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
// 每条结果正文的展示上限，避免把整页内容塞进 UI / 模型上下文。
const CONTENT_PREVIEW_LIMIT = 2000;

// Tavily 返回结构（仅声明用到的字段）。
type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
};

type TavilyResponse = {
  query?: string;
  answer?: string | null;
  results?: TavilyResult[];
};

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n[content truncated for UI]`
    : value;
}

export function createWebSearchTools(context?: ToolExecutionContext) {
  return {
    WebSearch: tool({
      description:
        "Search the public web for up-to-date information. Use this when the user asks about recent events, current facts, prices, releases, or anything likely outside your training data. Returns ranked results with title, URL, and an extracted content snippet.",
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .describe("Natural-language search query."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(5)
          .describe("Maximum number of results to return."),
      }),
      execute: async ({ query, maxResults }) => {
        const eventId = randomUUID();
        const config = getWebSearchConfig();
        context?.onToolEvent?.({
          type: "tool-start",
          id: eventId,
          name: "WebSearch",
          source: "builtin",
          riskLevel: "read",
          requiresApproval: false,
          input: { query, maxResults },
        });

        if (!config?.api_key) {
          const error =
            "Web search is enabled but its API key is missing. Set web_search.api_key in the Muse system_configs table.";
          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "WebSearch",
            status: "failed",
            error,
          });
          throw new Error(error);
        }

        const startedAt = Date.now();

        try {
          const response = await fetch(TAVILY_ENDPOINT, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.api_key}`,
            },
            body: JSON.stringify({
              query,
              max_results: maxResults,
              include_answer: true,
              search_depth: "basic",
            }),
            signal: AbortSignal.timeout(config.timeout_ms),
          });

          if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(
              `Tavily search failed: ${response.status} ${response.statusText} ${detail}`.trim(),
            );
          }

          const data = (await response.json()) as TavilyResponse;
          const results = (data.results ?? []).map((result) => ({
            title: result.title ?? "",
            url: result.url ?? "",
            content: truncate(result.content ?? "", CONTENT_PREVIEW_LIMIT),
            score: result.score,
          }));

          const output = {
            query,
            answer: data.answer ?? null,
            results,
            durationMs: Date.now() - startedAt,
          };

          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "WebSearch",
            status: "succeeded",
            output,
          });

          return output;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          context?.onToolEvent?.({
            type: "tool-result",
            id: eventId,
            name: "WebSearch",
            status: "failed",
            error: message,
          });
          throw error;
        }
      },
    }),
  };
}
