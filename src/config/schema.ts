import { z } from "zod";
import { DEFAULT_PORT } from "../constants.js";

const triggerMode = z.enum(["save", "commit", "interval", "manual", "passive"]);
const phase = z.object({ name: z.string().min(1), minutes: z.number().positive() });
const placement = z.union([
  z.object({ slot: z.string() }),
  z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }),
]);

export const configSchema = z
  .object({
    port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
    host: z.string().default("127.0.0.1"),
    /** Falls back to goals H1, then branch name, then repo name. */
    title: z.string().nullable().default(null),
    subtitle: z.string().nullable().default(null),

    session: z
      .object({
        preset: z.enum(["90min", "pomodoro", "freeform"]).default("90min"),
        phases: z.array(phase).nullable().default(null),
        autoStart: z.boolean().default(true),
      })
      .strict()
      .default({}),

    tests: z
      .object({
        adapter: z.string().default("auto"),
        command: z.string().nullable().default(null),
        reports: z.array(z.string()).nullable().default(null),
        mode: triggerMode.nullable().default(null),
        debounceMs: z.number().int().nonnegative().nullable().default(null),
        intervalSec: z.number().min(30).default(300),
        timeoutSec: z.number().positive().default(600),
      })
      .strict()
      .default({}),

    goals: z
      .object({
        source: z.enum(["file", "claude-todos", "both", "off"]).default("file"),
        file: z.string().default("GOALS.md"),
        stretchHeading: z.string().default("Stretch"),
      })
      .strict()
      .default({}),

    agent: z
      .object({
        enabled: z.boolean().default(true),
        idleAfterSec: z.number().positive().default(120),
        showPrompts: z.boolean().default(false),
        showCommands: z.boolean().default(true),
      })
      .strict()
      .default({}),

    privacy: z
      .object({
        ignore: z.array(z.string()).default([".env*", "**/secrets/**", "*.pem", "*.key", "id_*"]),
        redactPaths: z.boolean().default(false),
        hideFileNames: z.boolean().default(false),
      })
      .strict()
      .default({}),

    display: z
      .object({
        theme: z.string().default("terminal"),
        tone: z.enum(["plain", "playful"]).default("plain"),
        font: z.string().nullable().default(null),
        css: z.string().nullable().default(null),
        labels: z.record(z.string()).default({}),
        widgets: z.array(z.string()).default(["now", "timer", "git", "tests", "goals", "agent", "commits"]),
        layout: z.record(placement).default({}),
        customWidgets: z.string().nullable().default(null),
        confetti: z.boolean().default(true),
      })
      .strict()
      .default({}),

    custom: z
      .array(z.object({ key: z.string().min(1), command: z.string().min(1), intervalSec: z.number().min(5).default(60) }).strict())
      .default([]),

    obs: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().default(4455),
        password: z.string().nullable().default(null),
        scene: z.string().nullable().default(null),
        mode: z.enum(["widgets", "single"]).default("widgets"),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

export const defaultConfig = (): Config => configSchema.parse({});
