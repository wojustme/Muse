import { tool } from "ai";
import { z } from "zod";

export const timeTools = {
  time_now: tool({
    description:
      "Get the current date and time. Use this when the user asks about today, now, current time, or relative dates.",
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone name, for example Asia/Shanghai."),
      locale: z
        .string()
        .optional()
        .describe("BCP 47 locale, for example zh-CN or en-US."),
    }),
    execute: ({ timezone, locale }) => {
      const now = new Date();
      const resolvedTimezone =
        timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const resolvedLocale = locale ?? "zh-CN";

      return {
        iso: now.toISOString(),
        unixMs: now.getTime(),
        timezone: resolvedTimezone,
        locale: resolvedLocale,
        formatted: new Intl.DateTimeFormat(resolvedLocale, {
          dateStyle: "full",
          timeStyle: "medium",
          timeZone: resolvedTimezone,
        }).format(now),
      };
    },
  }),
};
