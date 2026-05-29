// Minimal Node.js client using global fetch (Node 18+).
const BASE = process.env.CODECLONE_BASE || "http://127.0.0.1:7461";
const KEY = process.env.CODECLONE_API_KEY || "sk-codeclone-local";

const body = {
  model: "codeclone",
  messages: [{ role: "user", content: "function debounce(fn, ms) {" }],
  max_tokens: 64
};

const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(body)
});

if (!res.ok) {
  console.error("HTTP", res.status, await res.text());
  process.exit(1);
}
const j = await res.json();
console.log(j.choices[0].message.content);
