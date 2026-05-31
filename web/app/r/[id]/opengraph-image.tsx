import { ImageResponse } from "next/og";
import { loadShare, shareSummary } from "../../../lib/share";
import { pctColor, fmtBytes, fmtPct } from "../../../lib/og-share";

export const runtime = "nodejs";
export const alt = "codeclone shared similarity result";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: { id: string } }) {
  const rec = await loadShare(params.id);

  if (!rec) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            background: "#ffffff",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            color: "#18181b",
          }}
        >
          <div style={{ fontSize: 28, color: "#71717a", letterSpacing: 4, textTransform: "uppercase" }}>
            codeclone
          </div>
          <div style={{ fontSize: 64, marginTop: 24, fontWeight: 500 }}>
            Shared result not found
          </div>
        </div>
      ),
      size,
    );
  }

  const s = shareSummary(rec);
  const tone = pctColor(s.shingleJaccard);
  const pctText = fmtPct(s.shingleJaccard);
  const title = s.title?.trim() || s.cloneLabel;
  const subtitle = `${s.language} · ${fmtBytes(rec.result.bytes.a)} vs ${fmtBytes(rec.result.bytes.b)}`;
  const scores = rec.result.scores;
  const stats: Array<[string, string]> = [
    ["Token Jaccard", scores.tokenJaccard.toFixed(3)],
    ["Containment", scores.containment.toFixed(3)],
    ["Shared Tokens", String(scores.shared.tokens)],
    ["Latency", `${rec.result.latency_ms} ms`],
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#ffffff",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          color: "#18181b",
          padding: 64,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #e4e4e7",
            paddingBottom: 24,
          }}
        >
          <div
            style={{
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "#71717a",
              fontWeight: 500,
            }}
          >
            codeclone
          </div>
          <div
            style={{
              fontSize: 18,
              color: "#a1a1aa",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
            }}
          >
            /r/{s.id}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            marginTop: 40,
            gap: 48,
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 360,
              height: 360,
              background: tone.bg,
              border: `2px solid ${tone.border}`,
              borderRadius: 24,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 22,
                color: tone.ink,
                letterSpacing: 3,
                textTransform: "uppercase",
                fontWeight: 500,
              }}
            >
              Similarity
            </div>
            <div
              style={{
                fontSize: 132,
                fontWeight: 600,
                lineHeight: 1,
                marginTop: 12,
                color: tone.ink,
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
            >
              {pctText}
            </div>
            <div
              style={{
                fontSize: 22,
                color: tone.ink,
                marginTop: 16,
                letterSpacing: 2,
                textTransform: "uppercase",
              }}
            >
              {s.cloneLabel}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              gap: 18,
            }}
          >
            <div
              style={{
                fontSize: 48,
                fontWeight: 500,
                lineHeight: 1.15,
                color: "#18181b",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {title}
            </div>
            <div style={{ fontSize: 24, color: "#52525b", display: "flex" }}>{subtitle}</div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 12,
                marginTop: 16,
              }}
            >
              {stats.map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: "12px 18px",
                    border: "1px solid #e4e4e7",
                    borderRadius: 10,
                    background: "#fafafa",
                    minWidth: 160,
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      color: "#71717a",
                      letterSpacing: 2,
                      textTransform: "uppercase",
                    }}
                  >
                    {k}
                  </div>
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 500,
                      marginTop: 4,
                      color: "#18181b",
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    }}
                  >
                    {v}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #e4e4e7",
            paddingTop: 20,
            marginTop: 24,
            fontSize: 18,
            color: "#71717a",
          }}
        >
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(s.tags ?? []).slice(0, 5).map((t) => (
              <div
                key={t}
                style={{
                  display: "flex",
                  padding: "4px 12px",
                  border: "1px solid #e4e4e7",
                  borderRadius: 999,
                  fontSize: 16,
                  color: "#52525b",
                  background: "#fafafa",
                }}
              >
                #{t}
              </div>
            ))}
          </div>
          <div style={{ display: "flex" }}>
            Code clone detection · Side by side diff
          </div>
        </div>
      </div>
    ),
    size,
  );
}
