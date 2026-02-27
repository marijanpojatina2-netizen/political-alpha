// =============================================================================
// POLITICAL ALPHA — Daily Newsletter Cron Job
// =============================================================================
// Vercel Serverless Function triggered daily at 08:00 CET.
// Pipeline: Multi-source scraping → Gemini AI Analysis → HTML Email → Resend
//
// SCRAPING STRATEGY (2025/2026 compatible):
//   1. Twitter Syndication API (no auth, used by embed widgets)
//   2. QuiverQuant public congress trading data
//   3. Google News RSS fallback for "congress stock trading"
//   Each source is independent — if one fails, others still work.
// =============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Resend } = require("resend");
const { readFileSync } = require("fs");
const { join } = require("path");

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const TWITTER_HANDLES = [
  "pelositracker",
  "capitol2iq",
  "QuiverQuant",
  "unusual_whales",
];

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// STRATEGY 1: Twitter Syndication API
// ---------------------------------------------------------------------------
// Twitter's syndication endpoint (used for embedded timelines) is publicly
// accessible without API keys. It returns up to ~20 recent tweets per user.
// Endpoint: https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}
// Returns HTML that we parse for tweet text and timestamps.
// ---------------------------------------------------------------------------

async function fetchViaSyndication(handle) {
  const tweets = [];
  const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

  try {
    // Method A: syndication timeline endpoint
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });

    if (!resp.ok) {
      console.warn(`[Syndication] @${handle}: HTTP ${resp.status}`);
      // Try Method B: search via syndication
      return await fetchViaSearchSyndication(handle);
    }

    const html = await resp.text();

    // Extract tweet data from the embedded timeline HTML.
    // Tweets are in <div> blocks with data-tweet-id attributes or in script JSON.
    // Look for the __NEXT_DATA__ or embedded JSON in the response.
    const jsonMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        const entries = extractTweetsFromSyndicationData(data);
        for (const entry of entries) {
          const tweetTime = new Date(entry.created_at).getTime();
          if (tweetTime >= cutoff) {
            tweets.push({
              source: `twitter/@${handle}`,
              text: entry.text,
              date: entry.created_at,
            });
          }
        }
      } catch (e) {
        console.warn(`[Syndication] @${handle}: JSON parse failed`);
      }
    }

    // Fallback: extract tweets from raw HTML using regex patterns
    if (tweets.length === 0) {
      const tweetBlocks = html.match(/data-tweet-id="(\d+)"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g) || [];
      for (const block of tweetBlocks) {
        const textMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        if (textMatch) {
          tweets.push({
            source: `twitter/@${handle}`,
            text: stripHtml(textMatch[1]),
            date: new Date().toISOString(),
          });
        }
      }
    }

    if (tweets.length > 0) {
      console.log(`[Syndication] @${handle}: ${tweets.length} tweets`);
    } else {
      console.log(`[Syndication] @${handle}: no parseable tweets, trying search fallback`);
      return await fetchViaSearchSyndication(handle);
    }
  } catch (err) {
    console.warn(`[Syndication] @${handle} error: ${err.message}`);
    return await fetchViaSearchSyndication(handle);
  }

  return tweets;
}

function extractTweetsFromSyndicationData(data) {
  const tweets = [];
  try {
    // Navigate the __NEXT_DATA__ structure to find tweet objects
    const props = data?.props?.pageProps;
    const timeline = props?.timeline?.entries || props?.timeline || [];
    for (const entry of (Array.isArray(timeline) ? timeline : [])) {
      const tweet = entry?.content?.tweet || entry?.tweet || entry;
      if (tweet?.text) {
        tweets.push({
          text: tweet.text,
          created_at: tweet.created_at || tweet.createdAt || new Date().toISOString(),
        });
      }
    }
  } catch (e) { /* structure mismatch, return empty */ }
  return tweets;
}

// Backup: use Twitter's search syndication
async function fetchViaSearchSyndication(handle) {
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?showReplies=false`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
      redirect: "follow",
    });
    if (!resp.ok) return [];

    const html = await resp.text();
    // Try to find any tweet-like text content
    const texts = [];
    const matches = html.matchAll(/<p[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([\s\S]*?)<\/p>/gi);
    for (const m of matches) {
      texts.push({
        source: `twitter/@${handle}`,
        text: stripHtml(m[1]),
        date: new Date().toISOString(),
      });
    }
    return texts;
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// STRATEGY 2: QuiverQuant Congress Trading (public page scrape)
// ---------------------------------------------------------------------------
// QuiverQuant has a public-facing congress trading page. We fetch the HTML
// and extract the most recent trades table data.
// ---------------------------------------------------------------------------

async function fetchQuiverQuantData() {
  const trades = [];
  try {
    const resp = await fetch("https://www.quiverquant.com/congresstrading/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });

    if (!resp.ok) {
      console.warn(`[QuiverQuant] HTTP ${resp.status}`);
      return trades;
    }

    const html = await resp.text();

    // Look for embedded data in script tags (QuiverQuant uses React/Next.js)
    const dataMatches = html.match(/<script[^>]*>[\s\S]*?congressTrading[\s\S]*?<\/script>/gi) || [];
    for (const script of dataMatches) {
      const jsonStr = script.match(/\[[\s\S]*?\]/);
      if (jsonStr) {
        try {
          const data = JSON.parse(jsonStr[0]);
          for (const item of data.slice(0, 20)) {
            trades.push({
              source: "QuiverQuant",
              text: `Congress trade: ${item.Representative || item.politician || "Unknown"} - ${item.Transaction || item.type || "Unknown"} ${item.Ticker || item.ticker || "?"} (${item.Amount || item.amount || "?"})`,
              date: item.TransactionDate || item.date || new Date().toISOString(),
            });
          }
        } catch (e) { /* parse error, continue */ }
      }
    }

    // Also try to extract from visible HTML table rows
    if (trades.length === 0) {
      const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
      let count = 0;
      for (const row of rowMatches) {
        if (count++ < 2) continue; // skip header rows
        if (count > 22) break; // max 20 rows
        const cells = [];
        const cellMatches = row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        for (const cell of cellMatches) {
          cells.push(stripHtml(cell[1]).trim());
        }
        if (cells.length >= 3) {
          trades.push({
            source: "QuiverQuant",
            text: `Congress trade: ${cells.join(" | ")}`,
            date: cells[0] || new Date().toISOString(),
          });
        }
      }
    }

    console.log(`[QuiverQuant] ${trades.length} trades found`);
  } catch (err) {
    console.warn(`[QuiverQuant] Error: ${err.message}`);
  }
  return trades;
}

// ---------------------------------------------------------------------------
// STRATEGY 3: Google News RSS for "congress stock trading" and related terms
// ---------------------------------------------------------------------------
// Google News provides an RSS feed for any search query. This is a reliable
// fallback that always works and gives us recent news about political trading.
// ---------------------------------------------------------------------------

async function fetchGoogleNewsRSS() {
  const items = [];
  const queries = [
    "congress+stock+trading",
    "politician+insider+trading+stocks",
  ];

  for (const query of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
      });

      if (!resp.ok) {
        console.warn(`[GoogleNews] HTTP ${resp.status} for query: ${query}`);
        continue;
      }

      const xml = await resp.text();
      const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

      // Parse RSS XML items
      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
      for (const match of itemMatches) {
        const titleMatch = match[1].match(/<title>([\s\S]*?)<\/title>/);
        const pubDateMatch = match[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        const descMatch = match[1].match(/<description>([\s\S]*?)<\/description>/);

        const title = titleMatch ? stripHtml(titleMatch[1]) : "";
        const pubDate = pubDateMatch ? pubDateMatch[1] : "";
        const desc = descMatch ? stripHtml(descMatch[1]) : "";

        // Filter to last 24h
        const itemTime = pubDate ? new Date(pubDate).getTime() : 0;
        if (itemTime >= cutoff && title) {
          items.push({
            source: "Google News",
            text: `${title}. ${desc}`.trim(),
            date: pubDate,
          });
        }
      }
    } catch (err) {
      console.warn(`[GoogleNews] Error for "${query}": ${err.message}`);
    }
  }

  // Deduplicate by title similarity
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.text.substring(0, 60).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  console.log(`[GoogleNews] ${unique.length} relevant articles found`);
  return unique.slice(0, 15); // Cap at 15 articles
}

// ---------------------------------------------------------------------------
// UTILITY
// ---------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// MASTER SCRAPER — Run all strategies in parallel
// ---------------------------------------------------------------------------

async function gatherAllData() {
  const errors = [];
  let allItems = [];

  // Run all strategies in parallel
  const [twitterResults, quiverResult, newsResult] = await Promise.allSettled([
    // Strategy 1: Twitter syndication for all handles
    Promise.allSettled(TWITTER_HANDLES.map((h) => fetchViaSyndication(h))).then(
      (results) => {
        const tweets = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            tweets.push(...r.value);
          } else {
            errors.push(`Twitter @${TWITTER_HANDLES[i]}`);
          }
        });
        return tweets;
      }
    ),
    // Strategy 2: QuiverQuant
    fetchQuiverQuantData(),
    // Strategy 3: Google News RSS
    fetchGoogleNewsRSS(),
  ]);

  // Collect successful results
  if (twitterResults.status === "fulfilled") {
    allItems.push(...twitterResults.value);
  } else {
    errors.push("Twitter (all)");
  }

  if (quiverResult.status === "fulfilled") {
    allItems.push(...quiverResult.value);
  } else {
    errors.push("QuiverQuant");
  }

  if (newsResult.status === "fulfilled") {
    allItems.push(...newsResult.value);
  } else {
    errors.push("Google News");
  }

  console.log(`[Gather] Total items: ${allItems.length} | Errors: ${errors.length}`);
  return { allItems, errors };
}

// ---------------------------------------------------------------------------
// AI ANALYSIS — Send data to Gemini for structured extraction
// ---------------------------------------------------------------------------

const GEMINI_SYSTEM_PROMPT = `You are an expert financial analyst writing for a newsletter called "Political Alpha".

Review the provided data from multiple sources (tweets, trading records, news) regarding insider trading from politicians and financial whales over the last 24 hours.

Your tasks:
1) Identify the top 2 most significant or most discussed trades and label them as "High Trade Alert". Provide a brief, punchy summary for each (2-3 sentences max). Include the ticker symbol, politician/whale name, and why it matters.
2) Extract all OTHER remaining trades and format them into an array of objects with these exact keys: date, entity, ticker, transaction, amount.
   - "date" = the date of the trade or tweet (YYYY-MM-DD)
   - "entity" = Politician or whale name
   - "ticker" = Stock ticker symbol (e.g. AAPL, NVDA)
   - "transaction" = "BUY" or "SELL"
   - "amount" = Dollar amount or share count as reported

Return your response as VALID JSON only, no markdown fences, matching this schema exactly:
{
  "highAlerts": [
    { "title": "Short punchy headline", "summary": "2-3 sentence analysis", "ticker": "AAPL", "entity": "Nancy Pelosi", "transaction": "BUY" }
  ],
  "otherTrades": [
    { "date": "2025-01-15", "entity": "Name", "ticker": "NVDA", "transaction": "SELL", "amount": "$500K-$1M" }
  ],
  "marketNote": "One sentence overall market sentiment note based on the trading patterns."
}

If there are no identifiable trades in the data, still analyze any news for market sentiment and return:
{ "highAlerts": [], "otherTrades": [], "marketNote": "Your analysis of the current political trading landscape." }`;

async function analyzeWithGemini(items) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const itemText = items
    .map((t, i) => `[${i + 1}] (${t.source}, ${new Date(t.date).toLocaleDateString()}): ${t.text}`)
    .join("\n\n");

  const prompt = `Here is data from the last 24 hours:\n\n${itemText}\n\nAnalyze these and return the structured JSON as instructed.`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
  });

  const responseText = result.response.text();
  const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// HTML EMAIL TEMPLATE
// ---------------------------------------------------------------------------

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildEmailHtml(analysis, itemCount, errors) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  let highAlertsHtml = "";
  if (analysis.highAlerts && analysis.highAlerts.length > 0) {
    highAlertsHtml = analysis.highAlerts.map((alert, i) => `
      <div style="background:#1a1a2e;border-left:4px solid #e94560;padding:20px 24px;margin-bottom:16px;border-radius:0 8px 8px 0;">
        <span style="background:#e94560;color:#fff;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;text-transform:uppercase;">HIGH TRADE ALERT #${i + 1}</span>
        <h2 style="color:#ffffff;font-size:22px;font-weight:800;margin:12px 0 8px 0;line-height:1.3;">${escHtml(alert.title)}</h2>
        <div style="margin-bottom:10px;">
          <span style="background:#0f3460;color:#00d2ff;padding:3px 10px;border-radius:4px;font-size:13px;font-weight:700;margin-right:8px;">${escHtml(alert.ticker || "N/A")}</span>
          <span style="color:${alert.transaction === "BUY" ? "#00ff88" : "#ff4757"};font-weight:700;font-size:13px;">${escHtml(alert.transaction || "N/A")}</span>
          <span style="color:#8892b0;font-size:13px;margin-left:8px;">- ${escHtml(alert.entity || "Unknown")}</span>
        </div>
        <p style="color:#ccd6f6;font-size:15px;line-height:1.6;margin:0;">${escHtml(alert.summary)}</p>
      </div>`).join("");
  } else {
    highAlertsHtml = `<div style="background:#1a1a2e;padding:24px;border-radius:8px;text-align:center;"><p style="color:#8892b0;font-size:15px;margin:0;">No high-priority trades detected in the last 24 hours.</p></div>`;
  }

  let tableHtml = "";
  if (analysis.otherTrades && analysis.otherTrades.length > 0) {
    const rows = analysis.otherTrades.map((trade) => `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ccd6f6;font-size:13px;">${escHtml(trade.date || "-")}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ffffff;font-weight:600;font-size:13px;">${escHtml(trade.entity || "-")}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-size:13px;"><span style="background:#0f3460;color:#00d2ff;padding:2px 8px;border-radius:3px;font-weight:700;">${escHtml(trade.ticker || "-")}</span></td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-size:13px;"><span style="color:${trade.transaction === "BUY" ? "#00ff88" : "#ff4757"};font-weight:700;">${escHtml(trade.transaction || "-")}</span></td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ccd6f6;font-size:13px;">${escHtml(trade.amount || "-")}</td>
        </tr>`).join("");
    tableHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#12121f;border-radius:8px;overflow:hidden;border-collapse:collapse;">
        <thead><tr style="background:#0f3460;">
          <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Date</th>
          <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Entity</th>
          <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Ticker</th>
          <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Type</th>
          <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } else {
    tableHtml = `<div style="background:#12121f;padding:24px;border-radius:8px;text-align:center;"><p style="color:#8892b0;font-size:14px;margin:0;">No additional trades to report today.</p></div>`;
  }

  const errorNotice = errors.length > 0
    ? `<div style="background:#2d1b1b;border:1px solid #e94560;padding:12px 16px;border-radius:6px;margin-bottom:24px;"><p style="color:#ff6b6b;font-size:12px;margin:0;">Some data sources were unreachable: ${errors.map(escHtml).join(", ")}. Results may be incomplete.</p></div>`
    : "";

  const sourceBadges = `
    <div style="margin-bottom:24px;">
      <span style="background:#16213e;color:#8892b0;padding:4px 10px;border-radius:12px;font-size:11px;margin-right:6px;">Twitter Syndication</span>
      <span style="background:#16213e;color:#8892b0;padding:4px 10px;border-radius:12px;font-size:11px;margin-right:6px;">QuiverQuant</span>
      <span style="background:#16213e;color:#8892b0;padding:4px 10px;border-radius:12px;font-size:11px;">Google News</span>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Political Alpha</title></head>
<body style="margin:0;padding:0;background-color:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:0;">
  <div style="background:linear-gradient(135deg,#0f3460 0%,#1a1a2e 50%,#16213e 100%);padding:48px 32px 40px 32px;text-align:center;border-bottom:3px solid #e94560;">
    <h1 style="color:#ffffff;font-size:48px;font-weight:900;margin:0 0 4px 0;letter-spacing:-1px;line-height:1.1;">POLITICAL<span style="color:#e94560;">ALPHA</span></h1>
    <p style="color:#8892b0;font-size:13px;font-weight:500;margin:8px 0 0 0;letter-spacing:3px;text-transform:uppercase;">Daily Insider Trading Intelligence</p>
    <p style="color:#4a5568;font-size:12px;margin:16px 0 0 0;">${today} | ${itemCount} data points analyzed</p>
  </div>
  <div style="padding:32px 24px;background-color:#0a0a14;">
    ${errorNotice}
    ${sourceBadges}
    ${analysis.marketNote ? `<div style="background:#16213e;border-radius:8px;padding:16px 20px;margin-bottom:28px;"><p style="color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 6px 0;">MARKET PULSE</p><p style="color:#ccd6f6;font-size:14px;line-height:1.5;margin:0;">${escHtml(analysis.marketNote)}</p></div>` : ""}
    <h2 style="color:#e94560;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">High Trade Alerts</h2>
    ${highAlertsHtml}
    <h2 style="color:#00d2ff;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:36px 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">Other Trades</h2>
    ${tableHtml}
  </div>
  <div style="background:#0f0f1a;padding:24px 32px;text-align:center;border-top:1px solid #1a1a2e;">
    <p style="color:#4a5568;font-size:11px;margin:0 0 8px 0;">Political Alpha - Automated financial intelligence</p>
    <p style="color:#3a3a5c;font-size:10px;margin:0;">This is not financial advice. Data sourced from public social media and news. Always do your own research.</p>
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// EMAIL DELIVERY
// ---------------------------------------------------------------------------

async function sendNewsletter(html, subscriberEmails) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const BATCH_SIZE = 50;
  const results = [];

  for (let i = 0; i < subscriberEmails.length; i += BATCH_SIZE) {
    const batch = subscriberEmails.slice(i, i + BATCH_SIZE);
    try {
      const { data, error } = await resend.emails.send({
        from: "Political Alpha <onboarding@resend.dev>",
        to: batch.length === 1 ? batch[0] : "Political Alpha <onboarding@resend.dev>",
        bcc: batch.length > 1 ? batch : undefined,
        subject: `Political Alpha - ${today} Daily Briefing`,
        html,
      });
      if (error) {
        console.error("[Email] Send error:", error);
        results.push({ error });
      } else {
        console.log(`[Email] Sent to ${batch.length} subscribers`);
        results.push({ success: true, id: data?.id, count: batch.length });
      }
    } catch (err) {
      console.error("[Email] Exception:", err.message);
      results.push({ error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // Auth check
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("=== POLITICAL ALPHA - CRON START ===");
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    // STEP 1: Gather data from all sources
    console.log("[Step 1] Gathering data from all sources...");
    const { allItems, errors: gatherErrors } = await gatherAllData();
    console.log(`[Step 1] Total data points: ${allItems.length}`);

    // STEP 2: AI Analysis
    let analysis;
    if (allItems.length === 0) {
      console.log("[Step 2] No data - using empty template");
      analysis = {
        highAlerts: [],
        otherTrades: [],
        marketNote: "No trading activity data was available from any source in the last 24 hours. All data sources may be temporarily unavailable.",
      };
    } else {
      console.log("[Step 2] Sending to Gemini...");
      analysis = await analyzeWithGemini(allItems);
      console.log(`[Step 2] Done - ${analysis.highAlerts?.length || 0} alerts, ${analysis.otherTrades?.length || 0} trades`);
    }

    // STEP 3: Build HTML
    console.log("[Step 3] Building HTML...");
    const html = buildEmailHtml(analysis, allItems.length, gatherErrors);

    // STEP 4: Send emails
    console.log("[Step 4] Sending emails...");
    let subscribers;
    try {
      subscribers = JSON.parse(readFileSync(join(process.cwd(), "subscribers.json"), "utf-8"));
    } catch (err) {
      console.error("Failed to load subscribers.json:", err.message);
      return res.status(500).json({ error: "Failed to load subscriber list" });
    }

    if (!subscribers || subscribers.length === 0) {
      return res.status(200).json({ success: true, dataPoints: allItems.length, emailsSent: 0, note: "No subscribers" });
    }

    const emailResults = await sendNewsletter(html, subscribers);
    const totalSent = emailResults.filter((r) => r.success).reduce((sum, r) => sum + r.count, 0);

    console.log(`=== DONE - Data: ${allItems.length} | Emails: ${totalSent} ===`);

    return res.status(200).json({
      success: true,
      dataPoints: allItems.length,
      sources: {
        twitter: allItems.filter((i) => i.source.startsWith("twitter")).length,
        quiverquant: allItems.filter((i) => i.source === "QuiverQuant").length,
        news: allItems.filter((i) => i.source === "Google News").length,
      },
      highAlerts: analysis.highAlerts?.length || 0,
      otherTrades: analysis.otherTrades?.length || 0,
      emailsSent: totalSent,
      errors: gatherErrors.length > 0 ? gatherErrors : undefined,
    });
  } catch (err) {
    console.error("[FATAL]", err);
    return res.status(500).json({ error: "Internal pipeline failure", message: err.message });
  }
};