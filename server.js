const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const INTERAKT_API_KEY   = (process.env.INTERAKT_API_KEY   || '').replace(/['"` \n\r]/g, '');
const ANTHROPIC_API_KEY  = (process.env.ANTHROPIC_API_KEY  || '').replace(/['"` \n\r]/g, '');
const MONGODB_URI        = process.env.MONGODB_URI         || '';
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID     || '';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS  || ''; // JSON string
const SMTP_USER          = process.env.SMTP_USER           || '';
const SMTP_PASS          = process.env.SMTP_PASS           || '';
const NOTIFY_EMAIL       = process.env.NOTIFY_EMAIL        || 'udhaymarwah96@gmail.com';

[
  ['INTERAKT_API_KEY',  INTERAKT_API_KEY],
  ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
  ['MONGODB_URI',       MONGODB_URI],
  ['GOOGLE_SHEET_ID',   GOOGLE_SHEET_ID],
  ['SMTP_USER',         SMTP_USER],
  ['SMTP_PASS',         SMTP_PASS],
].forEach(([k, v]) => {
  if (!v) console.error(`❌ ${k} missing!`);
  else    console.log(`✅ ${k} loaded`);
});

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
let db;
let sessionsCol;
let leadsCol;

async function connectMongo() {
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db          = client.db('comply_globally');
    sessionsCol = db.collection('sessions');
    leadsCol    = db.collection('leads');
    await sessionsCol.createIndex({ phone: 1 }, { unique: true });
    await sessionsCol.createIndex({ lastActive: 1 }, { expireAfterSeconds: 86400 }); // auto-expire 24h
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

async function getSession(phone) {
  if (!sessionsCol) return freshSession(phone);
  let session = await sessionsCol.findOne({ phone });
  if (!session) {
    session = freshSession(phone);
    await sessionsCol.insertOne(session);
  }
  return session;
}

async function saveSession(session) {
  if (!sessionsCol) return;
  session.lastActive = new Date();
  await sessionsCol.replaceOne({ phone: session.phone }, session, { upsert: true });
}

async function saveLead(leadData) {
  if (!leadsCol) return;
  await leadsCol.replaceOne({ phone: leadData.phone }, leadData, { upsert: true });
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS
// ─────────────────────────────────────────────
async function appendToSheet(leadData, conversationSummary) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CREDENTIALS) {
    console.warn('⚠️ Skipping Sheets — missing GOOGLE_SHEET_ID or GOOGLE_CREDENTIALS');
    return;
  }
  try {
    console.log('📊 Attempting to write to Google Sheet...');
    const creds = JSON.parse(GOOGLE_CREDENTIALS);
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const now    = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const row    = [
      now,
      leadData.name           || '',
      leadData.phone          || '',
      leadData.currentCountry || '',
      leadData.targetCountry  || '',
      leadData.serviceNeeded  || '',
      leadData.businessStage  || '',
      leadData.timeline       || '',
      leadData.additionalInfo || '',
      conversationSummary     || '',
    ];

    // Check if header row exists; if not, add it
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:A1',
    });
    if (!existing.data.values) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: 'Sheet1!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [['Timestamp','Name','Phone','Current Country','Target Country','Service Needed','Business Stage','Timeline','Additional Info','Conversation Summary']] },
      });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    console.log('✅ Lead appended to Google Sheet');
  } catch (err) {
    console.error('❌ Google Sheets error:', err.message);
  }
}

// ─────────────────────────────────────────────
// EMAIL (nodemailer via Gmail)
// ─────────────────────────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

async function sendHumanHandoffEmail(phone, leadData, lastMessages) {
  if (!SMTP_USER || !SMTP_PASS) return;
  try {
    const transporter = createTransporter();
    const chatPreview = lastMessages
      .slice(-6)
      .map(m => `${m.role === 'user' ? '👤 Customer' : '🤖 Bot'}: ${m.content}`)
      .join('\n\n');

    await transporter.sendMail({
      from: `"Comply Bot" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `🚨 Human Takeover Requested — ${leadData.name || phone}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1a1a2e;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">🌍 Comply Globally — Human Handoff Alert</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #eee">
            <h3>Customer Details</h3>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px;color:#666">Name</td><td style="padding:6px"><b>${leadData.name || 'Not captured'}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Phone</td><td style="padding:6px"><b>+${phone}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Based In</td><td style="padding:6px">${leadData.currentCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Target Country</td><td style="padding:6px">${leadData.targetCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Service</td><td style="padding:6px">${leadData.serviceNeeded || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Stage</td><td style="padding:6px">${leadData.businessStage || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Timeline</td><td style="padding:6px">${leadData.timeline || '—'}</td></tr>
            </table>
            <h3>Last 6 Messages</h3>
            <pre style="background:#fff;border:1px solid #ddd;padding:12px;border-radius:4px;white-space:pre-wrap;font-size:13px">${chatPreview}</pre>
            <p style="color:#888;font-size:12px">Reply to this customer directly in your Interakt inbox. The bot has been paused for this user.</p>
            <a href="https://app.interakt.ai" style="display:inline-block;background:#1a1a2e;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;margin-top:10px">Open Interakt Inbox →</a>
          </div>
        </div>
      `
    });
    console.log(`📧 Handoff email sent for ${phone}`);
  } catch (err) {
    console.error('❌ Email error:', err.message);
  }
}

async function sendLeadCapturedEmail(leadData) {
  if (!SMTP_USER || !SMTP_PASS) return;
  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"Comply Bot" <${SMTP_USER}>`,
      to: NOTIFY_EMAIL,
      subject: `✅ New Lead Captured — ${leadData.name || leadData.phone}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#166534;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">✅ New Lead — Comply Globally</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #eee">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px;color:#666">Name</td><td style="padding:6px"><b>${leadData.name || '—'}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Phone</td><td style="padding:6px"><b>+${leadData.phone}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Based In</td><td style="padding:6px">${leadData.currentCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Target Country</td><td style="padding:6px">${leadData.targetCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Service</td><td style="padding:6px">${leadData.serviceNeeded || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Stage</td><td style="padding:6px">${leadData.businessStage || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Timeline</td><td style="padding:6px">${leadData.timeline || '—'}</td></tr>
            </table>
            <p style="margin-top:16px;color:#888;font-size:12px">This lead has also been logged to your Google Sheet.</p>
          </div>
        </div>
      `
    });
    console.log(`📧 Lead email sent for ${leadData.phone}`);
  } catch (err) {
    console.error('❌ Lead email error:', err.message);
  }
}

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
- Once you know their current country → tailor answers to their local regulations
- Once you know their target country → focus all suggestions on that jurisdiction
- Once you know their business stage → adjust tone and depth accordingly
- Never re-ask for information already given
- Reference their details naturally: "Since you're in India expanding to UAE…"

━━━━━━━━━━━━━━━━━━━━━━━━━━
LEAD COLLECTION GOALS
━━━━━━━━━━━━━━━━━━━━━━━━━━
Naturally collect these through conversation (never ask all at once):
✅ Full Name | ✅ Current Country | ✅ Target Country | ✅ Service Needed | ✅ Business Stage | ✅ Timeline

Once you have Name + Current Country + Target Country + Service Needed → say:
"Thank you [Name]! 🎉 Our expert will review your requirements and reach out to you on this WhatsApp number shortly."
Do NOT ask for additional info yourself — the system will handle that separately.

━━━━━━━━━━━━━━━━━━━━━━━━━━
HUMAN HANDOFF
━━━━━━━━━━━━━━━━━━━━━━━━━━
If the customer says anything like "talk to a human", "speak to someone", "real person", "agent", "call me" → reply EXACTLY:
"Of course! 🙏 I'm connecting you to one of our experts right now. They'll reach out to you on this WhatsApp number shortly. Please hold on!"
Then stop responding — a human will take over.

━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━
- WhatsApp = SHORT responses (2–4 lines max). No walls of text.
- Be warm, professional, confident. No filler phrases.
- When greeted, introduce yourself briefly and ask where they are currently based.
- Collect info naturally — like a smart consultant, not a form.
- Use emojis sparingly (✅ 🌍 💼 📋)

━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ No specific legal/tax advice → "Our experts will guide you during consultation"
❌ No prices → "Pricing depends on jurisdiction — our team will send a custom quote"
❌ No guarantees on bank/visa approval
❌ No sensitive documents in chat → "Please use our secure client portal"
❌ No off-topic responses → redirect to global business expansion`;

// ─────────────────────────────────────────────
// SESSION FACTORY
// ─────────────────────────────────────────────
function freshSession(phone) {
  return {
    phone,
    history: [],
    leadData: {
      name: null, phone,
      currentCountry: null, targetCountry: null,
      serviceNeeded: null, businessStage: null,
      timeline: null, additionalInfo: null
    },
    leadCollected: false,
    humanMode: false,
    askedAdditionalInfo: false,
    createdAt: new Date(),
    lastActive: new Date()
  };
}

function buildContextSummary(leadData) {
  const parts = [];
  if (leadData.name)           parts.push(`Customer name: ${leadData.name}`);
  if (leadData.currentCountry) parts.push(`Based in: ${leadData.currentCountry}`);
  if (leadData.targetCountry)  parts.push(`Wants to expand to: ${leadData.targetCountry}`);
  if (leadData.serviceNeeded)  parts.push(`Service interested in: ${leadData.serviceNeeded}`);
  if (leadData.businessStage)  parts.push(`Business stage: ${leadData.businessStage}`);
  if (leadData.timeline)       parts.push(`Timeline: ${leadData.timeline}`);
  return parts.length > 0
    ? `\n\n[CUSTOMER CONTEXT SO FAR: ${parts.join(' | ')}]`
    : '';
}

// ─────────────────────────────────────────────
// HUMAN HANDOFF DETECTION
// ─────────────────────────────────────────────
const HUMAN_TRIGGERS = [
  'human', 'agent', 'real person', 'speak to someone', 'talk to someone',
  'call me', 'speak with', 'talk with', 'connect me', 'senior', 'manager',
  'expert', 'representative', 'live person', 'actual person', 'not a bot'
];

function wantsHuman(msg) {
  const lower = msg.toLowerCase();
  return HUMAN_TRIGGERS.some(t => lower.includes(t));
}

// ─────────────────────────────────────────────
// LEAD EXTRACTION
// ─────────────────────────────────────────────
function extractLeadData(session, userMessage) {
  const lead = session.leadData;
  const msg  = userMessage.toLowerCase();

  // ── Name ──────────────────────────────────
  // Match "my name is X" stopping at "and/from/,/i " etc
  const nameMatch = userMessage.match(/(?:my name is|i am|i'm|this is|name[:\-\s]+)\s*([A-Za-z]+(?:\s+[A-Za-z]+){0,2}?)(?:\s+(?:and|from|i |,|\.|I want|based|looking)|$)/i)
    || userMessage.match(/(?:my name is|i am|i'm|this is)\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,2})/i)
    || userMessage.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})[,\s]/);
  if (nameMatch && !lead.name) {
    const candidate = (nameMatch[1] || '').trim();
    const skipWords = [
      'based','from','india','uae','uk','usa','hi','hello','hey','yes','no',
      'sir','madam','canada','singapore','vietnam','dubai','there','glad','happy',
      'great','good','fine','well','not','just','and','the','for','with'
    ];
    const words = candidate.split(' ');
    // Filter out trailing skip words (e.g. "stefan and" → "stefan")
    while (words.length > 0 && skipWords.includes(words[words.length-1].toLowerCase())) {
      words.pop();
    }
    const cleanName = words.join(' ').trim();
    if (cleanName.length > 1 && !skipWords.includes(cleanName.toLowerCase())) {
      lead.name = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
      console.log(`📝 Name: ${lead.name}`);
    }
  }

  const countries = [
    'vietnam','india','uae','dubai','abu dhabi','usa','united states','uk','united kingdom',
    'singapore','hong kong','canada','netherlands','saudi arabia','mauritius',
    'egypt','nigeria','indonesia','thailand','malaysia','philippines','germany',
    'france','italy','spain','portugal','ireland','luxembourg','cyprus','malta',
    'bahrain','kuwait','oman','qatar','gcc'
  ];

  // Keywords that clearly indicate EXPANSION (target country)
  const expansionKw = [
    'expand to','expand in','open in','setup in','set up in','register in',
    'incorporate in','start in','launch in','move to','going to','want in',
    'looking at','considering','choose','between','option'
  ];

  // Keywords that clearly indicate CURRENT location
  const currentKw = [
    'based in','currently in','i am in','i\'m in','living in','located in',
    'from','i represent','our company is in','we are in','we\'re in'
  ];

  const isCurrentMsg  = currentKw.some(k => msg.includes(k));
  const isExpansionMsg = expansionKw.some(k => msg.includes(k));

  if (isExpansionMsg && !isCurrentMsg) {
    // This message is about where they WANT to go
    for (const c of countries) {
      if (msg.includes(c) && !lead.targetCountry) {
        lead.targetCountry = capitalize(c);
        console.log(`📝 Target: ${lead.targetCountry}`);
        break;
      }
    }
  } else if (isCurrentMsg && !isExpansionMsg) {
    // This message is about where they ARE
    for (const c of countries) {
      if (msg.includes(c) && !lead.currentCountry) {
        lead.currentCountry = capitalize(c);
        console.log(`📝 Current: ${lead.currentCountry}`);
        break;
      }
    }
  } else if (!isCurrentMsg && !isExpansionMsg) {
    // Ambiguous — only set currentCountry if not yet captured
    for (const c of countries) {
      if (msg.includes(c)) {
        if (!lead.currentCountry) {
          lead.currentCountry = capitalize(c);
          console.log(`📝 Current (inferred): ${lead.currentCountry}`);
        }
        break;
      }
    }
  }

  // ── Service ───────────────────────────────
  if (!lead.serviceNeeded) {
    if      (msg.includes('company') || msg.includes('incorporat') || msg.includes('formation')) lead.serviceNeeded = 'Company Formation';
    else if (msg.includes('bank') || msg.includes('account'))                                    lead.serviceNeeded = 'Banking Setup';
    else if (msg.includes('tax') || msg.includes('vat') || msg.includes('gst'))                 lead.serviceNeeded = 'Tax Compliance';
    else if (msg.includes('fema') || msg.includes('rbi'))                                        lead.serviceNeeded = 'FEMA & Investment';
    else if (msg.includes('visa') || msg.includes('residency') || msg.includes('golden'))       lead.serviceNeeded = 'Residency / Golden Visa';
    else if (msg.includes('annual') || msg.includes('maintenance'))                              lead.serviceNeeded = 'Annual Maintenance';
    if (lead.serviceNeeded) console.log(`📝 Service: ${lead.serviceNeeded}`);
  }

  // ── Business Stage ────────────────────────
  if (!lead.businessStage) {
    if      (msg.includes('startup') || msg.includes('just started'))     lead.businessStage = 'Startup';
    else if (msg.includes('freelancer') || msg.includes('consultant'))    lead.businessStage = 'Freelancer';
    else if (msg.includes('sme') || msg.includes('small business'))       lead.businessStage = 'SME';
    else if (msg.includes('established') || msg.includes('enterprise') || msg.includes('represent')) lead.businessStage = 'Established Company';
    else if (msg.includes('it services') || msg.includes('software') || msg.includes('tech')) lead.businessStage = 'Tech Company';
    if (lead.businessStage) console.log(`📝 Stage: ${lead.businessStage}`);
  }

  // ── Timeline ──────────────────────────────
  if (!lead.timeline) {
    if      (msg.includes('yesterday') || msg.includes('immediately') || msg.includes('asap') || msg.includes('urgent')) lead.timeline = 'Immediately';
    else if (msg.includes('this month') || msg.includes('soon'))         lead.timeline = 'Within 1 month';
    else if (msg.includes('next month') || msg.includes('1-2 months'))  lead.timeline = '1-2 months';
    else if (msg.includes('3 months') || msg.includes('quarter'))       lead.timeline = '3 months';
    else if (msg.includes('6 months'))                                   lead.timeline = '6 months';
    if (lead.timeline) console.log(`📝 Timeline: ${lead.timeline}`);
  }

  // ── Additional Info ───────────────────────
  // Capture anything said AFTER the bot asked for additional info
  if (session.askedAdditionalInfo && !lead.additionalInfo && userMessage.trim().length > 2) {
    const noInfoPhrases = ['no','nope','nothing','that\'s all','thats all','no thanks','not really','all good','nah'];
    const isNegative = noInfoPhrases.some(p => msg.trim() === p || msg.trim().startsWith(p + ' '));
    lead.additionalInfo = isNegative ? 'None' : userMessage.trim();
    console.log(`📝 Additional info: ${lead.additionalInfo}`);
  }
}

function capitalize(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Lead is "ready to log" only after additional info step is done
function isLeadComplete(lead) {
  return !!(lead.name && lead.currentCountry && lead.targetCountry && lead.serviceNeeded && lead.additionalInfo);
}

// Lead has core info — ready to ask additional info question
function isLeadCoreComplete(lead) {
  return !!(lead.name && lead.currentCountry && lead.targetCountry && lead.serviceNeeded);
}

async function generateSummary(history) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Summarize this WhatsApp conversation in 2-3 sentences, focusing on what the customer wants and their business context:\n\n${history.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n')}`
        }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || '';
  } catch { return ''; }
}

// ─────────────────────────────────────────────
// CLAUDE AI
// ─────────────────────────────────────────────
async function getClaudeReply(session, userMessage) {
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 30) session.history = session.history.slice(-30);

  const systemWithContext = SYSTEM_PROMPT + buildContextSummary(session.leadData);

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
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: session.history
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('❌ Claude error:', JSON.stringify(data));
      return "I'm having trouble right now. Please try again in a moment. 🙏";
    }

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || "I'm looking into that. Could you give me a moment? 🙏";

    session.history.push({ role: 'assistant', content: reply });
    return reply;

  } catch (err) {
    console.error('❌ Claude network error:', err.message);
    return "I'm having trouble connecting right now. Please try again in a moment. 🙏";
  }
}

// ─────────────────────────────────────────────
// INTERAKT: SEND TEXT
// ─────────────────────────────────────────────
async function sendTemplate(phone) {
  if (!INTERAKT_API_KEY) return;
  await fetch('https://api.interakt.ai/v1/public/message/', {
    method: 'POST',
    headers: { Authorization: `Basic ${INTERAKT_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      countryCode: '+91', phoneNumber: phone, callbackData: 'template_fallback',
      type: 'Template', template: { name: 'welcome_reply', languageCode: 'en' }
    })
  }).catch(e => console.error('❌ Template error:', e.message));
}

async function sendWhatsAppMessage(phone, text) {
  console.log('🤖 BOT:', text);
  if (!INTERAKT_API_KEY) { console.warn('⚠️ No Interakt key'); return; }

  try {
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: `Basic ${INTERAKT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: '+91', phoneNumber: phone, callbackData: 'bot_reply',
        type: 'Text', data: { message: text }
      })
    });
    const txt = await res.text();
    if (!res.ok) {
      console.error('❌ Interakt error:', txt);
      if (txt.includes('24 hours')) await sendTemplate(phone);
    } else {
      console.log('✅ Message sent');
    }
  } catch (err) {
    console.error('❌ Send error:', err.message);
  }
}

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.type !== 'message_received') return;

    // Normalize phone: strip +, keep digits, ensure country code included
    const rawPhone = (body.data?.customer?.phone_number || '').replace(/^\+/, '').replace(/\D/g, '');
    const phone = rawPhone.length === 10 ? '91' + rawPhone : rawPhone;
    const rawMsg = body.data?.message?.message || '';
    if (!phone || !rawMsg) return;

    console.log(`\n📩 From ${phone}: "${rawMsg}"`);

    const session = await getSession(phone);

    // ── HUMAN MODE: bot stays silent ──────────
    if (session.humanMode) {
      console.log(`🧑 Human mode active for ${phone} — bot silent`);
      return;
    }

    // ── HUMAN HANDOFF REQUESTED ───────────────
    if (wantsHuman(rawMsg)) {
      console.log(`🙋 Human requested by ${phone}`);
      session.humanMode = true;
      const reply = "Of course! 🙏 I'm connecting you to one of our experts right now. They'll reach out to you on this WhatsApp number shortly. Please hold on!";
      await sendWhatsAppMessage(phone, reply);
      session.history.push({ role: 'assistant', content: reply });
      await sendHumanHandoffEmail(phone, session.leadData, session.history);
      await saveSession(session);
      return;
    }

    // ── NORMAL FLOW ───────────────────────────
    extractLeadData(session, rawMsg);

    const reply = await getClaudeReply(session, rawMsg);
    await sendWhatsAppMessage(phone, reply);

    // ── CORE LEAD DONE → ask additional info ──
    if (!session.askedAdditionalInfo && isLeadCoreComplete(session.leadData)) {
      session.askedAdditionalInfo = true;
      console.log(`💬 Asking additional info for ${phone}`);
      const additionalQ = "Before I hand you over to our expert — is there anything else you'd like them to know? Any specific requirements, questions, or details you'd like to share? 📋";
      await sendWhatsAppMessage(phone, additionalQ);
      session.history.push({ role: 'assistant', content: additionalQ });
    }

    // ── LEAD FULLY COMPLETE → log everything ──
    const wasComplete = session.leadCollected;
    if (!wasComplete && isLeadComplete(session.leadData)) {
      session.leadCollected = true;
      console.log(`🎯 Lead complete for ${phone}`);
      const summary = await generateSummary(session.history);
      // Log to sheet with verbose error output
      try {
        await appendToSheet(session.leadData, summary);
      } catch (sheetErr) {
        console.error('❌ Sheet append failed:', sheetErr.message);
      }
      await saveLead({ ...session.leadData, summary, completedAt: new Date() });
      await sendLeadCapturedEmail(session.leadData);
    }

    await saveSession(session);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────
// HUMAN CONTROL ENDPOINTS
// ─────────────────────────────────────────────

// Resume bot for a user (after human is done)
app.post('/resume-bot/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  session.humanMode = false;
  await saveSession(session);
  await sendWhatsAppMessage(phone, "Hi again! 👋 I'm Comply, back to assist you. How can I help?");
  res.json({ success: true, message: `Bot resumed for ${phone}` });
});

// Check human mode status
app.get('/status/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  res.json({ phone, humanMode: session.humanMode, leadData: session.leadData });
});

// View all leads
app.get('/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  const leads = await leadsCol.find({}).sort({ completedAt: -1 }).limit(100).toArray();
  res.json(leads);
});

// ─────────────────────────────────────────────
// LOCAL TEST
// ─────────────────────────────────────────────
const testSession = freshSession('test_user');

app.post('/chat', async (req, res) => {
  try {
    const msg = req.body.message || '';
    if (!msg) return res.json({ reply: 'Please send a message.' });

    if (wantsHuman(msg)) {
      testSession.humanMode = true;
      return res.json({ reply: "Of course! 🙏 Connecting you to an expert shortly.", humanMode: true });
    }

    extractLeadData(testSession, msg);
    const reply = await getClaudeReply(testSession, msg);
    res.json({ reply, leadData: testSession.leadData, humanMode: testSession.humanMode });
  } catch (e) {
    console.error('❌ Chat error:', e.message);
    res.json({ reply: 'Error occurred.' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── DEBUG: Test Google Sheets connection directly ──────────
app.get('/debug-sheets', async (req, res) => {
  const results = { env: {}, parseOk: false, authOk: false, writeOk: false, error: null };
  results.env.GOOGLE_SHEET_ID = GOOGLE_SHEET_ID ? '✅ set' : '❌ missing';
  results.env.GOOGLE_CREDENTIALS_length = GOOGLE_CREDENTIALS ? GOOGLE_CREDENTIALS.length : 0;
  results.env.GOOGLE_CREDENTIALS_starts = GOOGLE_CREDENTIALS.substring(0, 20);
  results.env.GOOGLE_CREDENTIALS_ends = GOOGLE_CREDENTIALS.substring(GOOGLE_CREDENTIALS.length - 20);

  try {
    const creds = JSON.parse(GOOGLE_CREDENTIALS);
    results.parseOk = true;
    results.client_email = creds.client_email;
    results.has_private_key = !!creds.private_key;
    results.private_key_start = creds.private_key ? creds.private_key.substring(0, 40) : 'MISSING';

    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    results.authOk = true;

    // Try to read the sheet first
    const readRes = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:A1',
    });
    results.sheetReadOk = true;

    // Try to write a test row
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [['DEBUG TEST', 'Test Name', '9999999999', 'India', 'UAE', 'Company Formation', 'Startup', 'ASAP', 'Debug test row', 'This is a test']] },
    });
    results.writeOk = true;

  } catch (err) {
    results.error = err.message;
    results.stack = err.stack;
  }

  res.json(results);
});

// ── Force-log a specific session to sheet ─────────────────
app.get('/force-sheet/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  if (!session) return res.json({ error: 'Session not found' });
  try {
    const summary = await generateSummary(session.history);
    await appendToSheet(session.leadData, summary);
    await saveLead({ ...session.leadData, summary, completedAt: new Date() });
    res.json({ success: true, leadData: session.leadData, summary });
  } catch (err) {
    res.json({ error: err.message });
  }
});
// ── Clear/reset a session (fixes stuck old sessions) ──────
app.get('/clear-session/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  try {
    if (sessionsCol) await sessionsCol.deleteOne({ phone });
    res.json({ success: true, message: `Session cleared for ${phone}. Fresh start on next message.` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🔥 Server running on port ${PORT}`);
    console.log(`📡 Webhook:     POST /webhook`);
    console.log(`💬 Test chat:   POST /chat`);
    console.log(`▶️  Resume bot:  POST /resume-bot/:phone`);
    console.log(`📊 Leads:       GET  /leads`);
    console.log(`❤️  Health:      GET  /health\n`);
  });
});
