// Vercel serverless function: POST /api/estimate { text: "what I ate" }
// Asks Claude to estimate calories and macros for a free-text meal description.
// Needs the ANTHROPIC_API_KEY environment variable in the Vercel project settings.
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "items", "kcal", "protein_g", "carbs_g", "fat_g", "note"],
  properties: {
    name: { type: "string", description: "Short dish name in Georgian, 2-5 words" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["food", "amount", "kcal"],
        properties: {
          food: { type: "string", description: "Food name in Georgian" },
          amount: { type: "string", description: "Assumed portion in Georgian, e.g. 150 გ, 1 ცალი" },
          kcal: { type: "number" },
        },
      },
    },
    kcal: { type: "number" },
    protein_g: { type: "number" },
    carbs_g: { type: "number" },
    fat_g: { type: "number" },
    note: { type: "string", description: "One short sentence in Georgian about the main assumption, or an empty string" },
  },
};

const SYSTEM = `You are a nutrition assistant for a person in Georgia (the country) tracking a 2000 kcal / 180 g protein diet.
The user writes, usually in Georgian, what they actually ate for one meal. Estimate calories and macros for everything listed.
- Know Georgian dishes and their typical restaurant/home portions (khachapuri, khinkali, lobiani, mtsvadi, pkhali, churchkhela, etc.).
- When an amount is missing, assume one typical single portion and say so in "note".
- Count drinks, sauces and oil when mentioned.
- "kcal", "protein_g", "carbs_g", "fat_g" are totals for the whole meal, rounded to whole numbers. "kcal" equals the sum of the items.
- Write every text field in Georgian.
- If the text is not food at all, return zero for every number and explain in "note".`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "no_key" });
  }
  const body = typeof req.body === "string" ? safeJSON(req.body) : req.body || {};
  const text = String(body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  if (text.length > 800) return res.status(400).json({ error: "too_long" });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: text }],
    });
    if (response.stop_reason === "refusal") return res.status(422).json({ error: "refusal" });
    const block = response.content.find((b) => b.type === "text");
    const data = block && safeJSON(block.text);
    if (!data) return res.status(502).json({ error: "bad_output" });
    const r = (n) => Math.max(0, Math.round(Number(n) || 0));
    return res.status(200).json({
      name: String(data.name || "").slice(0, 80),
      items: (data.items || []).slice(0, 20).map((x) => ({ food: String(x.food), amount: String(x.amount), kcal: r(x.kcal) })),
      kcal: r(data.kcal),
      p: r(data.protein_g),
      c: r(data.carbs_g),
      f: r(data.fat_g),
      note: String(data.note || ""),
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "bad_key" });
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limit" });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: "api", status: err.status, message: err.message });
    return res.status(500).json({ error: "server" });
  }
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}
