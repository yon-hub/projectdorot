// Optional: a short partner-grade narrative on top of the deterministic "what moved" data.
import Anthropic from "@anthropic-ai/sdk";
import { MODEL, hasCredentials } from "./reader.mjs";

export async function writeBriefNarrative(week) {
  if (!hasCredentials()) throw new Error("ANTHROPIC_API_KEY not set");
  const client = new Anthropic();
  const compact = {
    since: week.since, counts: week.counts,
    movers: week.movers.slice(0, 15),
    signals: week.signals.slice(0, 40).map((s) => ({ entity: s.entity_name, type: s.entity_type, dim: s.dimension, title: s.title, conf: s.confidence, src: s.source_type })),
    actions: week.actions.slice(0, 10).map((a) => ({ headline: a.headline, play: a.play, path: a.trusted_path, timing: a.timing })),
    front: week.front.filter((f) => f.n >= 3),
  };
  const res = await client.beta.messages.create({
    model: MODEL, max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    thinking: { type: "adaptive" }, output_config: { effort: "medium" },
    system: "You write the Monday brief for the two partners of Intrinsic Labs. Plain prose, no headers, no bullets, no hype. Every sentence either names an account and what to do, or states what the market did. Under 250 words. Never argue for more outreach — only for better outreach.",
    messages: [{ role: "user", content: `Write this week's Ground Truth brief from the engine's data:\n${JSON.stringify(compact, null, 1)}` }],
  });
  if (res.stop_reason === "refusal") throw new Error("brief refused");
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}
