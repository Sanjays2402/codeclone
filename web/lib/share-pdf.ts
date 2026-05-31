// PDF report generation for a saved share, using pdf-lib (pure JS).
// Produces a multi-page A4 report with header, scores, classification,
// rationale, alignment summary, and code side-by-side excerpts.

import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import type { ShareRecord } from "./share";

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

// Brand-ish neutrals (sRGB 0..1).
const INK = rgb(0.08, 0.09, 0.11);
const INK2 = rgb(0.34, 0.36, 0.40);
const INK3 = rgb(0.52, 0.55, 0.59);
const RULE = rgb(0.86, 0.87, 0.89);
const ACCENT = rgb(0.21, 0.41, 0.92);
const POS = rgb(0.12, 0.55, 0.30);
const WARN = rgb(0.78, 0.49, 0.05);
const NEG = rgb(0.72, 0.16, 0.16);

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function ensureRoom(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN) newPage(ctx);
}

function drawText(
  ctx: Ctx,
  text: string,
  opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number } = {},
): void {
  const size = opts.size ?? 10;
  const font = opts.font ?? ctx.font;
  const color = opts.color ?? INK;
  const x = opts.x ?? MARGIN;
  ctx.page.drawText(text, { x, y: ctx.y - size, size, font, color });
  ctx.y -= size + 4;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  for (const para of paragraphs) {
    if (para === "") { out.push(""); continue; }
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      const candidate = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        // Hard-break a single word that exceeds width.
        if (font.widthOfTextAtSize(w, size) > maxWidth) {
          let chunk = "";
          for (const ch of w) {
            const c2 = chunk + ch;
            if (font.widthOfTextAtSize(c2, size) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk = c2;
            }
          }
          line = chunk;
        } else {
          line = w;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function drawWrapped(
  ctx: Ctx,
  text: string,
  opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {},
): void {
  const size = opts.size ?? 10;
  const font = opts.font ?? ctx.font;
  const width = opts.width ?? CONTENT_W;
  const lines = wrap(text, font, size, width);
  for (const ln of lines) {
    ensureRoom(ctx, size + 4);
    drawText(ctx, ln, { size, font, color: opts.color, x: opts.x });
  }
}

function rule(ctx: Ctx, color = RULE): void {
  ensureRoom(ctx, 10);
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y - 2 },
    end: { x: PAGE_W - MARGIN, y: ctx.y - 2 },
    thickness: 0.5,
    color,
  });
  ctx.y -= 10;
}

function eyebrow(ctx: Ctx, text: string): void {
  ensureRoom(ctx, 16);
  drawText(ctx, text.toUpperCase(), { size: 8, font: ctx.mono, color: INK3 });
}

function scoreColor(v: number): ReturnType<typeof rgb> {
  if (v >= 0.85) return POS;
  if (v >= 0.55) return WARN;
  if (v >= 0.25) return INK2;
  return NEG;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function sanitizeForPdf(s: string): string {
  // pdf-lib's StandardFonts (WinAnsi) cannot encode characters outside Latin-1.
  // Replace common offenders and strip the rest.
  return s
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2022]/g, "*")
    .replace(/[\u2026]/g, "...")
    .replace(/[\u00A0]/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA1-\xFF]/g, "?");
}

function drawScoreCell(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: number,
  primary: boolean,
  font: PDFFont,
  mono: PDFFont,
): void {
  ctx.page.drawRectangle({ x, y: y - h, width: w, height: h, borderColor: RULE, borderWidth: 0.5 });
  ctx.page.drawText(label.toUpperCase(), { x: x + 10, y: y - 18, size: 7.5, font: mono, color: INK3 });
  const valStr = value.toFixed(3);
  const size = primary ? 26 : 18;
  ctx.page.drawText(valStr, { x: x + 10, y: y - 18 - size - 4, size, font: mono, color: INK });
  // Tone bar at bottom.
  ctx.page.drawRectangle({
    x: x + 10,
    y: y - h + 12,
    width: Math.max(2, (w - 20) * Math.max(0, Math.min(1, value))),
    height: 3,
    color: scoreColor(value),
  });
}

export interface BuildPdfOptions {
  origin?: string;
}

export async function buildShareReportPdf(
  rec: ShareRecord,
  opts: BuildPdfOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`codeclone report ${rec.id}`);
  doc.setSubject(`Clone analysis: ${rec.result.clone.label}`);
  doc.setProducer("codeclone");
  doc.setCreator("codeclone");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
    font,
    bold,
    mono,
  };

  // Header.
  drawText(ctx, "codeclone", { size: 11, font: bold, color: ACCENT });
  drawText(ctx, "shared result report", { size: 8, font: mono, color: INK3 });
  ctx.y -= 6;

  const { result, language, createdAt, id, title, tags } = rec;
  const headline = sanitizeForPdf(
    `${result.clone.label} - ${(result.scores.shingleJaccard * 100).toFixed(1)}% similar`,
  );
  drawWrapped(ctx, headline, { size: 18, font: bold });
  ctx.y -= 2;
  const meta = `${result.method} | ${result.latency_ms.toFixed(2)} ms | ${result.bytes.a}/${result.bytes.b} bytes | lang ${language} | saved ${formatTs(createdAt)}`;
  drawText(ctx, meta, { size: 9, font: mono, color: INK3 });

  if (title) {
    drawText(ctx, sanitizeForPdf(`Title: ${title}`), { size: 10, font: bold });
  }
  if (tags && tags.length > 0) {
    drawText(ctx, sanitizeForPdf(`Tags: ${tags.join(", ")}`), { size: 9, color: INK2 });
  }
  if (opts.origin) {
    drawText(ctx, sanitizeForPdf(`${opts.origin}/r/${id}`), { size: 9, font: mono, color: ACCENT });
  } else {
    drawText(ctx, sanitizeForPdf(`/r/${id}`), { size: 9, font: mono, color: ACCENT });
  }

  rule(ctx);

  // Scores grid.
  eyebrow(ctx, "similarity scores");
  ctx.y -= 4;
  ensureRoom(ctx, 90);
  const cellW = (CONTENT_W - 16) / 3;
  const cellH = 78;
  const top = ctx.y;
  drawScoreCell(ctx, MARGIN, top, cellW, cellH, "shingle jaccard 5-gram", result.scores.shingleJaccard, true, font, mono);
  drawScoreCell(ctx, MARGIN + cellW + 8, top, cellW, cellH, "token jaccard", result.scores.tokenJaccard, false, font, mono);
  drawScoreCell(ctx, MARGIN + (cellW + 8) * 2, top, cellW, cellH, "containment", result.scores.containment, false, font, mono);
  ctx.y = top - cellH - 14;

  rule(ctx);

  // Clone classification.
  eyebrow(ctx, "clone classification (bellon/roy)");
  ctx.y -= 4;
  drawText(ctx, sanitizeForPdf(result.clone.label), { size: 13, font: bold });
  const cls = result.clone;
  const clsLine = `type ${cls.type} | confidence ${cls.confidence.toFixed(2)} | structural ${cls.structuralSim.toFixed(3)} | raw token ${cls.rawTokenSim.toFixed(3)}`;
  drawText(ctx, clsLine, { size: 9, font: mono, color: INK3 });
  if (cls.rationale && cls.rationale.length) {
    ctx.y -= 2;
    eyebrow(ctx, "why");
    for (const r of cls.rationale) {
      drawWrapped(ctx, sanitizeForPdf("- " + r), { size: 10 });
    }
  }

  rule(ctx);

  // Coverage stats.
  eyebrow(ctx, "coverage");
  ctx.y -= 4;
  const sc = result.scores;
  const cov = [
    `shared tokens: ${sc.shared.tokens}`,
    `shared 5-shingles: ${sc.shared.shingles}`,
    `A: ${sc.size.aTokens} tokens / ${sc.size.aShingles} shingles`,
    `B: ${sc.size.bTokens} tokens / ${sc.size.bShingles} shingles`,
  ];
  for (const line of cov) drawText(ctx, line, { size: 10, font: mono });

  // Page 2+: source excerpts.
  newPage(ctx);
  eyebrow(ctx, "source A excerpt");
  ctx.y -= 4;
  drawCodeBlock(ctx, rec.a, 80);
  ctx.y -= 8;
  eyebrow(ctx, "source B excerpt");
  ctx.y -= 4;
  drawCodeBlock(ctx, rec.b, 80);

  // Footer on the last page.
  ctx.page.drawText("generated by codeclone", {
    x: MARGIN,
    y: 24,
    size: 7.5,
    font: mono,
    color: INK3,
  });

  return await doc.save();
}

function drawCodeBlock(ctx: Ctx, source: string, maxLines: number): void {
  const size = 8.5;
  const lineH = size + 2;
  const cols = Math.floor((CONTENT_W - 28) / ctx.mono.widthOfTextAtSize("M", size));
  const raw = source.split(/\r?\n/);
  const truncated = raw.length > maxLines;
  const taken = raw.slice(0, maxLines);
  // Box.
  const blockH = Math.min(taken.length, maxLines) * lineH + 14;
  ensureRoom(ctx, blockH + 6);
  const top = ctx.y;
  ctx.page.drawRectangle({
    x: MARGIN,
    y: top - blockH,
    width: CONTENT_W,
    height: blockH,
    borderColor: RULE,
    borderWidth: 0.5,
  });
  let y = top - 12;
  for (let i = 0; i < taken.length; i++) {
    let line = sanitizeForPdf(taken[i].replace(/\t/g, "    "));
    if (line.length > cols) line = line.slice(0, cols - 1) + "\u00BB";
    const num = String(i + 1).padStart(3, " ");
    ctx.page.drawText(num, { x: MARGIN + 6, y, size, font: ctx.mono, color: INK3 });
    ctx.page.drawText(line, { x: MARGIN + 30, y, size, font: ctx.mono, color: INK });
    y -= lineH;
    if (y < MARGIN + 20) {
      // Continue on a new page.
      ctx.y = top - blockH;
      newPage(ctx);
      // Re-open box on new page.
      const remaining = taken.slice(i + 1);
      if (remaining.length === 0) return;
      drawCodeBlock(ctx, remaining.join("\n"), maxLines - (i + 1));
      return;
    }
  }
  ctx.y = top - blockH - 4;
  if (truncated) {
    drawText(ctx, `... ${raw.length - maxLines} more lines (truncated for PDF)`, {
      size: 8,
      font: ctx.mono,
      color: INK3,
    });
  }
}
