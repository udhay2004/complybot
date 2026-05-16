const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow the CRM dashboard (served from any origin) to call this API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const INTERAKT_API_KEY   = (process.env.INTERAKT_API_KEY   || '').replace(/['"` \n\r]/g, '');
const ANTHROPIC_API_KEY  = (process.env.ANTHROPIC_API_KEY  || '').replace(/['"` \n\r]/g, '');
const MONGODB_URI        = process.env.MONGODB_URI         || '';
const GOOGLE_SHEET_ID    = process.env.GOOGLE_SHEET_ID     || '';
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS  || ''; // JSON string
const RESEND_API_KEY     = (process.env.RESEND_API_KEY     || '').replace(/['"` \n\r]/g, '');
const NOTIFY_EMAIL       = process.env.NOTIFY_EMAIL        || 'udhaymarwah96@gmail.com';
const FROM_EMAIL         = process.env.FROM_EMAIL          || 'onboarding@resend.dev';
const BASE_URL           = process.env.BASE_URL            || 'https://complybot.onrender.com';
const HUMAN_TIMEOUT_MS   = parseInt(process.env.HUMAN_TIMEOUT_MS || '7200000'); // 2 hours default

[
  ['INTERAKT_API_KEY',  INTERAKT_API_KEY],
  ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
  ['MONGODB_URI',       MONGODB_URI],
  ['GOOGLE_SHEET_ID',   GOOGLE_SHEET_ID],
  ['RESEND_API_KEY',    RESEND_API_KEY],
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
    await sessionsCol.createIndex({ lastActive: 1 }, { expireAfterSeconds: 86400 });
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
    console.log(`🆕 New session: ${phone}`);
  } else {
    let dirty = false;
    if (session.askedAdditionalInfo === undefined)              { session.askedAdditionalInfo = false; dirty = true; }
    // NEW: track whether we asked additional info before handoff
    if (session.askedHandoffAdditionalInfo === undefined)       { session.askedHandoffAdditionalInfo = false; dirty = true; }
    if (session.pendingHumanHandoff === undefined)              { session.pendingHumanHandoff = false; dirty = true; }
    if (session.leadData && session.leadData.additionalInfo === undefined) { session.leadData.additionalInfo = null; dirty = true; }
    if (session.humanMode === undefined)                        { session.humanMode = false; dirty = true; }
    if (dirty) {
      await sessionsCol.replaceOne({ phone }, session, { upsert: true });
      console.log(`🔧 Migrated session: ${phone}`);
    }
    console.log(`📂 Loaded session: ${phone} | name=${session.leadData?.name} | current=${session.leadData?.currentCountry} | target=${session.leadData?.targetCountry} | askedExtra=${session.askedAdditionalInfo} | leadCollected=${session.leadCollected} | pendingHandoff=${session.pendingHumanHandoff}`);
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
  // Always stamp source so CRM dashboard knows where this lead came from
  leadData.source = leadData.source || 'whatsapp';
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
// EMAIL
// ─────────────────────────────────────────────
async function sendEmail({ subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('⚠️ RESEND_API_KEY missing — skipping email');
    return { success: false, error: 'No API key' };
  }
  if (!NOTIFY_EMAIL) {
    console.warn('⚠️ NOTIFY_EMAIL missing — skipping email');
    return { success: false, error: 'No recipient email' };
  }

  console.log(`📧 Attempting to send email to ${NOTIFY_EMAIL}...`);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        subject: subject,
        html: html,
      }),
    });

    const responseText = await res.text();
    let responseJson;
    try { responseJson = JSON.parse(responseText); }
    catch (e) { responseJson = { raw: responseText }; }

    if (!res.ok) {
      console.error('❌ Resend API error:', res.status, responseJson);
      throw new Error(`Resend API error (${res.status}): ${responseText}`);
    }
    console.log('✅ Email sent successfully:', responseJson.id || 'sent');
    return { success: true, id: responseJson.id };
  } catch (err) {
    console.error('❌ Email send error:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendHumanHandoffEmail(phone, leadData, lastMessages) {
  try {
    const chatPreview = lastMessages
      .slice(-6)
      .map(m => `${m.role === 'user' ? '👤 Customer' : '🤖 Bot'}: ${m.content}`)
      .join('\n\n');

    const resumeUrl = `${BASE_URL}/resume-bot/${phone}`;
    const timeoutHours = Math.round(HUMAN_TIMEOUT_MS / 3600000);

    await sendEmail({
      subject: `🚨 Human Takeover Requested — ${leadData.name || phone}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#1a1a2e;color:white;padding:20px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">🌍 Comply Globally — Human Handoff Alert</h2>
          </div>
          <div style="background:#f9f9f9;padding:20px;border:1px solid #eee">
            <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px;margin-bottom:16px">
              ⏱️ <b>Bot is paused for this customer.</b> It will auto-resume in <b>${timeoutHours} hours</b> if no action is taken.
            </div>
            <h3 style="margin-top:0">Customer Details</h3>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px;color:#666">Name</td><td style="padding:6px"><b>${leadData.name || 'Not captured'}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Phone</td><td style="padding:6px"><b>+${phone}</b></td></tr>
              <tr><td style="padding:6px;color:#666">Based In</td><td style="padding:6px">${leadData.currentCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Target Country</td><td style="padding:6px">${leadData.targetCountry || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Service</td><td style="padding:6px">${leadData.serviceNeeded || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Stage</td><td style="padding:6px">${leadData.businessStage || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Timeline</td><td style="padding:6px">${leadData.timeline || '—'}</td></tr>
              <tr><td style="padding:6px;color:#666">Additional Info</td><td style="padding:6px">${leadData.additionalInfo || '—'}</td></tr>
            </table>
            <h3>Last 6 Messages</h3>
            <pre style="background:#fff;border:1px solid #ddd;padding:12px;border-radius:4px;white-space:pre-wrap;font-size:13px">${chatPreview}</pre>
            <p style="color:#555;font-size:13px">Reply to this customer directly in your Interakt inbox. When your team is done, click below to hand back to the bot:</p>
            <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
              <a href="https://app.interakt.ai" style="display:inline-block;background:#1a1a2e;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">Open Interakt Inbox →</a>
              <a href="${resumeUrl}" style="display:inline-block;background:#166534;color:white;padding:10px 20px;border-radius:6px;text-decoration:none">✅ Resume Bot for +${phone}</a>
            </div>
            <p style="color:#aaa;font-size:11px;margin-top:16px">Bot will auto-resume after ${timeoutHours}h regardless.</p>
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
  try {
    await sendEmail({
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
              <tr><td style="padding:6px;color:#666">Additional Info</td><td style="padding:6px">${leadData.additionalInfo || '—'}</td></tr>
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
You have persistent memory of every customer. Use it actively:
- If customer context is injected below → they are a KNOWN customer. Greet them by name.
- If marked RETURNING CUSTOMER → acknowledge their previous interaction naturally.
- Never re-ask for information already in the context.
- If they say their expert hasn't called → apologise, reassure, and say the team will follow up.
- Reference their details naturally: "Since you're in India expanding to UAE…"
- If someone claims to be a teammate/colleague of a known customer → treat them as a new contact, collect their details separately.

━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR GOAL: PRE-CALL INTAKE
━━━━━━━━━━━━━━━━━━━━━━━━━━
Think of yourself as a smart intake consultant preparing a brief for the expert before their call. Your job is to learn as much as possible so the expert walks in prepared — not starting from scratch.

You must naturally collect ALL SIX of these before wrapping up the conversation:
  1. Full Name
  2. Current Country (where they are based now)
  3. Target Country (where they want to expand)
  4. Service Needed (company formation, banking, tax, FEMA, visa, or maintenance)
  5. Business Stage (startup, freelancer, SME, or established company)
  6. Timeline (how urgently they want to move)

COLLECTION RULES:
- NEVER ask all fields at once — one question per message, always.
- Weave questions into the conversation naturally. Use their answers to ask the next logical question.
- If a field comes up naturally in what they say, capture it silently and move on — never re-ask.
- If someone skips a question or says "I'll discuss on the call", warmly accept it and move to the next missing field.
- Only wrap up AFTER you have all 6 fields (or the person has clearly declined to share one).
- When done, give a warm 2-line summary of what you've noted, then say exactly: "Our expert will review your requirements and reach out to you on this WhatsApp number shortly. 🎉"
- Do NOT ask for additional info yourself after the summary — the system sends that question automatically.

EXAMPLE FLOW (natural, not robotic):
  Customer: "Hi, I want to expand my business"
  Comply: "Welcome! I'm Comply 🌍 Happy to help. Where are you currently based?"
  Customer: "India"
  Comply: "Got it. And which country are you looking to expand into?"
  Customer: "UAE"
  Comply: "Great choice. Are you looking to set up a company there, or is it more around banking or tax?"
  Customer: "Company setup"
  Comply: "Perfect — company formation in UAE. Is this a new venture or an existing business?"
  Customer: "Existing, running 3 years"
  Comply: "Excellent. And how soon are you looking to get started — next few weeks, or still in planning?"
  Customer: "Next month ideally"
  [Now has all 6 — wraps up with summary]

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
- Be warm, confident, and curious — like a knowledgeable friend, not a form.
- One question per message. Never fire two questions in one reply.
- When greeted, introduce yourself briefly then ask where they are currently based.
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
    // NEW: tracks the two-step human handoff flow
    pendingHumanHandoff: false,
    askedHandoffAdditionalInfo: false,
    createdAt: new Date(),
    lastActive: new Date()
  };
}

function buildContextSummary(leadData, isReturning, leadCollected) {
  const known = [];
  if (leadData.name)           known.push(`Name: ${leadData.name}`);
  if (leadData.currentCountry) known.push(`Based in: ${leadData.currentCountry}`);
  if (leadData.targetCountry)  known.push(`Target country: ${leadData.targetCountry}`);
  if (leadData.serviceNeeded)  known.push(`Service: ${leadData.serviceNeeded}`);
  if (leadData.businessStage)  known.push(`Business stage: ${leadData.businessStage}`);
  if (leadData.timeline)       known.push(`Timeline: ${leadData.timeline}`);
  if (leadData.additionalInfo) known.push(`Additional info: ${leadData.additionalInfo}`);

  if (known.length === 0) return '';

  let ctx = '\n\n';
  if (isReturning && leadData.name) {
    ctx += `[RETURNING CUSTOMER — This phone number belongs to ${leadData.name}. `;
    ctx += `They have spoken with us before. Greet them warmly by name. `;
    ctx += `Do NOT ask for information you already have. `;
    if (leadCollected) {
      ctx += `Their requirements have already been submitted to our experts. `;
      ctx += `If they are following up, acknowledge their previous request and reassure them an expert will be in touch. `;
    }
    ctx += `Known details: ${known.join(' | ')}]`;
  } else {
    ctx += `[CUSTOMER CONTEXT: ${known.join(' | ')}]`;
  }
  return ctx;
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
  const msg  = userMessage.toLowerCase().trim();

  if (!lead.name) {
    const namePatterns = [
      /(?:my name is|name is|i'm|i am|this is|call me)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+){0,2})/i,
      /^([a-zA-Z]+(?:\s+[a-zA-Z]+){1,2})\s*(?:here|,|$)/i,
    ];
    const skipWords = new Set([
      'based','from','india','uae','uk','usa','hi','hello','hey','yes','no',
      'sir','madam','canada','singapore','vietnam','dubai','indonesia','there',
      'glad','happy','great','good','fine','well','not','just','and','the',
      'for','with','want','expand','going','looking','please','thanks'
    ]);
    for (const pat of namePatterns) {
      const m = userMessage.match(pat);
      if (m) {
        const words = m[1].trim().split(/\s+/);
        while (words.length > 0 && skipWords.has(words[words.length-1].toLowerCase())) words.pop();
        const name = words.join(' ').trim();
        if (name.length > 1 && !skipWords.has(name.toLowerCase())) {
          lead.name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
            .replace(/\b\w/g, c => c.toUpperCase());
          console.log("📝 Name:", lead.name);
          break;
        }
      }
    }
  }

  const countries = [
    'vietnam','india','uae','dubai','abu dhabi','usa','united states','america',
    'uk','united kingdom','britain','england','singapore','hong kong','canada',
    'netherlands','holland','saudi arabia','saudi','mauritius','egypt','nigeria',
    'indonesia','thailand','malaysia','philippines','germany','france','italy',
    'spain','portugal','ireland','luxembourg','cyprus','malta','bahrain',
    'kuwait','oman','qatar','bangladesh','pakistan','sri lanka','nepal'
  ];

  const countryMap = {
    'dubai': 'UAE', 'abu dhabi': 'UAE', 'america': 'USA', 'united states': 'USA',
    'britain': 'UK', 'england': 'UK', 'united kingdom': 'UK', 'holland': 'Netherlands',
    'saudi': 'Saudi Arabia'
  };

  const expansionKw = [
    'expand to','expand in','expanding to','expanding in',
    'open in','open a','opening in',
    'setup in','set up in','setting up in',
    'register in','registering in',
    'incorporate in','incorporating in',
    'start in','starting in','launch in',
    'move to','moving to','relocate to',
    'want to expand','want to go','want in','want to open',
    'looking to expand','looking to open','looking to setup',
    'planning to expand','planning to open',
    'i mean','i meant'
  ];

  const currentKw = [
    'based in','i am based','currently based',
    "i'm in",'i am in','currently in',
    'living in','located in','residing in',
    "i'm from",'i am from','we are from',
    'our office is','our company is in','we operate from'
  ];

  const isExpansion = expansionKw.some(k => msg.includes(k));
  const isCurrent   = currentKw.some(k => msg.includes(k));

  for (const c of countries) {
    if (!msg.includes(c)) continue;
    const mapped = countryMap[c] || capitalize(c);

    if (isExpansion && !isCurrent && !lead.targetCountry) {
      lead.targetCountry = mapped;
      console.log("📝 Target:", lead.targetCountry);
      break;
    } else if (isCurrent && !isExpansion && !lead.currentCountry) {
      lead.currentCountry = mapped;
      console.log("📝 Current:", lead.currentCountry);
      break;
    } else if (!isExpansion && !isCurrent) {
      if (!lead.currentCountry) {
        lead.currentCountry = mapped;
        console.log("📝 Current (inferred):", lead.currentCountry);
      } else if (!lead.targetCountry) {
        lead.targetCountry = mapped;
        console.log("📝 Target (inferred):", lead.targetCountry);
      }
      break;
    } else if (isExpansion && isCurrent) {
      if (!lead.targetCountry) {
        lead.targetCountry = mapped;
        console.log("📝 Target (mixed msg):", lead.targetCountry);
      }
      break;
    }
  }

  if (!lead.serviceNeeded) {
    if (msg.match(/compan|incorporat|formation|register|llc|llp|pvt|entity|business setup|establish/))
      lead.serviceNeeded = 'Company Formation';
    else if (msg.match(/bank|account|finance|payment|remit/))
      lead.serviceNeeded = 'Banking Setup';
    else if (msg.match(/tax|vat|gst|irs|filing|transfer pric/))
      lead.serviceNeeded = 'Tax Compliance';
    else if (msg.match(/fema|rbi|overseas invest|foreign invest/))
      lead.serviceNeeded = 'FEMA & Investment';
    else if (msg.match(/visa|residency|golden visa|pr |permanent resid/))
      lead.serviceNeeded = 'Residency / Golden Visa';
    else if (msg.match(/annual|maintenance|secretar|compliance|agent/))
      lead.serviceNeeded = 'Annual Maintenance';
    if (lead.serviceNeeded) console.log("📝 Service:", lead.serviceNeeded);
  }

  if (!lead.businessStage) {
    if (msg.match(/startup|start.?up|just start|new business|new company|early stage/))
      lead.businessStage = 'Startup';
    else if (msg.match(/freelanc|independ|consultant|solo/))
      lead.businessStage = 'Freelancer';
    else if (msg.match(/sme|small.?medium|small business|mid.?size/))
      lead.businessStage = 'SME';
    else if (msg.match(/established|enterprise|corporat|large|mnc|multinational/))
      lead.businessStage = 'Established Company';
    if (lead.businessStage) console.log("📝 Stage:", lead.businessStage);
  }

  if (!lead.timeline) {
    const timeMatch = msg.match(/(\d+)\s*(?:month|week|year)/);
    if (timeMatch) {
      const n = parseInt(timeMatch[1]);
      if (msg.includes('week'))       lead.timeline = n <= 2 ? 'Immediately' : 'Within 1 month';
      else if (n <= 1)                 lead.timeline = 'Within 1 month';
      else if (n <= 2)                 lead.timeline = '1-2 months';
      else if (n <= 3)                 lead.timeline = '3 months';
      else if (n <= 6)                 lead.timeline = '6 months';
      else                             lead.timeline = '6+ months';
    } else if (msg.match(/yesterday|immediately|asap|urgent|right now|today/)) {
      lead.timeline = 'Immediately';
    } else if (msg.match(/this month|soon|shortly|quickly/)) {
      lead.timeline = 'Within 1 month';
    }
    if (lead.timeline) console.log("📝 Timeline:", lead.timeline);
  }

  // Capture additional info for the normal lead flow
  if (session.askedAdditionalInfo && !lead.additionalInfo && userMessage.trim().length > 2) {
    const noInfoPhrases = ['no','nope','nothing','thats all','that\'s all','no thanks','not really','all good','nah','nothing else','no more','none'];
    const isNegative = noInfoPhrases.some(p => msg === p || msg.startsWith(p + ' ') || msg.startsWith(p + ','));
    lead.additionalInfo = isNegative ? 'None' : userMessage.trim();
    console.log("📝 Additional info (lead flow):", lead.additionalInfo);
  }

  // Capture additional info for the human handoff flow
  if (session.askedHandoffAdditionalInfo && !lead.additionalInfo && userMessage.trim().length > 2) {
    const noInfoPhrases = ['no','nope','nothing','thats all','that\'s all','no thanks','not really','all good','nah','nothing else','no more','none'];
    const isNegative = noInfoPhrases.some(p => msg === p || msg.startsWith(p + ' ') || msg.startsWith(p + ','));
    lead.additionalInfo = isNegative ? 'None' : userMessage.trim();
    console.log("📝 Additional info (handoff flow):", lead.additionalInfo);
  }
}

function capitalize(str) {
  return str.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function isLeadComplete(lead) {
  return !!(lead.name && lead.currentCountry && lead.targetCountry && lead.additionalInfo);
}

function isLeadCoreComplete(lead) {
  // Wait for all 6 fields before triggering the wrap-up and additional-info question.
  // If a field is still null after the full conversation, we still proceed — the bot
  // may have moved on when the customer declined to share it.
  const hasCore     = !!(lead.name && lead.currentCountry && lead.targetCountry);
  const hasService  = !!lead.serviceNeeded;
  const hasStage    = !!lead.businessStage;
  const hasTimeline = !!lead.timeline;
  return hasCore && hasService && hasStage && hasTimeline;
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

  const hasHistory = session.history.length > 1;
  const hasData = !!(session.leadData.name || session.leadData.currentCountry);
  const isReturning = hasHistory || hasData;

  const systemWithContext = SYSTEM_PROMPT + buildContextSummary(session.leadData, isReturning, session.leadCollected);

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
// NOTE: sendTemplate() has been REMOVED intentionally.
// The old welcome template is no longer used now that the chatbot
// handles all first-contact conversations. Sending the template
// as a fallback was causing unexpected messages to customers.
// ─────────────────────────────────────────────
async function sendWhatsAppMessage(phone, text) {
  console.log('🤖 BOT:', text);
  if (!INTERAKT_API_KEY) { console.warn('⚠️ No Interakt key'); return; }

  try {
    const res = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: `Basic ${INTERAKT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode: '+91',
        phoneNumber: phone.startsWith('91') ? phone.slice(2) : phone,
        callbackData: 'bot_reply',
        type: 'Text', data: { message: text }
      })
    });
    const txt = await res.text();
    if (!res.ok) {
      // ⚠️  Template fallback REMOVED — if the 24-hour window has passed,
      // Interakt will reject the message. Log the error and do nothing else.
      // Your human team should re-initiate contact through Interakt directly.
      console.error('❌ Interakt error (message not delivered):', txt);
    } else {
      console.log('✅ Message sent');
    }
  } catch (err) {
    console.error('❌ Send error:', err.message);
  }
}

// ─────────────────────────────────────────────
// SAVE LEAD HELPER (used in both flows)
// ─────────────────────────────────────────────
async function finalizeLead(session) {
  session.leadCollected = true;
  console.log(`🎯 Lead complete for ${session.phone}! Saving...`);
  const summary = await generateSummary(session.history);
  try {
    await appendToSheet(session.leadData, summary);
    console.log('✅ Sheet updated');
  } catch (sheetErr) {
    console.error('❌ Sheet error:', sheetErr.message);
  }
  try {
    await saveLead({ ...session.leadData, source: 'whatsapp', summary, completedAt: new Date() });
    console.log('✅ MongoDB lead saved');
  } catch (dbErr) {
    console.error('❌ DB save error:', dbErr.message);
  }
  try {
    await sendLeadCapturedEmail(session.leadData);
    console.log('✅ Lead email sent');
  } catch (emailErr) {
    console.error('❌ Email error:', emailErr.message);
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

    const phone = (body.data?.customer?.phone_number || '').replace(/^\+/, '').replace(/\D/g, '');
    const rawMsg = body.data?.message?.message || '';
    if (!phone || !rawMsg) return;

    console.log(`\n📩 From ${phone}: "${rawMsg}"`);

    const session = await getSession(phone);

    // ── Auto-resume check ──────────────────────
    if (session.humanMode) {
      const handoffAge = Date.now() - new Date(session.humanModeAt || 0).getTime();
      if (handoffAge >= HUMAN_TIMEOUT_MS) {
        console.log(`⏰ Human timeout reached for ${phone} — auto-resuming bot`);
        session.humanMode = false;
        session.humanModeAt = null;
        await saveSession(session);
        // Fall through to normal bot flow
      } else {
        const remainingMins = Math.ceil((HUMAN_TIMEOUT_MS - handoffAge) / 60000);
        console.log(`🧑 Human mode active for ${phone} — bot silent (auto-resumes in ~${remainingMins}m)`);
        return;
      }
    }

    // ── STEP 2 of human handoff: receive additional info, then hand off ──
    // The customer already said they want a human. We asked for extra info.
    // Now we receive their reply and complete the handoff.
    if (session.pendingHumanHandoff && session.askedHandoffAdditionalInfo) {
      console.log(`📝 Receiving handoff additional info for ${phone}`);
      extractLeadData(session, rawMsg); // This captures additionalInfo via askedHandoffAdditionalInfo flag

      // Confirm to customer
      const handoffMsg = "Of course! 🙏 I'm connecting you to one of our experts right now. They'll reach out to you on this WhatsApp number shortly. Please hold on!";
      await sendWhatsAppMessage(phone, handoffMsg);
      session.history.push({ role: 'assistant', content: handoffMsg });

      // Activate human mode
      session.humanMode = true;
      session.humanModeAt = new Date();
      session.pendingHumanHandoff = false;

      // Save lead to MongoDB + Sheet + email (even if not fully complete)
      if (!session.leadCollected) {
        await finalizeLead(session);
      }

      // Send handoff email to team
      await sendHumanHandoffEmail(phone, session.leadData, session.history);
      await saveSession(session);
      return;
    }

    // ── STEP 1 of human handoff: customer says "connect me to a human" ──
    if (wantsHuman(rawMsg)) {
      console.log(`🙋 Human requested by ${phone} — asking additional info first`);

      // Ask for any additional info before connecting
      const additionalQ = `Before I connect you to our expert, is there anything specific you'd like them to know? 📋

For example: preferred meeting time, number of team members joining, specific questions, or any other details.

(Reply 'no' if nothing else)`;

      await sendWhatsAppMessage(phone, additionalQ);
      session.history.push({ role: 'assistant', content: additionalQ });

      // Mark that we're in a pending handoff state
      session.pendingHumanHandoff = true;
      session.askedHandoffAdditionalInfo = true;

      await saveSession(session);
      return;
    }

    // ── Normal bot flow ──
    extractLeadData(session, rawMsg);

    console.log(`📊 Lead: name=${session.leadData.name} | from=${session.leadData.currentCountry} | to=${session.leadData.targetCountry} | service=${session.leadData.serviceNeeded} | askedExtra=${session.askedAdditionalInfo} | collected=${session.leadCollected}`);

    const reply = await getClaudeReply(session, rawMsg);
    await sendWhatsAppMessage(phone, reply);

    // Ask additional info once core lead is complete (normal flow, not handoff)
    if (!session.askedAdditionalInfo && !session.leadCollected && isLeadCoreComplete(session.leadData)) {
      session.askedAdditionalInfo = true;
      const additionalQ = "One last thing before I connect you with our expert — is there anything specific you'd like them to know? Any additional details, questions, or requirements? 📋\n\n(Reply 'no' if nothing else)";
      console.log(`💬 Asking additional info for ${phone}`);
      await sendWhatsAppMessage(phone, additionalQ);
      session.history.push({ role: 'assistant', content: additionalQ });
      await saveSession(session);
      return;
    }

    // Receive additional info reply (normal flow) and finalize lead
    if (session.askedAdditionalInfo && !session.leadCollected) {
      if (!session.leadData.additionalInfo) {
        const noInfoPhrases = ['no','nope','nothing','thats all','no thanks','not really','none','nah','nothing else','no more'];
        const isNo = noInfoPhrases.some(p => rawMsg.toLowerCase().trim() === p || rawMsg.toLowerCase().trim().startsWith(p + ' '));
        session.leadData.additionalInfo = isNo ? 'None' : rawMsg.trim();
        console.log(`📝 Additional info captured: ${session.leadData.additionalInfo}`);
      }
      await finalizeLead(session);
    }

    await saveSession(session);

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ─────────────────────────────────────────────
// HUMAN CONTROL ENDPOINTS
// ─────────────────────────────────────────────
app.post('/resume-bot/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  session.humanMode = false;
  session.humanModeAt = null;
  await saveSession(session);
  await sendWhatsAppMessage(phone, "Hi again! 👋 I'm Comply, back to assist you. How can I help?");
  res.json({ success: true, message: `Bot resumed for ${phone}` });
});

app.get('/resume-bot/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  session.humanMode = false;
  session.humanModeAt = null;
  await saveSession(session);
  await sendWhatsAppMessage(phone, "Hi again! 👋 I'm Comply, back to assist you. How can I help?");
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2 style="color:#166534">✅ Bot resumed for +${phone}</h2>
      <p>Comply will now respond to this customer's next message.</p>
    </body></html>
  `);
});

app.get('/status/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  res.json({ phone, humanMode: session.humanMode, leadData: session.leadData });
});

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

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─────────────────────────────────────────────
// DEBUG ENDPOINTS
// ─────────────────────────────────────────────
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

    await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A1:A1',
    });
    results.sheetReadOk = true;

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

app.get('/debug-email', async (req, res) => {
  const result = {
    timestamp: new Date().toISOString(),
    config: {
      hasResendKey: !!RESEND_API_KEY,
      resendKeyPrefix: RESEND_API_KEY ? RESEND_API_KEY.substring(0, 8) + '...' : 'missing',
      notifyEmail: NOTIFY_EMAIL,
      fromEmail: FROM_EMAIL,
    },
    sendResult: null,
    error: null
  };

  try {
    const sendResult = await sendEmail({
      subject: '✅ Comply Bot - Email Test',
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <h2 style="color:#166534">Email Working! 🎉</h2>
          <p>This test email was sent at: ${new Date().toLocaleString()}</p>
          <p>Your Comply Globally bot emails should now work.</p>
          <hr>
          <p style="color:#666;font-size:12px">If you see this, Resend is configured correctly.</p>
        </div>
      `
    });
    result.sendResult = sendResult;
    res.json(result);
  } catch (err) {
    result.error = err.message;
    res.status(500).json(result);
  }
});

app.get('/force-sheet/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const session = await getSession(phone);
  if (!session) return res.json({ error: 'Session not found' });
  try {
    const summary = await generateSummary(session.history);
    await appendToSheet(session.leadData, summary);
    await saveLead({ ...session.leadData, source: 'whatsapp', summary, completedAt: new Date() });
    res.json({ success: true, leadData: session.leadData, summary });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/clear-session/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  try {
    if (sessionsCol) {
      await sessionsCol.deleteOne({ phone });
      const alt = phone.startsWith('91') ? phone.slice(2) : '91' + phone;
      await sessionsCol.deleteOne({ phone: alt });
    }
    res.json({ success: true, message: `Session cleared for ${phone}. Fresh start on next message.` });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/reset-all-sessions', async (req, res) => {
  try {
    if (sessionsCol) {
      const result = await sessionsCol.deleteMany({});
      res.json({ success: true, deleted: result.deletedCount, message: 'All sessions cleared.' });
    } else {
      res.json({ error: 'No DB connection' });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// RESET LEADS — wipes all leads from MongoDB so the CRM starts fresh.
// Sessions are kept intact so existing customers are still recognised.
// Called by the CRM dashboard "Reset CRM" button.
// ─────────────────────────────────────────────
app.delete('/reset-leads', async (req, res) => {
  try {
    if (!leadsCol) return res.status(503).json({ error: 'No DB connection' });
    const result = await leadsCol.deleteMany({});
    console.log(`🗑️  CRM reset — ${result.deletedCount} leads deleted`);
    res.json({ success: true, deleted: result.deletedCount, message: 'All leads cleared. CRM will now show only new leads going forward.' });
  } catch (err) {
    console.error('❌ Reset leads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────
// KEEP-ALIVE
// ─────────────────────────────────────────────
const KEEP_ALIVE_URL      = process.env.KEEP_ALIVE_URL || `${BASE_URL}/health`;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000;

function startKeepAlive() {
  console.log(`💓 Keep-alive enabled → pinging ${KEEP_ALIVE_URL} every 14 min`);
  setInterval(async () => {
    try {
      const res = await fetch(KEEP_ALIVE_URL);
      console.log(`💓 Keep-alive ping OK [${res.status}] — ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`💔 Keep-alive ping FAILED: ${err.message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
}

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
    console.log(`❤️  Health:      GET  /health`);
    console.log(`📧 Test email:  GET  /debug-email\n`);
    startKeepAlive();
  });
});
