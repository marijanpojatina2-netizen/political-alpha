// =============================================================================
// POLITICAL ALPHA — Daily Newsletter Cron Job
// =============================================================================
// Vercel Serverless Function triggered daily at 08:00 CET.
//
// DATA SOURCES:
//   1. QuiverQuant Congress Trade News — individual STOCK Act filings with
//      politician names, tickers, and transaction types (BUY/SELL)
//   2. QuiverQuant Insider Trading News — corporate insider transactions
//   3. Google News RSS — recent headlines about political/insider trading
//   4. Twitter Syndication API — tweets from key accounts (best-effort)
// =============================================================================

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Resend } = require("resend");
const { readFileSync } = require("fs");
const { join } = require("path");

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// UTILITY
// ---------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// SOURCE 1: QuiverQuant Congress Trade News
// ---------------------------------------------------------------------------
// Scrapes https://www.quiverquant.com/news/category/congress_trades_automated
// This page lists individual STOCK Act disclosure filings with specific
// politician names, tickers ($AAPL), and transaction types (Purchase/Sale).
// ---------------------------------------------------------------------------

async function fetchQuiverQuantTrades() {
  const trades = [];
  try {
    const resp = await fetch("https://www.quiverquant.com/news/category/congress_trades_automated", {
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

    // The page contains articles in this format (as rendered markdown in HTML):
    //   "Congress Trade: Representative Jake Auchincloss Just Disclosed..."
    //   "15 hours ago | Feb. 20, 2026 2:16 p.m. UTC"
    //   "* **Sale** of [$STT](https://www.quiverquant.com/stock/STT/) stock (STATE STREET...)"
    //   "* **Purchase** of [$ABT](https://www.quiverquant.com/stock/ABT/) stock (ABBOTT...)"

    // Split the page into article blocks by looking for the filing headers
    const articles = html.split(/Congress Trade:\s*/g).slice(1);

    for (const article of articles.slice(0, 15)) {
      // Extract politician name and type (Representative/Senator)
      const nameMatch = article.match(/(Representative|Senator)\s+([\w\s.,'-]+?)\s+Just Disclosed/i);
      const role = nameMatch ? nameMatch[1] : "";
      const politician = nameMatch ? nameMatch[2].trim() : "Unknown";
      const fullName = role ? `${role} ${politician}` : politician;

      // Extract date: "15 hours ago | Feb. 20, 2026 2:16 p.m. UTC"
      const dateMatch = article.match(/(\w+\.\s+\d+,\s+\d{4})/);
      const filingDate = dateMatch ? dateMatch[1] : new Date().toLocaleDateString("en-US");

      // Extract trades — the HTML contains links like:
      //   [$STT](https://www.quiverquant.com/stock/STT/)
      // preceded by **Purchase** or **Sale**
      // After HTML rendering, this becomes clickable links.
      // We match both markdown and rendered HTML formats:

      // Format 1: Markdown style — **Sale** of [$TICKER](url)
      const mdMatches = article.matchAll(/\*\*(Purchase|Sale)\*\*\s+of\s+\[\$(\w+)\]\([^)]*\)\s*(?:stock\s*\(([^)]*)\))?/gi);
      for (const m of mdMatches) {
        const transaction = m[1].toLowerCase() === "purchase" ? "BUY" : "SELL";
        const ticker = m[2];
        const stockName = m[3] ? m[3].trim() : "";
        trades.push({
          source: "QuiverQuant Congress",
          text: `${fullName} (${role || "Congress"}) filed STOCK Act: ${transaction} $${ticker}${stockName ? " (" + stockName + ")" : ""} — Filed ${filingDate}`,
          date: filingDate,
        });
      }

      // Format 2: Rendered HTML — <strong>Sale</strong> of <a href="/stock/STT/">$STT</a>
      if (trades.filter(t => t.text.includes(politician)).length === 0) {
        const htmlMatches = article.matchAll(/<strong>(Purchase|Sale)<\/strong>\s+of\s+<a[^>]*>\$(\w+)<\/a>/gi);
        for (const m of htmlMatches) {
          const transaction = m[1].toLowerCase() === "purchase" ? "BUY" : "SELL";
          const ticker = m[2];
          trades.push({
            source: "QuiverQuant Congress",
            text: `${fullName} (${role || "Congress"}) filed STOCK Act: ${transaction} $${ticker} — Filed ${filingDate}`,
            date: filingDate,
          });
        }
      }

      // Format 3: Plain text fallback — Purchase of $TICKER or Sale of $TICKER
      if (trades.filter(t => t.text.includes(politician)).length === 0) {
        const plainMatches = article.matchAll(/(Purchase|Sale)\s+of\s+\$(\w+)/gi);
        for (const m of plainMatches) {
          const transaction = m[1].toLowerCase() === "purchase" ? "BUY" : "SELL";
          const ticker = m[2];
          trades.push({
            source: "QuiverQuant Congress",
            text: `${fullName} (${role || "Congress"}) filed STOCK Act: ${transaction} $${ticker} — Filed ${filingDate}`,
            date: filingDate,
          });
        }
      }
    }

    console.log(`[QuiverQuant] ${trades.length} congress trades from ${Math.min(articles.length, 15)} filings`);
  } catch (err) {
    console.warn(`[QuiverQuant] Error: ${err.message}`);
  }
  return trades;
}

// ---------------------------------------------------------------------------
// SOURCE 2: QuiverQuant Insider Trading News
// ---------------------------------------------------------------------------

async function fetchQuiverQuantInsiders() {
  const trades = [];
  try {
    const resp = await fetch("https://www.quiverquant.com/news/category/insiders_automated", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });

    if (!resp.ok) {
      console.warn(`[QuiverInsiders] HTTP ${resp.status}`);
      return trades;
    }

    const html = await resp.text();

    // Pattern: "Insider Purchase/Sale: TITLE of $TICKER Buys/Sells N Shares"
    const matches = html.matchAll(/Insider\s+(Purchase|Sale):\s+([\w\s&]+?)\s+of\s+\$(\w+)\s+(Buys|Sells)\s+([\d,]+)\s+Shares/gi);
    for (const match of matches) {
      const transaction = match[1].toLowerCase() === "purchase" ? "BUY" : "SELL";
      const entity = match[2].trim();
      const ticker = match[3];
      const shares = match[5];
      trades.push({
        source: "QuiverQuant Insiders",
        text: `Corporate Insider: ${entity} of $${ticker} — ${transaction} ${shares} shares`,
        date: new Date().toISOString(),
        entity,
        ticker,
        transaction,
      });
    }

    console.log(`[QuiverInsiders] ${trades.length} insider trades found`);
  } catch (err) {
    console.warn(`[QuiverInsiders] Error: ${err.message}`);
  }
  return trades;
}

// ---------------------------------------------------------------------------
// SOURCE 3: Google News RSS
// ---------------------------------------------------------------------------

async function fetchGoogleNewsRSS() {
  const items = [];
  const queries = [
    "congress+stock+trading+disclosure",
    "politician+insider+trading+stocks",
  ];

  for (const query of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${query}+when:1d&hl=en-US&gl=US&ceid=US:en`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
      });
      if (!resp.ok) continue;

      const xml = await resp.text();
      const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
      for (const match of itemMatches) {
        const titleMatch = match[1].match(/<title>([\s\S]*?)<\/title>/);
        const pubDateMatch = match[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/);

        const title = titleMatch ? stripHtml(titleMatch[1]) : "";
        const pubDate = pubDateMatch ? pubDateMatch[1].trim() : "";

        const itemTime = pubDate ? new Date(pubDate).getTime() : 0;
        if (itemTime >= cutoff && title) {
          items.push({
            source: "News",
            text: title, // Clean title only, no HTML junk
            date: pubDate,
          });
        }
      }
    } catch (err) {
      console.warn(`[GoogleNews] Error for "${query}": ${err.message}`);
    }
  }

  // Deduplicate
  const unique = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.text.substring(0, 50).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  console.log(`[GoogleNews] ${unique.length} relevant articles`);
  return unique.slice(0, 10);
}

// ---------------------------------------------------------------------------
// SOURCE 4: Twitter Syndication (best-effort)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SOURCE 4: Capitol Trades JSON API (bff.capitoltrades.com)
// ---------------------------------------------------------------------------
// Capitol Trades uses a backend-for-frontend (BFF) API that returns JSON.
// No auth needed. Returns politician names, tickers, dates, amounts, prices.
// ---------------------------------------------------------------------------

async function fetchCapitolTrades() {
  const trades = [];
  try {
    const resp = await fetch("https://bff.capitoltrades.com/trades?page=1&pageSize=25&sortBy=-publishedDate", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://www.capitoltrades.com",
        "Referer": "https://www.capitoltrades.com/",
      },
    });

    if (!resp.ok) {
      console.warn(`[CapitolTrades] HTTP ${resp.status}`);
      // Fallback: try alternate URL format
      return await fetchCapitolTradesFallback();
    }

    const json = await resp.json();
    const data = json.data || json || [];

    for (const trade of (Array.isArray(data) ? data : [])) {
      try {
        const politician = trade.politician || {};
        const issuer = trade.issuer || {};
        const name = [politician.firstName, politician.lastName].filter(Boolean).join(" ") || "Unknown";
        const party = politician.party || "";
        const chamber = politician.chamber || "";
        const partyShort = party === "Democrat" ? "D" : party === "Republican" ? "R" : party.charAt(0);
        const chamberShort = chamber === "house" ? "House" : chamber === "senate" ? "Senate" : chamber;
        const ticker = issuer.ticker || "";
        const issuerName = issuer.name || "";
        const txType = (trade.txType || trade.type || "").toUpperCase();
        const txDate = trade.txDate || trade.tradedDate || "";
        const pubDate = trade.pubDate || trade.publishedDate || "";
        const size = trade.size || trade.txAmount || "";
        const price = trade.price ? `$${trade.price}` : "";
        const owner = trade.owner || "";

        const label = `${name} (${partyShort}-${chamberShort})`;
        const sizeLabel = size ? ` ${size}` : "";
        const priceLabel = price ? ` at ${price}` : "";
        const ownerLabel = owner && owner !== "Self" && owner !== "Undisclosed" ? ` [${owner}]` : "";

        trades.push({
          source: "Capitol Trades",
          text: `${label}: ${txType} $${ticker} (${issuerName})${sizeLabel}${priceLabel}${ownerLabel} — Traded ${txDate}`,
          date: pubDate || txDate || new Date().toISOString(),
        });
      } catch (e) { /* skip unparseable trade */ }
    }

    console.log(`[CapitolTrades] ${trades.length} trades from API`);
  } catch (err) {
    console.warn(`[CapitolTrades] API error: ${err.message}`);
    return await fetchCapitolTradesFallback();
  }
  return trades;
}

// Fallback: try the HTML page and extract from rendered table
async function fetchCapitolTradesFallback() {
  const trades = [];
  try {
    const resp = await fetch("https://www.capitoltrades.com/trades", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
    });
    if (!resp.ok) return trades;

    const html = await resp.text();

    // Log a snippet for debugging
    console.log("[CapitolTrades Fallback] HTML length:", html.length);
    console.log("[CapitolTrades Fallback] First 500 chars:", html.substring(0, 500));

    // Try to find embedded JSON data (Next.js __NEXT_DATA__ or similar)
    const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const tradeList = nextData?.props?.pageProps?.trades?.data || [];
        for (const trade of tradeList.slice(0, 25)) {
          const pol = trade.politician || {};
          const iss = trade.issuer || {};
          const name = [pol.firstName, pol.lastName].filter(Boolean).join(" ");
          trades.push({
            source: "Capitol Trades",
            text: `${name}: ${(trade.txType || "").toUpperCase()} $${iss.ticker || "?"} (${iss.name || "?"}) — Traded ${trade.txDate || "?"}`,
            date: trade.pubDate || new Date().toISOString(),
          });
        }
      } catch (e) { /* JSON parse failed */ }
    }

    console.log(`[CapitolTrades Fallback] ${trades.length} trades`);
  } catch (err) {
    console.warn(`[CapitolTrades Fallback] Error: ${err.message}`);
  }
  return trades;
}

// ---------------------------------------------------------------------------
// MASTER SCRAPER
// ---------------------------------------------------------------------------

async function gatherAllData() {
  const errors = [];
  const results = await Promise.allSettled([
    fetchQuiverQuantTrades(),
    fetchQuiverQuantInsiders(),
    fetchGoogleNewsRSS(),
    fetchCapitolTrades(),
  ]);

  let allItems = [];
  const labels = ["QuiverQuant Congress", "QuiverQuant Insiders", "Google News", "Capitol Trades"];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") allItems.push(...r.value);
    else errors.push(labels[i]);
  });

  console.log(`[Gather] Total: ${allItems.length} | Errors: ${errors.length}`);
  return { allItems, errors };
}

// ---------------------------------------------------------------------------
// GEMINI AI ANALYSIS
// ---------------------------------------------------------------------------

const GEMINI_SYSTEM_PROMPT = `You are an expert financial analyst writing for a newsletter called "Political Alpha".

You will receive data from multiple sources about congressional stock trading (from STOCK Act filings) and corporate insider transactions. The data includes specific politician/entity names, ticker symbols, and transaction types (BUY/SELL).

Your tasks:
1) Identify the top 2 most significant trades and create "High Trade Alerts" for them. Pick trades that are notable due to the politician's prominence, the size/frequency of trades, or the relevance of the stock. Write a brief, punchy 2-3 sentence analysis for each.
2) Put ALL remaining identifiable trades into the "otherTrades" array with: date, entity, ticker, transaction (BUY or SELL), amount (if known, otherwise "Undisclosed").
3) Write a one-sentence market sentiment note.

IMPORTANT: You have real trade data with real tickers and politician names. USE THEM. Do not say "no trades detected" when the data clearly contains trades with tickers and names.

Return ONLY valid JSON matching this exact schema:
{
  "highAlerts": [
    { "title": "Headline", "summary": "Analysis", "ticker": "AAPL", "entity": "Nancy Pelosi", "transaction": "BUY" }
  ],
  "otherTrades": [
    { "date": "2026-02-27", "entity": "Name", "ticker": "NVDA", "transaction": "SELL", "amount": "Undisclosed" }
  ],
  "marketNote": "One sentence summary."
}`;

async function analyzeWithGemini(items) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const itemText = items
    .map((t, i) => `[${i + 1}] (${t.source}): ${t.text}`)
    .join("\n");

  const prompt = `Here is today's trading data:\n\n${itemText}\n\nAnalyze and return structured JSON.`;

  // DEBUG logging
  console.log("=== GEMINI INPUT (first 3000 chars) ===");
  console.log(prompt.substring(0, 3000));
  console.log("=== END GEMINI INPUT ===");

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
  });

  const responseText = result.response.text();
  console.log("=== GEMINI OUTPUT ===");
  console.log(responseText.substring(0, 2000));
  console.log("=== END GEMINI OUTPUT ===");

  const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// HTML EMAIL TEMPLATE
// ---------------------------------------------------------------------------

function buildEmailHtml(analysis, itemCount, errors) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  let highAlertsHtml = "";
  if (analysis.highAlerts && analysis.highAlerts.length > 0) {
    highAlertsHtml = analysis.highAlerts.map((alert, i) => `
      <div style="background:#1a1a2e;border-left:4px solid #e94560;padding:20px 24px;margin-bottom:16px;border-radius:0 8px 8px 0;">
        <span style="background:#e94560;color:#fff;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;text-transform:uppercase;">HIGH TRADE ALERT #${i + 1}</span>
        <h2 style="color:#ffffff;font-size:22px;font-weight:800;margin:12px 0 8px 0;line-height:1.3;">${escHtml(alert.title)}</h2>
        <div style="margin-bottom:10px;">
          <span style="background:#0f3460;color:#00d2ff;padding:3px 10px;border-radius:4px;font-size:13px;font-weight:700;margin-right:8px;">$${escHtml(alert.ticker || "N/A")}</span>
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
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-size:13px;"><span style="background:#0f3460;color:#00d2ff;padding:2px 8px;border-radius:3px;font-weight:700;">$${escHtml(trade.ticker || "-")}</span></td>
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
    ? `<div style="background:#2d1b1b;border:1px solid #e94560;padding:12px 16px;border-radius:6px;margin-bottom:24px;"><p style="color:#ff6b6b;font-size:12px;margin:0;">Some data sources were unreachable: ${errors.map(escHtml).join(", ")}.</p></div>`
    : "";

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
    ${analysis.marketNote ? `<div style="background:#16213e;border-radius:8px;padding:16px 20px;margin-bottom:28px;"><p style="color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 6px 0;">MARKET PULSE</p><p style="color:#ccd6f6;font-size:14px;line-height:1.5;margin:0;">${escHtml(analysis.marketNote)}</p></div>` : ""}
    <h2 style="color:#e94560;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">High Trade Alerts</h2>
    ${highAlertsHtml}
    <h2 style="color:#00d2ff;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:36px 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">Other Trades</h2>
    ${tableHtml}
  </div>
  <div style="background:#0f0f1a;padding:24px 32px;text-align:center;border-top:1px solid #1a1a2e;">
    <p style="color:#4a5568;font-size:11px;margin:0 0 8px 0;">Political Alpha - Automated financial intelligence</p>
    <p style="color:#3a3a5c;font-size:10px;margin:0;">This is not financial advice. Data sourced from public STOCK Act filings and news. Always do your own research.</p>
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
  const results = [];

  for (let i = 0; i < subscriberEmails.length; i += 50) {
    const batch = subscriberEmails.slice(i, i + 50);
    try {
      const { data, error } = await resend.emails.send({
        from: "Political Alpha <onboarding@resend.dev>",
        to: batch.length === 1 ? batch[0] : "Political Alpha <onboarding@resend.dev>",
        bcc: batch.length > 1 ? batch : undefined,
        subject: `Political Alpha - ${today} Daily Briefing`,
        html,
      });
      if (error) { console.error("[Email] Error:", error); results.push({ error }); }
      else { console.log(`[Email] Sent to ${batch.length} subscribers`); results.push({ success: true, count: batch.length }); }
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
  if (process.env.CRON_SECRET && req.headers["authorization"] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("=== POLITICAL ALPHA - CRON START ===");

  try {
    // STEP 1: Gather data
    console.log("[Step 1] Gathering data...");
    const { allItems, errors: gatherErrors } = await gatherAllData();
    console.log(`[Step 1] Total: ${allItems.length} data points`);

    // STEP 2: AI Analysis
    let analysis;
    if (allItems.length === 0) {
      analysis = { highAlerts: [], otherTrades: [], marketNote: "No data sources were available today." };
    } else {
      console.log("[Step 2] Gemini analysis...");
      analysis = await analyzeWithGemini(allItems);
      console.log(`[Step 2] ${analysis.highAlerts?.length || 0} alerts, ${analysis.otherTrades?.length || 0} trades`);
    }

    // STEP 3: Build HTML
    console.log("[Step 3] Building HTML...");
    const html = buildEmailHtml(analysis, allItems.length, gatherErrors);

    // STEP 4: Send emails
    console.log("[Step 4] Sending...");
    let subscribers;
    try {
      subscribers = JSON.parse(readFileSync(join(process.cwd(), "subscribers.json"), "utf-8"));
    } catch (err) {
      return res.status(500).json({ error: "Failed to load subscribers.json" });
    }

    if (!subscribers || subscribers.length === 0) {
      return res.status(200).json({ success: true, data: allItems.length, emails: 0 });
    }

    const emailResults = await sendNewsletter(html, subscribers);
    const totalSent = emailResults.filter(r => r.success).reduce((s, r) => s + r.count, 0);

    console.log(`=== DONE — Data: ${allItems.length} | Emails: ${totalSent} ===`);
    return res.status(200).json({
      success: true,
      dataPoints: allItems.length,
      highAlerts: analysis.highAlerts?.length || 0,
      otherTrades: analysis.otherTrades?.length || 0,
      emailsSent: totalSent,
      errors: gatherErrors.length > 0 ? gatherErrors : undefined,
    });
  } catch (err) {
    console.error("[FATAL]", err);
    return res.status(500).json({ error: "Pipeline failure", message: err.message });
  }
};