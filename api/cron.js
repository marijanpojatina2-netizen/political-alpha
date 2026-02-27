// =============================================================================
// POLITICAL ALPHA — Daily Newsletter Cron Job
// =============================================================================
// Vercel Serverless Function triggered daily at 08:00 CET.
// Pipeline: Scrape X/Twitter → Gemini AI Analysis → HTML Email → Resend Delivery
// =============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resend } from "resend";
import Parser from "rss-parser";
import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const TARGET_ACCOUNTS = [
  "pelositracker",
  "capitol2iq",
  "QuiverQuant",
  "unusual_whales",
];

// Multiple RSSHub / Nitter-style public instances for resilience.
// These translate X/Twitter feeds into RSS without authentication.
// If one goes down, the next is tried automatically.
const RSS_BRIDGES = [
  (handle) => `https://rsshub.app/twitter/user/${handle}`,
  (handle) => `https://rss.bloat.cat/${handle}/rss`,
  (handle) => `https://nitter.privacydev.net/${handle}/rss`,
  (handle) => `https://twiiit.com/${handle}/rss`,
];

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 1. SCRAPING — Fetch tweets from the last 24h via RSS bridges
// ---------------------------------------------------------------------------

/**
 * Attempts to fetch an RSS feed for a given X/Twitter handle.
 * Tries multiple bridge instances and returns parsed items or [].
 */
async function scrapeTweets(handle) {
  const parser = new Parser({
    timeout: 10000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    },
  });

  const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;

  for (const bridgeFn of RSS_BRIDGES) {
    const url = bridgeFn(handle);
    try {
      console.log(`[Scrape] Trying ${url}`);
      const feed = await parser.parseURL(url);

      // Filter to last 24 hours
      const recent = (feed.items || []).filter((item) => {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        return pubDate >= cutoff;
      });

      if (recent.length > 0) {
        console.log(`[Scrape] ✓ @${handle}: ${recent.length} tweets via ${url}`);
        return recent.map((item) => ({
          handle,
          text: stripHtml(item.contentSnippet || item.content || item.title || ""),
          date: item.pubDate || new Date().toISOString(),
          link: item.link || "",
        }));
      }

      // Feed worked but no recent tweets — that's valid, return empty
      console.log(`[Scrape] ✓ @${handle}: 0 tweets in last 24h (feed OK)`);
      return [];
    } catch (err) {
      console.warn(`[Scrape] ✗ @${handle} failed on ${url}: ${err.message}`);
      // Try next bridge
    }
  }

  // All bridges failed for this handle
  console.error(`[Scrape] ✗✗ ALL bridges failed for @${handle}`);
  return [];
}

/** Strip HTML tags from RSS content */
function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scrape all target accounts in parallel.
 * Resilient — one failing account doesn't crash the pipeline.
 */
async function scrapeAllAccounts() {
  const results = await Promise.allSettled(
    TARGET_ACCOUNTS.map((handle) => scrapeTweets(handle))
  );

  const allTweets = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      allTweets.push(...result.value);
    } else {
      errors.push(`@${TARGET_ACCOUNTS[i]}: ${result.reason?.message}`);
    }
  });

  return { allTweets, errors };
}

// ---------------------------------------------------------------------------
// 2. AI ANALYSIS — Send tweets to Gemini Pro for structured extraction
// ---------------------------------------------------------------------------

const GEMINI_SYSTEM_PROMPT = `You are an expert financial analyst writing for a newsletter called "Political Alpha".

Review the provided tweets regarding insider trading from politicians and financial whales over the last 24 hours.

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
    {
      "title": "Short punchy headline",
      "summary": "2-3 sentence analysis",
      "ticker": "AAPL",
      "entity": "Nancy Pelosi",
      "transaction": "BUY"
    }
  ],
  "otherTrades": [
    {
      "date": "2025-01-15",
      "entity": "Name",
      "ticker": "NVDA",
      "transaction": "SELL",
      "amount": "$500K-$1M"
    }
  ],
  "marketNote": "One sentence overall market sentiment note based on the trading patterns."
}

If there are no tweets or no identifiable trades, return:
{
  "highAlerts": [],
  "otherTrades": [],
  "marketNote": "No significant political or whale trading activity detected in the last 24 hours."
}`;

async function analyzeWithGemini(tweets) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const tweetText = tweets
    .map(
      (t, i) =>
        `[${i + 1}] @${t.handle} (${new Date(t.date).toLocaleDateString()}): ${t.text}`
    )
    .join("\n\n");

  const prompt = `Here are the tweets from the last 24 hours:\n\n${tweetText}\n\nAnalyze these and return the structured JSON as instructed.`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
    },
  });

  const responseText = result.response.text();

  // Parse — strip markdown fences if Gemini wraps them anyway
  const cleaned = responseText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// 3. HTML EMAIL TEMPLATE — Dark mode, bold typography, inline CSS
// ---------------------------------------------------------------------------

function buildEmailHtml(analysis, tweetCount, errors) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Build High Trade Alerts section
  let highAlertsHtml = "";
  if (analysis.highAlerts && analysis.highAlerts.length > 0) {
    highAlertsHtml = analysis.highAlerts
      .map(
        (alert, i) => `
      <div style="background:#1a1a2e;border-left:4px solid #e94560;padding:20px 24px;margin-bottom:16px;border-radius:0 8px 8px 0;">
        <div style="display:flex;align-items:center;margin-bottom:8px;">
          <span style="background:#e94560;color:#fff;font-size:11px;font-weight:800;letter-spacing:1.5px;padding:4px 10px;border-radius:4px;text-transform:uppercase;">🚨 HIGH TRADE ALERT #${i + 1}</span>
        </div>
        <h2 style="color:#ffffff;font-size:22px;font-weight:800;margin:12px 0 8px 0;line-height:1.3;">${escHtml(alert.title)}</h2>
        <div style="margin-bottom:10px;">
          <span style="background:#0f3460;color:#00d2ff;padding:3px 10px;border-radius:4px;font-size:13px;font-weight:700;margin-right:8px;">${escHtml(alert.ticker || "N/A")}</span>
          <span style="color:${alert.transaction === "BUY" ? "#00ff88" : "#ff4757"};font-weight:700;font-size:13px;">${escHtml(alert.transaction || "N/A")}</span>
          <span style="color:#8892b0;font-size:13px;margin-left:8px;">— ${escHtml(alert.entity || "Unknown")}</span>
        </div>
        <p style="color:#ccd6f6;font-size:15px;line-height:1.6;margin:0;">${escHtml(alert.summary)}</p>
      </div>`
      )
      .join("");
  } else {
    highAlertsHtml = `
      <div style="background:#1a1a2e;padding:24px;border-radius:8px;text-align:center;">
        <p style="color:#8892b0;font-size:15px;margin:0;">No high-priority trades detected in the last 24 hours.</p>
      </div>`;
  }

  // Build Other Trades table
  let tableHtml = "";
  if (analysis.otherTrades && analysis.otherTrades.length > 0) {
    const rows = analysis.otherTrades
      .map(
        (trade) => `
        <tr>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ccd6f6;font-size:13px;">${escHtml(trade.date || "—")}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ffffff;font-weight:600;font-size:13px;">${escHtml(trade.entity || "—")}</td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-size:13px;">
            <span style="background:#0f3460;color:#00d2ff;padding:2px 8px;border-radius:3px;font-weight:700;">${escHtml(trade.ticker || "—")}</span>
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-size:13px;">
            <span style="color:${trade.transaction === "BUY" ? "#00ff88" : "#ff4757"};font-weight:700;">${escHtml(trade.transaction || "—")}</span>
          </td>
          <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#ccd6f6;font-size:13px;">${escHtml(trade.amount || "—")}</td>
        </tr>`
      )
      .join("");

    tableHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#12121f;border-radius:8px;overflow:hidden;border-collapse:collapse;">
        <thead>
          <tr style="background:#0f3460;">
            <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Date</th>
            <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Entity</th>
            <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Ticker</th>
            <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Type</th>
            <th style="padding:14px 16px;text-align:left;color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>`;
  } else {
    tableHtml = `
      <div style="background:#12121f;padding:24px;border-radius:8px;text-align:center;">
        <p style="color:#8892b0;font-size:14px;margin:0;">No additional trades to report today.</p>
      </div>`;
  }

  // Scraping error notice (if any accounts failed)
  const errorNotice =
    errors.length > 0
      ? `<div style="background:#2d1b1b;border:1px solid #e94560;padding:12px 16px;border-radius:6px;margin-bottom:24px;">
           <p style="color:#ff6b6b;font-size:12px;margin:0;">⚠️ Some data sources were unreachable: ${errors.map(escHtml).join(", ")}. Results may be incomplete.</p>
         </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Political Alpha — Daily Briefing</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:0;">

    <!-- HEADER -->
    <div style="background:linear-gradient(135deg,#0f3460 0%,#1a1a2e 50%,#16213e 100%);padding:48px 32px 40px 32px;text-align:center;border-bottom:3px solid #e94560;">
      <h1 style="color:#ffffff;font-size:48px;font-weight:900;margin:0 0 4px 0;letter-spacing:-1px;line-height:1.1;">
        POLITICAL<span style="color:#e94560;">ALPHA</span>
      </h1>
      <p style="color:#8892b0;font-size:13px;font-weight:500;margin:8px 0 0 0;letter-spacing:3px;text-transform:uppercase;">
        Daily Insider Trading Intelligence
      </p>
      <p style="color:#4a5568;font-size:12px;margin:16px 0 0 0;">${today} · ${tweetCount} tweets analyzed</p>
    </div>

    <!-- BODY -->
    <div style="padding:32px 24px;background-color:#0a0a14;">

      ${errorNotice}

      <!-- MARKET NOTE -->
      ${analysis.marketNote ? `
      <div style="background:#16213e;border-radius:8px;padding:16px 20px;margin-bottom:28px;">
        <p style="color:#00d2ff;font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 6px 0;">📊 MARKET PULSE</p>
        <p style="color:#ccd6f6;font-size:14px;line-height:1.5;margin:0;">${escHtml(analysis.marketNote)}</p>
      </div>` : ""}

      <!-- HIGH TRADE ALERTS -->
      <h2 style="color:#e94560;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">
        🔥 High Trade Alerts
      </h2>
      ${highAlertsHtml}

      <!-- OTHER TRADES TABLE -->
      <h2 style="color:#00d2ff;font-size:14px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:36px 0 16px 0;padding-bottom:8px;border-bottom:1px solid #1a1a2e;">
        📋 Other Trades
      </h2>
      ${tableHtml}

    </div>

    <!-- FOOTER -->
    <div style="background:#0f0f1a;padding:24px 32px;text-align:center;border-top:1px solid #1a1a2e;">
      <p style="color:#4a5568;font-size:11px;margin:0 0 8px 0;">
        Political Alpha · Automated financial intelligence
      </p>
      <p style="color:#3a3a5c;font-size:10px;margin:0;">
        This is not financial advice. Data sourced from public social media posts. Always do your own research.
      </p>
    </div>

  </div>
</body>
</html>`;
}

function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 4. EMAIL DELIVERY — Send via Resend to all subscribers
// ---------------------------------------------------------------------------

async function sendNewsletter(html, subscriberEmails) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const today = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  // Resend supports up to 50 recipients in a single batch.
  // For larger lists, chunk them.
  const BATCH_SIZE = 50;
  const batches = [];
  for (let i = 0; i < subscriberEmails.length; i += BATCH_SIZE) {
    batches.push(subscriberEmails.slice(i, i + BATCH_SIZE));
  }

  const results = [];
  for (const batch of batches) {
    // Use BCC to keep recipient emails private
    const { data, error } = await resend.emails.send({
      from: "Political Alpha <onboarding@resend.dev>",
      to: "Political Alpha <onboarding@resend.dev>",
      bcc: batch,
      subject: `🏛️ Political Alpha — ${today} Daily Briefing`,
      html,
    });

    if (error) {
      console.error("[Email] Send error:", error);
      results.push({ error });
    } else {
      console.log(`[Email] ✓ Sent to ${batch.length} subscribers (id: ${data?.id})`);
      results.push({ success: true, id: data?.id, count: batch.length });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// 5. MAIN HANDLER — Vercel Serverless Function
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Verify this is a legitimate cron invocation (Vercel sets this header)
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow running without CRON_SECRET for testing, but log a warning
    if (process.env.CRON_SECRET) {
      console.warn("[Auth] Missing or invalid CRON_SECRET — rejecting request");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  console.log("=== POLITICAL ALPHA — CRON RUN START ===");
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    // -----------------------------------------------------------------------
    // STEP 1: Scrape tweets
    // -----------------------------------------------------------------------
    console.log("\n[Step 1] Scraping tweets...");
    const { allTweets, errors: scrapeErrors } = await scrapeAllAccounts();
    console.log(`[Step 1] Total tweets collected: ${allTweets.length}`);

    // If we got absolutely nothing, still send a "no activity" newsletter
    let analysis;

    if (allTweets.length === 0) {
      console.log("[Step 2] No tweets — skipping Gemini, using empty template");
      analysis = {
        highAlerts: [],
        otherTrades: [],
        marketNote:
          "No trading activity was detected from tracked accounts in the last 24 hours. This could indicate a quiet market day or data source issues.",
      };
    } else {
      // -------------------------------------------------------------------
      // STEP 2: AI Analysis with Gemini
      // -------------------------------------------------------------------
      console.log("\n[Step 2] Sending to Gemini for analysis...");
      analysis = await analyzeWithGemini(allTweets);
      console.log(
        `[Step 2] ✓ Analysis complete — ${analysis.highAlerts?.length || 0} high alerts, ${analysis.otherTrades?.length || 0} other trades`
      );
    }

    // -----------------------------------------------------------------------
    // STEP 3: Build HTML
    // -----------------------------------------------------------------------
    console.log("\n[Step 3] Building email HTML...");
    const html = buildEmailHtml(analysis, allTweets.length, scrapeErrors);

    // -----------------------------------------------------------------------
    // STEP 4: Load subscribers & send
    // -----------------------------------------------------------------------
    console.log("\n[Step 4] Sending emails...");

    let subscribers;
    try {
      const subPath = join(process.cwd(), "subscribers.json");
      subscribers = JSON.parse(readFileSync(subPath, "utf-8"));
    } catch (err) {
      console.error("[Step 4] Failed to load subscribers.json:", err.message);
      return res.status(500).json({ error: "Failed to load subscriber list" });
    }

    if (!subscribers || subscribers.length === 0) {
      console.warn("[Step 4] No subscribers found — skipping email delivery");
      return res.status(200).json({
        success: true,
        tweetsAnalyzed: allTweets.length,
        emailsSent: 0,
        note: "No subscribers configured",
      });
    }

    const emailResults = await sendNewsletter(html, subscribers);

    // -----------------------------------------------------------------------
    // DONE
    // -----------------------------------------------------------------------
    const totalSent = emailResults
      .filter((r) => r.success)
      .reduce((sum, r) => sum + r.count, 0);

    console.log(`\n=== POLITICAL ALPHA — CRON RUN COMPLETE ===`);
    console.log(`Tweets: ${allTweets.length} | Emails: ${totalSent} | Errors: ${scrapeErrors.length}`);

    return res.status(200).json({
      success: true,
      tweetsAnalyzed: allTweets.length,
      highAlerts: analysis.highAlerts?.length || 0,
      otherTrades: analysis.otherTrades?.length || 0,
      emailsSent: totalSent,
      scrapeErrors: scrapeErrors.length > 0 ? scrapeErrors : undefined,
    });
  } catch (err) {
    console.error("[FATAL]", err);
    return res.status(500).json({
      error: "Internal pipeline failure",
      message: err.message,
    });
  }
}
