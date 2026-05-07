# 🌍 Comply Globally — WhatsApp AI Chatbot

WhatsApp chatbot for **Connect Ventures Inc.** powered by Claude AI + Interakt.  
Handles lead collection, global expansion queries, and context-aware conversations.

---

## 🚀 Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Then fill in your API keys in .env

# 3. Run the server
npm start

# 4. Test the bot locally
curl -X POST http://localhost:5000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hi, I want to expand my business to UAE"}'
```

---

## 📦 Project Structure

```
comply-bot/
├── server.js          ← Main bot server
├── package.json       ← Dependencies
├── .env.example       ← Environment variable template
├── .env               ← Your actual keys (never commit this)
├── .gitignore
├── public/
│   └── index.html     ← Optional web UI (can be blank)
└── README.md
```

---

## ☁️ Deploying to Render (Step-by-Step)

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/comply-bot.git
git push -u origin main
```
> ⚠️ Make sure `.env` is in `.gitignore` — never push your API keys!

---

### Step 2: Create a Web Service on Render

1. Go to [render.com](https://render.com) and sign in
2. Click **"New +"** → **"Web Service"**
3. Connect your **GitHub account** and select the `comply-bot` repository
4. Fill in these settings:

| Field | Value |
|-------|-------|
| **Name** | `comply-globally-bot` (or any name) |
| **Region** | Singapore (closest to India/UAE) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Instance Type** | Free (or Starter for better performance) |

---

### Step 3: Add Environment Variables on Render

In your Render service → go to **"Environment"** tab → Add these:

| Key | Value |
|-----|-------|
| `INTERAKT_API_KEY` | Your Interakt API key |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

> ✅ Render sets `PORT` automatically — do NOT add it manually.

---

### Step 4: Deploy

Click **"Create Web Service"**. Render will:
1. Pull your code from GitHub
2. Run `npm install`
3. Start with `node server.js`

Your live URL will be something like:  
`https://comply-globally-bot.onrender.com`

---

### Step 5: Connect to Interakt

1. Log into [Interakt](https://app.interakt.ai)
2. Go to **Settings → Developer Settings → Webhook**
3. Set Webhook URL to:  
   `https://comply-globally-bot.onrender.com/webhook`
4. Set events to: **`message_received`**
5. Save

---

### Step 6: Test It

Send a WhatsApp message to your Interakt number. The bot should reply within 3–5 seconds.

You can also test without WhatsApp:
```bash
curl -X POST https://comply-globally-bot.onrender.com/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hi, I want to set up a company in Dubai"}'
```

---

## ⚠️ Important Notes

### Free Render Tier — Spin Down Issue
Render's free tier spins down after 15 minutes of inactivity. The first webhook after spin-down may take 30–50 seconds to respond (Interakt may time out). 

**Fix options:**
- Upgrade to Render **Starter ($7/month)** — always on
- Use [UptimeRobot](https://uptimerobot.com) (free) to ping `/health` every 5 minutes to keep the server awake

### UptimeRobot Setup (Free Keep-Alive):
1. Sign up at uptimerobot.com
2. Add new monitor → HTTP(s)
3. URL: `https://comply-globally-bot.onrender.com/health`
4. Interval: 5 minutes

---

## 🔧 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/webhook` | Interakt webhook receiver |
| `POST` | `/chat` | Local test (no WhatsApp needed) |
| `GET`  | `/health` | Health check for uptime monitors |

---

## 🧠 Features

- ✅ Context-aware conversations (remembers name, country, service)
- ✅ Web search enabled (Claude can look up current info)
- ✅ Automatic lead data extraction from conversation
- ✅ Session management with 24hr TTL cleanup
- ✅ Handles Interakt 24-hour messaging window with template fallback
- ✅ Short WhatsApp-optimized responses

---

## 🛠 Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **AI Model**: Claude Sonnet (Anthropic)
- **WhatsApp**: Interakt API
- **Hosting**: Render
