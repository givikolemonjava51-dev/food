// Vercel serverless function: POST /api/estimate
//   { text: "what I ate" }                      -> Claude estimates calories and macros for a free-text meal
//   { image: "<base64>", mediaType, text? }      -> Claude reads a nutrition label photo; text is how much was eaten
// For labels the model only transcribes per-100 g values and the eaten weight; the totals are computed here.
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

const N = { type: ["number", "null"] };
const LABEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["readable", "name", "per100", "eaten_g", "eaten_basis", "serving_g", "package_g", "note"],
  properties: {
    readable: { type: "boolean", description: "false if the photo has no legible nutrition table" },
    name: { type: "string", description: "Product name in Georgian, 2-5 words (translate if the label is in another language)" },
    per100: {
      type: "object",
      additionalProperties: false,
      required: ["kcal", "protein_g", "carbs_g", "fat_g", "sugar_g", "fiber_g", "salt_g", "sat_fat_g"],
      properties: {
        kcal: { type: "number" }, protein_g: { type: "number" }, carbs_g: { type: "number" }, fat_g: { type: "number" },
        sugar_g: N, fiber_g: N, salt_g: N, sat_fat_g: N,
      },
    },
    serving_g: { ...N, description: "Serving size in g or ml printed on the label, else null" },
    package_g: { ...N, description: "Net weight/volume of the whole package in g or ml, if visible, else null" },
    eaten_g: { type: "number", description: "How many g (or ml) the user ate" },
    eaten_basis: { type: "string", description: "Short Georgian phrase for the eaten amount, e.g. 'მთელი შეკვრა', '1 პორცია', '2 ნაჭერი'" },
    note: { type: "string", description: "One short Georgian sentence: what you assumed or could not read, or an empty string" },
  },
};

const LABEL_SYSTEM = `You read photos of food nutrition labels (nutrition facts tables) for a person in Georgia (the country).
Labels may be in Georgian, Russian, English, Turkish or other languages, and may be photographed at an angle, curved or partly blurred.
- Transcribe the values PER 100 g (or per 100 ml for drinks) into "per100". If the label only gives values per serving/portion, convert them to per 100 g using the serving weight. If energy is only in kJ, divide by 4.184.
- Use the "per 100 g" column, never the "% daily value" column.
- Use null for sugar, fiber, salt and saturated fat when they are not on the label. If only sodium is given, salt = sodium × 2.5.
- The user's text says how much they ate (grams, pieces, servings, "half", "the whole pack", etc.). Convert it to grams in "eaten_g" using the serving or package weight from the label.
- If the user gives no amount: use the whole package when it is clearly a single-serve item (bar, small yoghurt, can, small bag) and its weight is visible; otherwise one serving from the label; otherwise 100 g. Say which you chose in "note".
- If you cannot read the numbers, set readable=false, zeros for numbers, and explain in "note".
- If the photo shows food or a package without a nutrition table, estimate typical per-100 g values for that product, set readable=true and say in "note" that the values are estimated, not read from a label.
- Write all text fields in Georgian.`;

const IMG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function readLabel(body, res) {
  const image = String(body.image || "").replace(/^data:[^,]*,/, "");
  const mediaType = String(body.mediaType || "image/jpeg");
  const text = String(body.text || "").trim();
  if (!IMG_TYPES.includes(mediaType)) return res.status(400).json({ error: "bad_image" });
  if (image.length > 4_000_000) return res.status(413).json({ error: "image_too_big" });
  if (text.length > 800) return res.status(400).json({ error: "too_long" });

  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: LABEL_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: LABEL_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
        { type: "text", text: "How much I ate: " + (text || "(not stated)") },
      ],
    }],
  });
  if (response.stop_reason === "refusal") return res.status(422).json({ error: "refusal" });
  const block = response.content.find((b) => b.type === "text");
  const d = block && safeJSON(block.text);
  if (!d) return res.status(502).json({ error: "bad_output" });
  if (!d.readable) return res.status(422).json({ error: "unreadable", note: String(d.note || "") });

  const num = (n) => (n == null || !isFinite(+n) ? null : Math.max(0, +n));
  const p100 = d.per100 || {};
  const per100 = {
    k: num(p100.kcal) || 0, p: num(p100.protein_g) || 0, c: num(p100.carbs_g) || 0, f: num(p100.fat_g) || 0,
    sugar: num(p100.sugar_g), fiber: num(p100.fiber_g), salt: num(p100.salt_g), sat: num(p100.sat_fat_g),
  };
  const g = Math.round(num(d.eaten_g) || 0);
  const x = (v) => Math.round((v * g) / 100);
  const name = String(d.name || "").slice(0, 80);
  return res.status(200).json({
    name,
    items: [{ food: name || "პროდუქტი", amount: g + " გ" + (d.eaten_basis ? " · " + String(d.eaten_basis).slice(0, 40) : ""), kcal: x(per100.k) }],
    kcal: x(per100.k), p: x(per100.p), c: x(per100.c), f: x(per100.f),
    note: String(d.note || ""),
    label: { per100, g, serving: num(d.serving_g), pack: num(d.package_g) },
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "no_key" });
  }
  const body = (typeof req.body === "string" ? safeJSON(req.body) : req.body) || {};
  if (body.image) {
    try { return await readLabel(body, res); } catch (err) { return apiError(err, res); }
  }
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
    return apiError(err, res);
  }
}

function apiError(err, res) {
  if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "bad_key" });
  if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "rate_limit" });
  if (err instanceof Anthropic.APIError) return res.status(502).json({ error: "api", status: err.status, message: err.message });
  return res.status(500).json({ error: "server" });
}

function safeJSON(s) {
  try { return JSON.parse(s); } catch { return null; }
}
