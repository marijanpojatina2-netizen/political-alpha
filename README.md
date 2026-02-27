# 🏛️ Political Alpha — Automated Daily Newsletter

Serverless application that scrapes political & whale trading activity from X/Twitter, analyzes it with Gemini AI, and delivers a styled dark-mode newsletter via email every morning.

## Architecture

```
Vercel Cron (08:00 CET daily)
    │
    ├─ 1. SCRAPE — RSS bridges (RSSHub/Nitter) → last 24h tweets
    │      @pelositracker, @capitol2iq, @QuiverQuant, @unusual_whales
    │
    ├─ 2. ANALYZE — Google Gemini 2.0 Flash → structured JSON
    │      High Trade Alerts + Other Trades table
    │
    ├─ 3. RENDER — Dark-mode HTML email with inline CSS
    │
    └─ 4. DELIVER — Resend SDK → all subscribers via BCC
```

## Quick Start — Deployment in 5 Steps

### Step 1: Create accounts & get API keys

| Service | URL | What you need |
|---------|-----|---------------|
| **Vercel** | https://vercel.com | Free account (Hobby plan supports cron) |
| **Google AI Studio** | https://aistudio.google.com/apikey | Free Gemini API key |
| **Resend** | https://resend.com | Free tier = 100 emails/day |

### Step 2: Push to GitHub

```bash
git init
git add .
git commit -m "Initial Political Alpha setup"
git remote add origin https://github.com/YOUR_USERNAME/political-alpha.git
git push -u origin main
```

### Step 3: Deploy to Vercel

1. Go to https://vercel.com/new
2. Import your GitHub repository
3. Vercel auto-detects the config — click **Deploy**

### Step 4: Set Environment Variables

In your Vercel dashboard → **Settings → Environment Variables**, add:

| Variable | Value | Required |
|----------|-------|----------|
| `GEMINI_API_KEY` | Your Google AI Studio key | ✅ |
| `RESEND_API_KEY` | Your Resend API key | ✅ |
| `CRON_SECRET` | Random string (run `openssl rand -base64 32`) | Recommended |

> **Note on CRON_SECRET:** Vercel automatically passes this as a `Bearer` token in the `Authorization` header when invoking cron jobs. This prevents unauthorized access to your endpoint.

### Step 5: Configure sender email (Resend)

The default sender is `onboarding@resend.dev` (Resend's sandbox). For production:

1. Go to Resend → **Domains** → Add your domain
2. Add the DNS records Resend provides
3. Update the `from` field in `api/cron.js` → `sendNewsletter()` to your verified domain

## Managing Subscribers

Edit `subscribers.json` in the repo root:

```json
[
  "alice@example.com",
  "bob@example.com",
  "charlie@example.com"
]
```

Push to GitHub → Vercel auto-deploys → next cron run uses the updated list.

## Cron Schedule

Configured in `vercel.json`:

```json
{ "schedule": "0 7 * * *" }
```

This is `07:00 UTC` = **08:00 CET** (Zagreb time). During CEST (daylight saving, late March → late October), this becomes 09:00 local. To keep it at 08:00 year-round, change to `"0 6 * * *"` during summer months, or accept the 1-hour seasonal drift.

## Testing Locally

```bash
# Install dependencies
npm install

# Set env vars
cp .env.example .env
# Edit .env with your real keys

# Run with Vercel CLI
npx vercel dev

# Then visit: http://localhost:3000/api/cron
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **No tweets found** | RSS bridges may be down. The app tries 4 different bridges per account. Check Vercel function logs. |
| **Gemini errors** | Verify `GEMINI_API_KEY` is set. Check Google AI Studio for quota limits. |
| **Emails not arriving** | Check Resend dashboard for delivery logs. Verify sender domain if not using sandbox. |
| **401 on cron endpoint** | Set `CRON_SECRET` in Vercel env vars. Vercel sends it automatically. |
| **Cron not firing** | Cron jobs require Vercel Pro plan or Hobby plan. Check Vercel dashboard → Cron Jobs tab. |

## Customization

- **Add more accounts**: Edit the `TARGET_ACCOUNTS` array in `api/cron.js`
- **Change AI model**: Switch `gemini-2.0-flash` to `gemini-1.5-pro` for deeper analysis (slower, higher quality)
- **Adjust the AI prompt**: Modify `GEMINI_SYSTEM_PROMPT` to change analysis style
- **Change email design**: Edit the `buildEmailHtml()` function — all CSS is inline

## Important Notes

- **RSS bridges are community-run** and may go offline. The app is built with multiple fallbacks, but if all bridges fail for an account, that account's data is skipped gracefully.
- **Vercel Hobby plan** supports cron jobs but runs them once daily max. Pro plan allows more frequent schedules.
- **Not financial advice.** This tool aggregates publicly available social media data for informational purposes only.
