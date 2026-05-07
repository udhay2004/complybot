const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// ENV VALIDATION
// ─────────────────────────────────────────────
const INTERAKT_API_KEY = (process.env.INTERAKT_API_KEY || '').replace(/['"` \n\r]/g, '');
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/['"` \n\r]/g, '');

if (!INTERAKT_API_KEY) console.error("❌ Interakt API Key missing!");
else console.log("✅ Interakt API Key loaded, length:", INTERAKT_API_KEY.length);

if (!ANTHROPIC_API_KEY) console.error("❌ ANTHROPIC_API_KEY missing!");
else console.log("✅ Anthropic API Key loaded, length:", ANTHROPIC_API_KEY.length);

// ─────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Comply, a smart and professional Global Expansion Assistant for Connect Ventures Inc. (brand name: Comply Globally). You assist entrepreneurs, startups, freelancers, and businesses with international expansion via WhatsApp.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT CONNECT VENTURES INC.
━━━━━━━━━━━━━━━━━━━━━━━━━━
Headquarters: Delaware, USA | Slogan: "Comply Globally"

CORE SERVICES:
1. Company Formation – Incorporation & registration in international jurisdictions
2. Banking Setup – Corporate bank accounts and cross-border finance solutions
3. Tax Compliance – IRS/GST/VAT filings, corporate tax, transfer pricing
4. Annual Maintenance – Registered Agent services, secretarial filings, compliance renewals
5. FEMA & Investment Advisory – For Indian businesses expanding overseas (RBI/FEMA regulations)
6. Residency & Golden Visas – Investment-linked residency programs (NOT travel visas)

COUNTRIES SERVED:
- Americas: USA (Delaware), Canada
- Middle East & Africa: UAE (Dubai/Abu Dhabi), Saudi Arabia, Egypt, Nigeria, Mauritius
- Europe: UK, Netherlands, and all 27 EU member countries
- Asia-Pacific: India, Singapore, Hong Kong, Indonesia, Thailand, Malaysia, Philippines

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT-AWARE BEHAVIOUR
━━━━━━━━━━━━━━━━━━━━━━━━━━
You maintain full memory of everything said in this conversation. Use it actively:
- Once you know their current country → tailor your answers to their local regulations and context
- Once you know their target country → focus all suggestions around that jurisdiction
- Once you know their business stage → adjust your tone and depth (simpler for startups, more detailed for corporates)
- Once you know their service need → answer questions specifically about that service
- Never re-ask for information the customer has already given you
- Reference their details naturally: "Since you're in India and expanding to UAE…"

━━━━━━━━━━━━━━━━━━━━━━━━━━
LEAD COLLECTION GOALS
━━━━━━━━━━━━━━━━━━━━━━━━━━
Naturally collect these through conversation (never ask all at once):
✅ Full Name
✅ Current Country (where they're based)
✅ Target Country (where they want to expand)
✅ Service Needed (Formation / Banking / Tax / Maintenance / FEMA / Visa)
✅ Business Stage (Startup / SME / Freelancer / Established Company)
✅ Timeline (How soon do they want to start?)

Track what you've collected. Once you have: Name + Current Country + Target Country + Service Needed → say:
"Thank you [Name]! 🎉 Our expert will review your requirements and reach out to you on this WhatsApp number shortly. Is there anything else I can help you with?"

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- This is WhatsApp — keep responses SHORT (2–4 lines max). No walls of text.
- Be warm, professional, and confident. No filler phrases.
- When greeted, introduce yourself briefly and ask where they are currently based.
- Collect info naturally — like a smart consultant, not a form.
- If asked about a country or process you're unsure about → say "Let me check that for you" and use web search.
- Use relevant emojis sparingly (✅ 🌍 💼 📋) to make messages scannable.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ Never give specific legal or tax advice → "Our experts will guide you during the consultation"
❌ Never quote prices → "Pricing depends on jurisdiction and service — our team will send a custom quote"
❌ Never guarantee bank account or visa approval → these depend on third-party providers
❌ Never ask for passport/sensitive documents via chat → "Please use our secure client portal"
❌ Never go off-topic → redirect: "That's outside my area — I focus on global business expansion. Can I help you with that?"
❌ Never repeat information the customer has already provided`;

// ─────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────
const conversations = {};

function freshSession() {
  return {
    history: [],
    leadData: {
      name: null,
      phone: null,
      currentCountry: null,
      targetCountry: null,
      serviceNeeded: null,
      businessStage: null,
      timeline: null
    },
    leadCollected: false,
    createdAt: Date.now(),
    lastActive: Date.now()
  };
}

// Clean up stale sessions older than 24 hours
setInterval(() => {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const phone in conversations) {
    if (now - conversations[phone].lastActive > TTL) {
      delete conversations[phone];
      console.log(`🧹 Cleaned up session for ${phone}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function cleanPhone(phone) {
  return (phone || '').replace(/^\+/, '').replace(/\D/g, '');
}

function buildContextSummary(leadData) {
  const parts = [];
  if (leadData.name) parts.push(`Customer name: ${leadData.name}`);
  if (leadData.currentCountry) parts.push(`Based in: ${leadData.currentCountry}`);
  if (leadData.targetCountry) parts.push(`Wants to expand to: ${leadData.targetCountry}`);
  if (leadData.serviceNeeded) parts.push(`Service interested in: ${leadData.serviceNeeded}`);
  if (leadData.businessStage) parts.push(`Business stage: ${leadData.businessStage}`);
  if (leadData.timeline) parts.push(`Timeline: ${leadData.timeline}`);
  return parts.length > 0
    ? `\n\n[CUSTOMER CONTEXT SO FAR: ${parts.join(' | ')}]`
    : '';
}

// ─────────────────────────────────────────────
// CLAUDE AI WITH WEB SEARCH
// ─────────────────────────────────────────────
async function getClaudeReply(session, userMessage) {
  session.lastActive = Date.now();

  session.history.push({ role: 'user', content: userMessage });

  // Keep last 30 messages (15 turns) for solid context
  if (session.history.length > 30) {
    session.history = session.history.slice(-30);
  }

  const contextSummary = buildContextSummary(session.leadData);
  const systemWithContext = SYSTEM_PROMPT + contextSummary;

  // Web search tool definition
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search"
    }
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        system: systemWithContext,
        tools: tools,
        messages: session.history
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Claude API Error:", JSON.stringify(data));
      return "I'm having trouble connecting right now. Please try again in a moment. 🙏";
    }

    // Extract text from content blocks (handle tool_use + text mix)
    let reply = '';
    if (data.content && Array.isArray(data.content)) {
      reply = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
    }

    if (!reply) {
      reply = "I'm looking into that for you. Could you give me a moment and try again? 🙏";
    }

    session.history.push({ role: 'assistant', content: reply });

    // Auto-extract lead data from the conversation
    extractLeadData(session, userMessage, reply);

    return reply;

  } catch (err) {
    console.error("❌ Claude Network Error:", err.message);
    return "I'm having trouble connecting right now. Please try again in a moment. 🙏";
  }
}

// ─────────────────────────────────────────────
// LEAD DATA EXTRACTION (lightweight NLP)
// ─────────────────────────────────────────────
function extractLeadData(session, userMessage, botReply) {
  const lead = session.leadData;
  const msg = userMessage.toLowerCase();

  // Detect name after "my name is" / "i am" / "i'm"
  const nameMatch = userMessage.match(/(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (nameMatch && !lead.name) {
    lead.name = nameMatch[1];
    console.log(`📝 Captured name: ${lead.name}`);
  }

  // Detect countries mentioned
  const countries = [
    'india', 'uae', 'dubai', 'abu dhabi', 'usa', 'united states', 'uk', 'united kingdom',
    'singapore', 'hong kong', 'canada', 'netherlands', 'saudi arabia', 'mauritius',
    'egypt', 'nigeria', 'indonesia', 'thailand', 'malaysia', 'philippines', 'germany',
    'france', 'italy', 'spain', 'portugal', 'ireland', 'luxembourg', 'cyprus', 'malta'
  ];

  const expansionKeywords = ['expand', 'open', 'setup', 'set up', 'register', 'incorporate', 'start', 'launch', 'move to'];
  const isExpansionMsg = expansionKeywords.some(k => msg.includes(k));

  if (isExpansionMsg) {
    for (const country of countries) {
      if (msg.includes(country) && !lead.targetCountry) {
        lead.targetCountry = capitalize(country);
        console.log(`📝 Captured target country: ${lead.targetCountry}`);
        break;
      }
    }
  }

  // Detect services
  if (!lead.serviceNeeded) {
    if (msg.includes('company') || msg.includes('incorporat') || msg.includes('register') || msg.includes('formation')) lead.serviceNeeded = 'Company Formation';
    else if (msg.includes('bank') || msg.includes('account')) lead.serviceNeeded = 'Banking Setup';
    else if (msg.includes('tax') || msg.includes('vat') || msg.includes('gst') || msg.includes('irs')) lead.serviceNeeded = 'Tax Compliance';
    else if (msg.includes('fema') || msg.includes('rbi') || msg.includes('overseas investment')) lead.serviceNeeded = 'FEMA & Investment';
    else if (msg.includes('visa') || msg.includes('residency') || msg.includes('golden visa')) lead.serviceNeeded = 'Residency / Golden Visa';
    else if (msg.includes('annual') || msg.includes('maintenance') || msg.includes('compliance')) lead.serviceNeeded = 'Annual Maintenance';

    if (lead.serviceNeeded) console.log(`📝 Captured service: ${lead.serviceNeeded}`);
  }

  // Detect business stage
  if (!lead.businessStage) {
    if (msg.includes('startup') || msg.includes('start up') || msg.includes('just started')) lead.businessStage = 'Startup';
    else if (msg.includes('freelancer') || msg.includes('freelance') || msg.includes('consultant')) lead.businessStage = 'Freelancer';
    else if (msg.includes('sme') || msg.includes('small business') || msg.includes('medium')) lead.businessStage = 'SME';
    else if (msg.includes('established') || msg.includes('large company') || msg.includes('enterprise') || msg.includes('corporation')) lead.businessStage = 'Established Company';

    if (lead.businessStage) console.log(`📝 Captured stage: ${lead.businessStage}`);
  }

  // Detect timeline
  if (!lead.timeline) {
    if (msg.includes('immediately') || msg.includes('asap') || msg.includes('urgent') || msg.includes('right away')) lead.timeline = 'Immediately';
    else if (msg.includes('this month') || msg.includes('this week') || msg.includes('soon')) lead.timeline = 'Within 1 month';
    else if (msg.includes('next month') || msg.includes('1-2 months') || msg.includes('couple of months')) lead.timeline = '1-2 months';
    else if (msg.includes('3 months') || msg.includes('quarter') || msg.includes('few months')) lead.timeline = '3 months';
    else if (msg.includes('6 months') || msg.includes('half year')) lead.timeline = '6 months';

    if (lead.timeline) console.log(`📝 Captured timeline: ${lead.timeline}`);
  }
}

function capitalize(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ─────────────────────────────────────────────
// INTERAKT: SEND TEMPLATE
// ─────────────────────────────────────────────
async function sendTemplate(phone) {
  if (!INTERAKT_API_KEY) return;

  const payload = {
    countryCode: "+91",
    phoneNumber: phone,
    callbackData: "template_fallback",
    type: "Template",
    template: {
      name: "welcome_reply",
      languageCode: "en"
    }
  };

  try {
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${INTERAKT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();
    if (!res.ok) {
      console.error("❌ Template Error:", responseText);
    } else {
      console.log("📩 Template sent successfully!");
    }
  } catch (err) {
    console.error("❌ Template Network Error:", err.message);
  }
}

// ─────────────────────────────────────────────
// INTERAKT: SEND TEXT
// ─────────────────────────────────────────────
async function sendWhatsAppMessage(phone, text) {
  console.log("🤖 BOT:", text);

  if (!INTERAKT_API_KEY) {
    console.warn("⚠️ Skipping WhatsApp send — no API key.");
    return;
  }

  const payload = {
    countryCode: "+91",
    phoneNumber: phone,
    callbackData: "bot_reply",
    type: "Text",
    data: { message: text }
  };

  try {
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${INTERAKT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error("❌ Interakt Error:", responseText);
      if (responseText.includes('24 hours')) {
        console.log("⏰ Outside 24hr window — sending template...");
        await sendTemplate(phone);
      }
    } else {
      console.log("✅ Message sent successfully!");
    }
  } catch (err) {
    console.error("❌ Send Network Error:", err.message);
  }
}

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Respond immediately to avoid Interakt timeout

  try {
    const body = req.body;
    console.log("📦 Webhook received:", body.type);

    if (body.type !== 'message_received') return;

    const phone = cleanPhone(body.data?.customer?.phone_number);
    const rawMsg = body.data?.message?.message || '';

    if (!phone || !rawMsg) return;

    console.log(`\n📩 Incoming from ${phone}: "${rawMsg}"`);

    if (!conversations[phone]) {
      conversations[phone] = freshSession();
      conversations[phone].leadData.phone = phone;
      console.log(`🆕 New session created for ${phone}`);
    }

    const session = conversations[phone];
    const reply = await getClaudeReply(session, rawMsg);

    if (reply) {
      await sendWhatsAppMessage(phone, reply);
    }

  } catch (e) {
    console.error('❌ Webhook Error:', e.message);
  }
});

// ─────────────────────────────────────────────
// LOCAL CHAT TEST ENDPOINT
// POST http://localhost:5000/chat  { "message": "hi" }
// ─────────────────────────────────────────────
const testSession = freshSession();
testSession.leadData.phone = 'test_user';

app.post('/chat', async (req, res) => {
  try {
    const msg = req.body.message || '';
    if (!msg) return res.json({ reply: "Please send a message." });

    console.log(`\n💬 Test message: "${msg}"`);
    const reply = await getClaudeReply(testSession, msg);
    res.json({ reply, leadData: testSession.leadData });

  } catch (e) {
    console.error('❌ Chat Error:', e.message);
    res.json({ reply: "Error occurred." });
  }
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`\n🔥 Server running on port ${PORT}`);
  console.log(`📡 Webhook: POST http://localhost:${PORT}/webhook`);
  console.log(`💬 Local test: POST http://localhost:${PORT}/chat`);
  console.log(`❤️  Health: GET http://localhost:${PORT}/health\n`);
});
