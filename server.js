'use strict';

/**
 * ============================================================
 *  COMPLY GLOBALLY — WhatsApp AI Chatbot Backend (v3)
 *
 *  CHANGES FROM v2:
 *  ⚡ SPEED: max_tokens cut to 350, parallel DB writes, KB retrieval limit=1
 *  🎛️  QUICK REPLIES: every Claude response ends with 1️⃣2️⃣3️⃣4️⃣ topic buttons
 *  ✅ MENU FIX: invalid selections ("5", "6") → clear error; valid → full answer
 *  🧠 MENU CONTENT: stores option TEXT + TOPIC so Claude knows what to answer
 *
 *  ENVIRONMENT VARIABLES REQUIRED:
 *    INTERAKT_API_KEY     — Interakt WhatsApp API key
 *    ANTHROPIC_API_KEY    — Claude API key
 *    MONGODB_URI          — MongoDB connection string
 *    RESEND_API_KEY       — Resend email API key
 *    NOTIFY_EMAIL         — Email address to send notifications to
 *    FROM_EMAIL           — Sender email (Resend verified domain)
 *    BASE_URL             — Your deployed server URL
 *    HUMAN_TIMEOUT_MS     — ms before bot auto-resumes after human handoff (default 7200000)
 *    PORT                 — Server port (default 5000)
 * ============================================================
 */

// ─────────────────────────────────────────────
// DEPENDENCIES
// ─────────────────────────────────────────────
const express         = require('express');
const path            = require('path');
const fetch           = require('node-fetch');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS, PUT');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────
// ENVIRONMENT CONFIG
// ─────────────────────────────────────────────
const INTERAKT_API_KEY  = (process.env.INTERAKT_API_KEY  || '').replace(/['"` \n\r]/g, '');
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/['"` \n\r]/g, '');
const MONGODB_URI       = process.env.MONGODB_URI        || '';
const RESEND_API_KEY    = (process.env.RESEND_API_KEY    || '').replace(/['"` \n\r]/g, '');
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL       || 'udhaymarwah96@gmail.com';
const FROM_EMAIL        = process.env.FROM_EMAIL         || 'onboarding@resend.dev';
const BASE_URL          = process.env.BASE_URL           || 'https://complybot.onrender.com';
const HUMAN_TIMEOUT_MS  = parseInt(process.env.HUMAN_TIMEOUT_MS || '7200000', 10);

[
  ['INTERAKT_API_KEY',  INTERAKT_API_KEY],
  ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
  ['MONGODB_URI',       MONGODB_URI],
  ['RESEND_API_KEY',    RESEND_API_KEY],
].forEach(([k, v]) => {
  if (!v) console.error(`❌  ENV MISSING: ${k}`);
  else    console.log (`✅  ENV loaded:  ${k}`);
});

// ════════════════════════════════════════════════════════════════════════════
// ════════ KNOWLEDGE BASE — PASTE YOUR COMPLETE KB HERE ════════════════════
// ════════════════════════════════════════════════════════════════════════════
//
//  HOW TO INSERT YOUR KB:
//  1. Find the line:  const KNOWLEDGE_BASE = `
//  2. Paste your entire KB content between the backticks below
//  3. Keep the closing backtick on its own line
//
//  The system will automatically:
//   - Chunk the KB by ━━━ section headers
//   - Score chunks against user keywords (TF-IDF)
//   - Inject only the TOP 1 most relevant chunk per request (speed!)
//   - Fallback to first 1500 chars if no match
//
const KNOWLEDGE_BASE = `
PASTE_YOUR_KNOWLEDGE_BASE_HERE
`;
// ════════════════════════════════════════════════════════════════════════════
// ════════ END KNOWLEDGE BASE INSERTION POINT ════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// QUICK-REPLY TOPIC BANKS
// These are the numbered options appended to every Claude response.
// Keys match country/topic slugs. Claude picks the right bank based on context.
// ─────────────────────────────────────────────
const QUICK_REPLY_BANKS = {
  uae: [
    'UAE Mainland LLC setup',
    'Free Zone comparison',
    'UAE banking requirements',
    'Corporate tax implications',
  ],
  usa: [
    'Best US state for my business',
    'LLC vs C-Corp comparison',
    'US banking without SSN',
    'Form 5472 & compliance',
  ],
  uk: [
    'UK company incorporation',
    'UK banking options',
    'UK tax & VAT overview',
    'Skilled Worker visa',
  ],
  singapore: [
    'Singapore Pte. Ltd. setup',
    'Resident director requirement',
    'Singapore tax benefits',
    'Banking & account opening',
  ],
  canada: [
    'Canada incorporation options',
    'GST/HST registration',
    'Resident director requirement',
    'Banking & payroll setup',
  ],
  india_fema: [
    'Form OI & UIN registration',
    'Annual Performance Report (APR)',
    'FLA Return filing',
    'Compounding & late rectification',
  ],
  thailand: [
    'BOI promotion benefits',
    'Foreign Business Act limits',
    'Thai banking timeline',
    'Work permit requirements',
  ],
  estonia: [
    'e-Residency application',
    'Estonian OÜ incorporation',
    'EU VAT & tax benefits',
    'Banking for e-residents',
  ],
  indonesia: [
    'PT PMA setup & capital',
    'Positive Investment List check',
    'Indonesia banking timeline',
    'Work permit (ITAS) process',
  ],
  philippines: [
    'Philippines subsidiary setup',
    'PEZA incentives overview',
    'BIR & SEC registration',
    'Employment & payroll rules',
  ],
  vietnam: [
    'Vietnam LLC incorporation',
    'Foreign ownership rules',
    'Vietnam banking process',
    'Work permit requirements',
  ],
  italy: [
    'Italian S.r.l. incorporation',
    'IRES & IRAP tax rates',
    'Golden Power & restrictions',
    'Employment & CCNL rules',
  ],
  general: [
    'Compare jurisdictions for my business',
    'FEMA/ODI compliance (Indian founders)',
    'Banking setup in target country',
    'Speak to an advisor',
  ],
};

// Emoji number map for display
const EMOJI_NUMS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];

/**
 * Detect which quick-reply bank to use based on conversation context.
 * Checks the last few messages for country/topic keywords.
 */
function detectTopicBank(session, userMessage) {
  const recent = [
    userMessage,
    ...(session.history || []).slice(-4).map(m => m.content),
  ].join(' ').toLowerCase();

  if (/\buae\b|dubai|abu dhabi|emirates|free zone|mainland/.test(recent)) return 'uae';
  if (/\busa\b|\bus\b|america|delaware|wyoming|llc|c-corp/.test(recent))   return 'usa';
  if (/\buk\b|britain|england|companies house|hmrc/.test(recent))           return 'uk';
  if (/singapore|pte\.?\s*ltd|acra|iras/.test(recent))                      return 'singapore';
  if (/canada|toronto|cra|gst.*hst/.test(recent))                           return 'canada';
  if (/fema|odi|rbi|apr|fla return|form oi/.test(recent))                   return 'india_fema';
  if (/thailand|bangkok|boi|fba|thai/.test(recent))                         return 'thailand';
  if (/estonia|e-residency|estonian|o[uü]/.test(recent))                    return 'estonia';
  if (/indonesia|pt pma|jakarta|kbli/.test(recent))                         return 'indonesia';
  if (/philippines|manila|peza|bir|sec/.test(recent))                       return 'philippines';
  if (/vietnam|ho chi minh|hanoi|vnd/.test(recent))                         return 'vietnam';
  if (/italy|milan|rome|s\.r\.l|ires|irap/.test(recent))                    return 'italy';
  return 'general';
}

/**
 * Build the quick-reply footer string appended to every bot response.
 * Returns an object: { footer: string, options: string[] }
 */
function buildQuickReplyFooter(bank) {
  const options = QUICK_REPLY_BANKS[bank] || QUICK_REPLY_BANKS.general;
  const lines   = options.map((opt, i) => `${EMOJI_NUMS[i]} ${opt}`);
  const footer  = `\n\n*Quick topics:*\n${lines.join('\n')}`;
  return { footer, options };
}

// ─────────────────────────────────────────────
// MONGODB — CONNECTION & COLLECTIONS
// ─────────────────────────────────────────────
let db, sessionsCol, leadsCol, activeStateCol, analyticsCol, menuStateCol;

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI not set — memory-only mode'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    db             = client.db('complybot');
    sessionsCol    = db.collection('sessions');
    leadsCol       = db.collection('leads');
    activeStateCol = db.collection('activeStates');
    analyticsCol   = db.collection('analytics');
    menuStateCol   = db.collection('menuState');

    await Promise.all([
      sessionsCol.createIndex({ phone: 1 }, { unique: true }),
      activeStateCol.createIndex({ phone: 1 }, { unique: true }),
      menuStateCol.createIndex({ phone: 1 }, { unique: true }),
      analyticsCol.createIndex({ phone: 1, ts: -1 }),
    ]);
    console.log('✅  MongoDB connected — complybot database');
  } catch (err) {
    console.error('❌  MongoDB connection failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// IN-MEMORY CACHE (TTL: 30 min)
// ─────────────────────────────────────────────
const SESSION_TTL      = 30 * 60 * 1000;
const sessionCache     = new Map();
const activeStateCache = new Map();
const menuStateCache   = new Map();
const kbChunkCache     = new Map();

function cacheSet(map, key, value) { map.set(key, { value, ts: Date.now() }); }
function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > SESSION_TTL) { map.delete(key); return null; }
  return e.value;
}

// ─────────────────────────────────────────────
// KNOWLEDGE BASE CHUNKER & RETRIEVER
// ⚡ SPEED: limit=1 — only the single best chunk injected per request
// ─────────────────────────────────────────────
function extractKeywords(text) {
  const words = text.toLowerCase().match(/\b\w{4,}\b/g) || [];
  const freq  = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w);
}

function chunkKnowledgeBase(kb) {
  if (!kb || kb.includes('PASTE_YOUR_KNOWLEDGE_BASE_HERE')) return [];
  const chunks = [];
  const sections = kb.split(/━{3,}/);
  sections.forEach((section, idx) => {
    if (section.trim().length < 50) return;
    const subsections = section.split(/(?=^[A-Z][A-Z0-9\s]+:|\n[A-Z][A-Z0-9\s]+:)/gm);
    subsections.forEach(sub => {
      if (sub.trim().length > 50) {
        chunks.push({ id: `${idx}-${chunks.length}`, content: sub.trim(), keywords: extractKeywords(sub) });
      }
    });
  });
  return chunks;
}

function retrieveRelevantKB(userMessage, limit = 1) {
  if (KNOWLEDGE_BASE.includes('PASTE_YOUR_KNOWLEDGE_BASE_HERE')) return '';
  const cached = cacheGet(kbChunkCache, 'chunks');
  const chunks = cached || chunkKnowledgeBase(KNOWLEDGE_BASE);
  if (!cached) cacheSet(kbChunkCache, 'chunks', chunks);

  const msgKeywords = extractKeywords(userMessage);
  const scored = chunks
    .map(chunk => ({ ...chunk, score: msgKeywords.filter(kw => chunk.keywords.includes(kw)).length }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(c => c.content)
    .join('\n\n');

  return scored || KNOWLEDGE_BASE.substring(0, 1500) + '\n[...full KB available...]';
}

// ─────────────────────────────────────────────
// FOOTER DEDUPLICATION
// Claude sometimes generates its own "Quick topics:" block despite instructions.
// Strip it before we append the system-controlled footer.
// ─────────────────────────────────────────────
function stripClaudeGeneratedFooter(text) {
  return text
    // Remove any "*Quick topics:*" / "Quick topics:" block and everything after it
    .replace(/\n*[\*_]*Quick\s+(?:topics|reply|options)[\*_]*:?[\s\S]*/i, '')
    // Remove if Claude starts a standalone emoji-number list
    .replace(/\n+(?:1️⃣|2️⃣|3️⃣|4️⃣|5️⃣|6️⃣)[\s\S]*/m, '')
    .trimEnd();
}

// ─────────────────────────────────────────────
// MENU STATE
// Stores: validOptions (display labels) + optionTopics (what each option means)
// ─────────────────────────────────────────────
function freshMenuState(phone) {
  return {
    phone,
    validOptions:  [],   // e.g. ["UAE Mainland LLC setup", "Free Zone comparison", ...]
    optionTopics:  [],   // same array — stored for Claude context
    menuShownAt:   null,
    updatedAt:     new Date(),
  };
}

async function getMenuState(phone) {
  const cached = cacheGet(menuStateCache, phone);
  if (cached) return cached;
  let state = menuStateCol ? await menuStateCol.findOne({ phone }) : null;
  if (!state) state = freshMenuState(phone);
  cacheSet(menuStateCache, phone, state);
  return state;
}

async function saveMenuState(state) {
  state.updatedAt = new Date();
  cacheSet(menuStateCache, state.phone, state);
  if (menuStateCol) {
    const { _id, ...doc } = state;
    await menuStateCol.replaceOne({ phone: state.phone }, doc, { upsert: true });
  }
}

// ─────────────────────────────────────────────
// NAME VALIDATOR
// ─────────────────────────────────────────────
const INVALID_NAME_PATTERNS = [
  /^(yes|no|sure|okay|ok|hello|hi|hey|thanks|thank you|please|more|less|good|bad|other|same|different)$/i,
  /^(usa|uk|india|canada|australia|singapore|uae|dubai|london|new\s+york|california|florida)$/i,
  /^(company|business|service|product|office|team|person|people|money|cost|fee|time|date|number)$/i,
  /^[a-z]{1,2}$/i,
  /^\d+$/,
  /^(1|2|3|4|5|option|menu|reply|answer)$/i,
];

const COMMON_FIRST_NAMES = new Set([
  'john','james','robert','michael','william','david','richard','joseph','thomas','charles',
  'christopher','daniel','matthew','anthony','mark','donald','steven','paul','andrew','joshua',
  'kenneth','kevin','brian','edward','ronald','timothy','jason','jeffrey','ryan','jacob',
  'mary','patricia','jennifer','linda','barbara','elizabeth','susan','jessica','sarah','karen',
  'nancy','betty','margaret','sandra','ashley','kimberly','emily','donna','michelle','dorothy',
  'carol','amanda','melissa','deborah','stephanie','rebecca','sharon','laura','cynthia','anna',
  'arun','amit','anita','arjun','akshay','ashish','anand','raj','rahul','rohan','ravi',
  'ritesh','rajesh','ramesh','rakesh','sandeep','sanjay','sameer','saurabh','suresh','sunil',
  'priya','pooja','priyanka','prakash','neha','nikhil','nishant','neeraj','naresh','naveen',
  'mahesh','mohit','manoj','murali','mohan','mukesh','harish','harsh','vivek','vikas','varun',
  'vikram','vinod','vinay','yogesh','yash','udhay','uddhav','umesh','aryan','aarav','kabir',
  'zara','zoey','zainab','ishaan','ishita','kavya','kavita','meera','naina','pallavi','riya',
]);

function isValidName(candidate) {
  if (!candidate || candidate.length < 2 || candidate.length > 50) return false;
  const trimmed = candidate.trim();
  const lower   = trimmed.toLowerCase();
  if (INVALID_NAME_PATTERNS.some(p => p.test(lower))) return false;
  const words       = trimmed.split(/[\s\-']+/);
  const hasCommon   = words.some(w => COMMON_FIRST_NAMES.has(w.toLowerCase()));
  const hasCapital  = /[A-Z]/.test(trimmed);
  const noNumbers   = !/\d/.test(trimmed);
  return (hasCommon || hasCapital) && noNumbers && !/[@#$%^&*()_+=[\]{};:'"<>,.?/\\|`~]/.test(trimmed);
}

// ─────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────
function freshSession(phone) {
  return { phone, history: [], leadData: { phone }, leadCollected: false, createdAt: new Date(), lastActive: new Date() };
}

async function getSession(phone) {
  const cached = cacheGet(sessionCache, phone);
  if (cached) return cached;
  let session = sessionsCol ? await sessionsCol.findOne({ phone }) : null;
  if (!session) session = freshSession(phone);
  session.history  = session.history  || [];
  session.leadData = session.leadData || { phone };
  cacheSet(sessionCache, phone, session);
  return session;
}

async function saveSession(session) {
  session.lastActive = new Date();
  cacheSet(sessionCache, session.phone, session);
  if (sessionsCol) {
    const { _id, ...doc } = session;
    await sessionsCol.replaceOne({ phone: session.phone }, doc, { upsert: true });
  }
}

// ─────────────────────────────────────────────
// ACTIVE STATE MANAGER
// ─────────────────────────────────────────────
function freshActiveState(phone) {
  return {
    phone,
    currentFlow:        'ONBOARDING',
    conversationStage:  'GREETING',
    retryCount:         0,
    humanModeActive:    false,
    humanModeSince:     null,
    handoffPending:     false,
    handoffStage:       null,   // null | 'ASKED_ADDL_INFO'
    lastInteractionAt:  new Date(),
    messageCount:       0,
  };
}

async function getActiveState(phone) {
  const cached = cacheGet(activeStateCache, phone);
  if (cached) return cached;
  let state = activeStateCol ? await activeStateCol.findOne({ phone }) : null;
  if (!state) state = freshActiveState(phone);
  cacheSet(activeStateCache, phone, state);
  return state;
}

async function saveActiveState(state) {
  state.lastInteractionAt = new Date();
  cacheSet(activeStateCache, state.phone, state);
  if (activeStateCol) {
    const { _id, ...doc } = state;
    await activeStateCol.replaceOne({ phone: state.phone }, doc, { upsert: true });
  }
}

// ─────────────────────────────────────────────
// ENTITY EXTRACTOR
// ─────────────────────────────────────────────
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;

const COUNTRIES_DICT = {
  usa:'USA','united states':'USA',america:'USA','us':'USA',
  canada:'Canada',mexico:'Mexico',brazil:'Brazil',
  uk:'UK',britain:'UK',england:'UK',scotland:'UK',wales:'UK',london:'UK',
  germany:'Germany',france:'France',italy:'Italy',spain:'Spain',
  netherlands:'Netherlands',ireland:'Ireland',luxembourg:'Luxembourg',malta:'Malta',estonia:'Estonia',
  uae:'UAE','united arab emirates':'UAE',dubai:'UAE','abu dhabi':'Abu Dhabi',
  saudi:'Saudi Arabia',qatar:'Qatar',oman:'Oman',bahrain:'Bahrain',
  india:'India',indian:'India',delhi:'India',mumbai:'India',bangalore:'India',
  singapore:'Singapore',sg:'Singapore','hong kong':'Hong Kong',
  thailand:'Thailand',vietnam:'Vietnam',philippines:'Philippines',
  indonesia:'Indonesia',malaysia:'Malaysia','sri lanka':'Sri Lanka',
  japan:'Japan','south korea':'South Korea',china:'China',taiwan:'Taiwan',
  australia:'Australia','new zealand':'New Zealand',
  'south africa':'South Africa',egypt:'Egypt',kenya:'Kenya',nigeria:'Nigeria',
};

const SERVICES_DICT = {
  incorporat:'Company Incorporation',register:'Company Incorporation',
  setup:'Company Incorporation','set up':'Company Incorporation',
  banking:'Banking Setup',bank:'Banking Setup',account:'Banking Setup',
  tax:'Tax Compliance',gst:'Tax Compliance',vat:'Tax Compliance',compliance:'Tax Compliance',
  fema:'FEMA/ODI Advisory',odi:'FEMA/ODI Advisory',remittance:'FEMA/ODI Advisory',
  residency:'Residency Solutions',visa:'Residency Solutions',immigration:'Residency Solutions',
};

function extractEntities(msg) {
  const entities = { email: null, country: null, service: null };
  const emailMatch = msg.match(EMAIL_RE);
  if (emailMatch) entities.email = emailMatch[0];
  const lower = msg.toLowerCase();
  for (const [kw, country] of Object.entries(COUNTRIES_DICT)) {
    if (lower.includes(kw)) { entities.country = country; break; }
  }
  for (const [kw, service] of Object.entries(SERVICES_DICT)) {
    if (lower.includes(kw)) { entities.service = service; break; }
  }
  return entities;
}

// ─────────────────────────────────────────────
// INTENT INTERPRETER
// ─────────────────────────────────────────────
function interpretUserInput(msg, menuState) {
  const trimmed = msg.trim();
  const lower   = trimmed.toLowerCase();

  // Pure number → menu select
  const numMatch = trimmed.match(/^(\d+)\.?$/);
  if (numMatch) {
    return { type: 'MENU_SELECT', menuNumber: parseInt(numMatch[1], 10) };
  }

  // "option N" / "choice N"
  const optMatch = lower.match(/(?:option|choice|number|#)\s*(\d+)/);
  if (optMatch) {
    return { type: 'MENU_SELECT', menuNumber: parseInt(optMatch[1], 10) };
  }

  // Ordinals
  const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, last: -1 };
  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (lower.includes(word)) {
      const maxOpts = menuState?.validOptions?.length || 4;
      const actual  = idx === -1 ? maxOpts : idx;
      return { type: 'MENU_SELECT', menuNumber: actual };
    }
  }

  // Corrections
  const CORRECTIONS = ['actually','wait','no wait','forget that','sorry','i meant','i mean','scratch that','never mind','go back'];
  if (CORRECTIONS.some(w => lower.includes(w))) {
    return { type: 'CORRECTION' };
  }

  // Yes / No
  if (/^(yes|yeah|yep|yup|sure|ok|okay|correct|right|absolutely|definitely)$/i.test(lower))
    return { type: 'YES_NO', yesNo: 'yes' };
  if (/^(no|nope|nah|not|false|never|none)$/i.test(lower))
    return { type: 'YES_NO', yesNo: 'no' };

  return { type: 'TEXT' };
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// ─────────────────────────────────────────────
const BASE_SYSTEM_PROMPT = `You are the Compliance Advisor for Comply Globally — a professional business expansion consultancy.

YOUR IDENTITY:
- You are a *Compliance Advisor*, not an "AI" or "chatbot" — never describe or introduce yourself that way
- You represent the Comply Globally expert team
- Warm, professional, knowledgeable — like talking to a senior consultant on WhatsApp

RETURNING USERS — CRITICAL:
- If the CUSTOMER PROFILE below has a name, this is a RETURNING user — do NOT re-introduce yourself
- Do NOT say "Hi there", "Welcome", or give an intro paragraph to returning users
- Do NOT list bullet points of what you can help with — just respond to what they said
- If they say "hello" or "hi", just greet them by name and ask what they need today
- Example: "Hey Udhay! 👋 What can I help you with today?"

RESPONSE RULES:
- Keep answers under 250 words (brevity = speed)
- Use *bold* for key terms, line breaks for readability
- Always end with a clear next step or question
- Use "we"/"our team" where appropriate
- ⛔ ABSOLUTELY FORBIDDEN: do NOT write "Quick topics:", "Quick reply:", or any numbered list of options
- ⛔ ABSOLUTELY FORBIDDEN: do NOT end with 1️⃣ 2️⃣ 3️⃣ 4️⃣ emoji-number lines — the system adds these automatically
- ⛔ ABSOLUTELY FORBIDDEN: do NOT introduce yourself, list your capabilities, or give a welcome speech to returning users

LEAD COLLECTION (natural, non-invasive):
Collect: full name, email, current country, target jurisdiction, service needed, business stage, timeline.
NEVER ask for info already known from the profile below.

MENU HANDLING:
- When the user sends a number (1, 2, 3, 4), you WILL be told exactly which option they selected in the [MENU SELECTION] tag
- Answer that topic thoroughly — do not ask "what did you mean by 2?"

KNOWLEDGE BASE:
- Cite specific facts from the injected KB section
- For custom quotes: direct to sales@complyglobally.com or +91 99999 81613
`;

function buildSystemPrompt(session, activeState, menuState) {
  const lead = session.leadData || {};
  const isReturning = !!(lead.name || lead.targetCountry || lead.currentCountry);

  const leadSummary = [
    lead.name          ? `Name: ${lead.name}`                : null,
    lead.email         ? `Email: ${lead.email}`              : null,
    lead.companyName   ? `Company: ${lead.companyName}`      : null,
    lead.currentCountry? `Based in: ${lead.currentCountry}`  : null,
    lead.targetCountry ? `Target: ${lead.targetCountry}`     : null,
    lead.serviceNeeded ? `Service: ${lead.serviceNeeded}`    : null,
    lead.businessStage ? `Stage: ${lead.businessStage}`      : null,
    lead.timeline      ? `Timeline: ${lead.timeline}`        : null,
  ].filter(Boolean).join(' | ');

  let prompt = BASE_SYSTEM_PROMPT;

  if (isReturning) {
    prompt += `\n\n[USER STATUS: RETURNING USER — do NOT re-introduce yourself or list your capabilities. Greet by name if they say hi, then ask what they need.]`;
  } else {
    prompt += `\n\n[USER STATUS: NEW USER — ask for their name and which country they want to expand into.]`;
  }

  if (leadSummary) {
    prompt += `\n\n[CUSTOMER PROFILE — ALREADY KNOWN (do NOT ask again):\n${leadSummary}]`;
  }

  if (menuState?.validOptions?.length > 0) {
    const optList = menuState.validOptions.map((o, i) => `${i + 1}. ${o}`).join('\n');
    prompt += `\n\n[LAST QUICK-REPLY MENU SHOWN TO USER:\n${optList}\nIf user sends a number 1-${menuState.validOptions.length}, treat it as selecting the matching option above.]`;
  }

  if (activeState?.currentFlow) {
    prompt += `\n\n[FLOW: ${activeState.currentFlow} | Stage: ${activeState.conversationStage}]`;
  }

  return prompt;
}

// ─────────────────────────────────────────────
// CLAUDE API CALLER
// ⚡ SPEED: max_tokens=350, last 10 turns only, single KB chunk
// ─────────────────────────────────────────────
async function getClaudeReply(systemPrompt, messages, userMessage) {
  // ⚡ Only last 10 turns to reduce payload size
  const trimmedHistory = messages.slice(-10);

  // ⚡ Only inject 1 KB chunk (most relevant)
  const relevantKB = retrieveRelevantKB(userMessage, 1);
  if (relevantKB && !relevantKB.includes('PASTE_YOUR_KNOWLEDGE_BASE_HERE')) {
    systemPrompt += `\n\n[RELEVANT KNOWLEDGE BASE:\n${relevantKB}]`;
  }

  const payload = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 350,   // ⚡ Reduced from 600 — faster responses
    system:     systemPrompt,
    messages:   trimmedHistory,
  };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('❌  Claude error:', data);
      return 'I apologize for the technical difficulty. Please try again or contact sales@complyglobally.com.';
    }

    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
      || 'I was unable to generate a response. Please try again.';

  } catch (err) {
    console.error('❌  Claude request failed:', err.message);
    return 'I am experiencing connectivity issues. Please try again shortly.';
  }
}

// ─────────────────────────────────────────────
// WHATSAPP SENDER
// ─────────────────────────────────────────────
function parsePhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (/^91[6-9]\d{9}$/.test(d))   return { countryCode: '+91',  phoneNumber: d.slice(2) };
  if (/^1[2-9]\d{9}$/.test(d))    return { countryCode: '+1',   phoneNumber: d.slice(1) };
  if (/^971\d{9}$/.test(d))        return { countryCode: '+971', phoneNumber: d.slice(3) };
  if (/^44[1-9]\d{8,9}$/.test(d)) return { countryCode: '+44',  phoneNumber: d.slice(2) };
  if (/^[6-9]\d{9}$/.test(d))     return { countryCode: '+91',  phoneNumber: d };
  console.warn(`⚠️  Unknown phone format: ${raw}`);
  return { countryCode: '+91', phoneNumber: d };
}

async function sendWhatsApp(phone, text) {
  console.log(`📤  [${phone}] ${text.substring(0, 80)}…`);
  if (!INTERAKT_API_KEY) { console.warn('⚠️  INTERAKT_API_KEY missing'); return; }
  const { countryCode, phoneNumber } = parsePhone(phone);
  try {
    await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: `Basic ${INTERAKT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode, phoneNumber, type: 'Text', data: { message: text } }),
    });
    console.log('✅  Sent');
  } catch (err) {
    console.error('❌  Send error:', err.message);
  }
}

// ─────────────────────────────────────────────
// HUMAN HANDOFF
// ─────────────────────────────────────────────
function wantsHuman(msg) {
  return ['human','agent','person','representative','speak to','talk to','connect me','call'].some(t => msg.toLowerCase().includes(t));
}

async function sendHandoffEmail(phone, leadData, history, additionalInfo) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) return;

  const displayPhone = phone.startsWith('91') ? `+${phone}` : `+${phone}`;
  const val = (v) => v || '<span style="color:#999">—</span>';

  // Last 8 turns of conversation, nicely formatted
  const chatRows = history.slice(-8).map(m => {
    const isBot = m.role === 'assistant';
    // Strip internal system tags from display
    const content = m.content
      .replace(/\[MENU SELECTION:.*?\]/g, '')
      .replace(/\[CUSTOMER PROFILE.*?\]/gs, '')
      .replace(/GREETING_RECEIVED/g, '(opened chat)')
      .trim();
    return `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;vertical-align:top;width:32px">
          <span style="font-size:18px">${isBot ? '🤖' : '👤'}</span>
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333;line-height:1.6">
          <strong style="color:${isBot ? '#6C47FF' : '#1a1a1a'}">${isBot ? 'Advisor' : 'Customer'}:</strong><br>
          ${content.replace(/\n/g, '<br>')}
        </td>
      </tr>`;
  }).join('');

  const resumeUrl = `${BASE_URL}/admin/resume?phone=${phone}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#6C47FF 0%,#4f35c2 100%);padding:28px 32px;text-align:center">
      <div style="font-size:32px;margin-bottom:8px">🌍</div>
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700">Comply Globally — Human Handoff Alert</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:13px">
        ⏱️ Bot is paused. It will auto-resume after 2 hours if no action is taken.
      </p>
    </div>

    <!-- Customer Profile -->
    <div style="padding:28px 32px">
      <h2 style="margin:0 0 16px;font-size:15px;font-weight:700;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.5px">
        Customer Profile
      </h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden">
        <tr style="background:#fafafa">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;width:38%;border-bottom:1px solid #e8e8e8">Name</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.name)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Email</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.email)}</td>
        </tr>
        <tr style="background:#fafafa">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Company</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.companyName)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Phone</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${displayPhone}</td>
        </tr>
        <tr style="background:#fafafa">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Based In</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.currentCountry)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Target Jurisdiction</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.targetCountry)}</td>
        </tr>
        <tr style="background:#fafafa">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Service Needed</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.serviceNeeded)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Business Stage</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.businessStage)}</td>
        </tr>
        <tr style="background:#fafafa">
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555;border-bottom:1px solid #e8e8e8">Timeline</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a;border-bottom:1px solid #e8e8e8">${val(leadData.timeline)}</td>
        </tr>
        <tr>
          <td style="padding:10px 16px;font-size:13px;font-weight:600;color:#555">Additional Info</td>
          <td style="padding:10px 16px;font-size:13px;color:#1a1a1a">${additionalInfo || '<span style="color:#999">None provided</span>'}</td>
        </tr>
      </table>
    </div>

    <!-- Recent Conversation -->
    <div style="padding:0 32px 28px">
      <h2 style="margin:0 0 16px;font-size:15px;font-weight:700;color:#1a1a1a;text-transform:uppercase;letter-spacing:0.5px">
        Recent Conversation
      </h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e8e8e8;border-radius:8px;overflow:hidden">
        ${chatRows}
      </table>
    </div>

    <!-- Action Buttons -->
    <div style="padding:0 32px 32px;display:flex;gap:12px">
      <a href="https://app.interakt.ai" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;margin-right:12px">
        Open Interakt →
      </a>
      <a href="${resumeUrl}" style="display:inline-block;background:#6C47FF;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600">
        ✅ Resume Bot for ${displayPhone}
      </a>
    </div>

    <!-- Footer -->
    <div style="background:#f9f9f9;border-top:1px solid #eee;padding:16px 32px;text-align:center">
      <p style="margin:0;font-size:12px;color:#999">
        Bot auto-resumes after 2h regardless. · Comply Globally · sales@complyglobally.com
      </p>
    </div>

  </div>
</body>
</html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [NOTIFY_EMAIL],
      subject: `🚨 Human Handoff Requested — ${leadData.name || displayPhone}`,
      html,
    }),
  });
}

// ─────────────────────────────────────────────
// LEAD FINALIZATION
// ─────────────────────────────────────────────
function isLeadComplete(lead) {
  return !!(lead.name && lead.currentCountry && lead.targetCountry && lead.serviceNeeded);
}

async function finalizeLead(session) {
  session.leadCollected = true;
  console.log(`🎯  Lead finalized: ${session.leadData.name}`);
  if (leadsCol) await leadsCol.insertOne({ ...session.leadData, completedAt: new Date() });
}

// ─────────────────────────────────────────────
// WEBHOOK — MAIN BOT LOGIC
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ⚡ Respond immediately before any async work

  try {
    const body = req.body;
    if (body.type !== 'message_received') return;

    const phone  = (body.data?.customer?.phone_number || '').replace(/\D/g, '');
    const rawMsg = (body.data?.message?.message || '').trim();
    if (!phone || !rawMsg) return;

    console.log(`\n📩  [${phone}] "${rawMsg}"`);

    // ⚡ Load all state in parallel
    const [session, activeState, menuState] = await Promise.all([
      getSession(phone),
      getActiveState(phone),
      getMenuState(phone),
    ]);

    // ── NEW USER GREETING ─────────────────────────────────────────
    // Hardcoded — does NOT go through Claude, does NOT get a footer.
    // Quick topics only appear after name + target country are known.
    if (session.history.length === 0) {
      const greeting =
        `Welcome to *Comply Globally!* 🌍\n\n` +
        `I'm your *Compliance Advisor* — here to help you expand your business internationally across 47+ jurisdictions.\n\n` +
        `I can help with company incorporation, banking setup, tax compliance, FEMA/ODI advisory, and residency solutions.\n\n` +
        `To get started — what's your *name*, and which *country are you looking to expand into*?`;

      await sendWhatsApp(phone, greeting);
      session.history.push({ role: 'user',      content: 'GREETING_RECEIVED' });
      session.history.push({ role: 'assistant', content: greeting });
      activeState.currentFlow       = 'ONBOARDING';
      activeState.conversationStage = 'NAME';
      menuState.validOptions = [];
      menuState.optionTopics = [];

      await Promise.all([saveSession(session), saveActiveState(activeState), saveMenuState(menuState)]);
      return;
    }

    // ── AUTO-RESUME FROM HUMAN MODE ───────────────────────────────
    if (activeState.humanModeActive) {
      const elapsed = Date.now() - new Date(activeState.humanModeSince || 0).getTime();
      if (elapsed >= HUMAN_TIMEOUT_MS) {
        activeState.humanModeActive = false;
        activeState.humanModeSince  = null;
        console.log(`⏰  Auto-resuming: ${phone}`);
      } else {
        console.log(`🧑  Human mode active — suppressed`);
        return;
      }
    }

    // ── INTERPRET INTENT ──────────────────────────────────────────
    const intent = interpretUserInput(rawMsg, menuState);
    console.log(`🧠  Intent: ${intent.type}`);

    // ── HANDLE MENU SELECTION ─────────────────────────────────────
    if (intent.type === 'MENU_SELECT') {
      const num     = intent.menuNumber;
      const maxOpts = menuState.validOptions.length;

      // Invalid selection (e.g. user sends 5 when only 4 options exist)
      if (!maxOpts || num < 1 || num > maxOpts) {
        const invalidMsg = maxOpts > 0
          ? `That's not a valid option. Please choose *1 to ${maxOpts}* from the menu above. 👆`
          : `I don't have an active menu right now. What would you like to know about?`;
        await sendWhatsApp(phone, invalidMsg);
        return;
      }

      // Valid selection — inject the chosen topic into the user message for Claude
      const chosenTopic = menuState.validOptions[num - 1];
      console.log(`✅  Menu selection: ${num} → "${chosenTopic}"`);

      const enrichedMsg = `[MENU SELECTION: User chose option ${num} — "${chosenTopic}". Answer this topic thoroughly.]`;

      session.history.push({ role: 'user', content: enrichedMsg });
      const sysPrompt = buildSystemPrompt(session, activeState, menuState);
      const rawReply  = await getClaudeReply(sysPrompt, session.history, chosenTopic);

      // If user is selecting from a menu they already have name+target (menus only show after that)
      // so always show topics on menu replies
      const bank = detectTopicBank(session, chosenTopic);
      const { footer, options } = buildQuickReplyFooter(bank);
      const finalReply = stripClaudeGeneratedFooter(rawReply) + footer;

      await sendWhatsApp(phone, finalReply);
      session.history.push({ role: 'assistant', content: finalReply });

      menuState.validOptions = options;
      menuState.optionTopics = options;
      menuState.menuShownAt  = new Date();

      // ⚡ Parallel saves
      await Promise.all([saveSession(session), saveActiveState(activeState), saveMenuState(menuState)]);
      return;
    }

    // ── HUMAN HANDOFF — 2-STEP FLOW ──────────────────────────────
    // Step 1: User asks for human → bot asks for any additional info
    // Step 2: User replies (or says no) → bot confirms + sends email + pauses
    //
    // activeState.handoffStage tracks:
    //   undefined / null  = not in handoff flow
    //   'ASKED_ADDL_INFO' = we asked for extra info, waiting for reply
    // ─────────────────────────────────────────────────────────────

    // Step 2 — user just replied to our "any additional info?" question
    if (activeState.handoffStage === 'ASKED_ADDL_INFO') {
      const lower = rawMsg.toLowerCase().trim();
      const additionalInfo = /^(no|nope|nah|none|skip|nothing|not really)$/i.test(lower)
        ? null
        : rawMsg;

      const name = session.leadData.name || 'there';
      const confirmMsg = `Thank you${name !== 'there' ? `, ${name}` : ''}. One of our senior advisors will be in touch with you shortly. 🤝\n\n` +
        `In the meantime you can reach us at:\n📧 sales@complyglobally.com\n📞 +1 (302) 214-1717 | +91 99999 81613`;

      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: confirmMsg });

      // Now actually pause the bot and send the email
      activeState.handoffStage    = null;
      activeState.handoffPending  = true;
      activeState.humanModeActive = true;
      activeState.humanModeSince  = new Date();

      await Promise.all([
        sendWhatsApp(phone, confirmMsg),
        sendHandoffEmail(phone, session.leadData, session.history, additionalInfo),
      ]);

      if (!session.leadCollected) await finalizeLead(session);
      await Promise.all([saveSession(session), saveActiveState(activeState)]);
      return;
    }

    // Step 1 — user just requested a human for the first time
    if (wantsHuman(rawMsg) && !activeState.handoffPending) {
      console.log(`🙋  Human requested — asking for additional info`);
      activeState.handoffStage = 'ASKED_ADDL_INFO';

      const name = session.leadData.name || '';
      const askMsg = `Sure${name ? `, ${name}` : ''}! I'm connecting you with one of our senior advisors right now. 🤝\n\n` +
        `Before I do — is there any specific detail, question, or context you'd like to pass on to the advisor?\n\n` +
        `_(Reply with your message, or just say *"No"* to connect right away)_`;

      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: askMsg });

      await sendWhatsApp(phone, askMsg);
      await Promise.all([saveSession(session), saveActiveState(activeState)]);
      return;
    }

    // ── EXTRACT ENTITIES & UPDATE LEAD ────────────────────────────
    const entities = extractEntities(rawMsg);
    if (entities.email)   session.leadData.email = entities.email;
    if (entities.country) {
      if (/expand|move|setup|incorporate|register/.test(rawMsg.toLowerCase())) {
        session.leadData.targetCountry = entities.country;
      } else {
        session.leadData.currentCountry = entities.country;
      }
    }
    if (entities.service) session.leadData.serviceNeeded = entities.service;

    // ── NAME EXTRACTION — tight rules, runs ONCE, then stage advances ──
    // Only attempt when:
    //   1. We are still in NAME stage (bot just asked "what's your name?")
    //   2. No name is saved yet
    //   3. The message is SHORT (≤6 words) — real name answers are short
    //   4. The message doesn't look like a question or sentence
    if (
      activeState.conversationStage === 'NAME' &&
      !session.leadData.name
    ) {
      const wordCount = rawMsg.trim().split(/\s+/).length;
      const looksLikeName =
        wordCount <= 4 &&                          // names are short
        !/[?!]/.test(rawMsg) &&                    // not a question
        !/\b(tell|about|expand|how|what|where|when|why|want|would|looking|help|can|i am|my name is)\b/i.test(rawMsg) && // not a sentence
        /^[A-Za-z]/.test(rawMsg.trim());           // starts with a letter

      if (looksLikeName) {
        // Extract just the first 1-3 words as the name candidate
        const candidate = rawMsg.trim().split(/\s+/).slice(0, 3).join(' ');
        if (isValidName(candidate)) {
          session.leadData.name = candidate;
          console.log(`✅  Name saved: "${candidate}"`);
        }
      }

      // Always advance past NAME stage after first user reply
      // so we NEVER run name extraction on a second message
      activeState.conversationStage = 'QA';
      console.log(`📍  Stage → QA`);
    }

    // ── NORMAL CLAUDE REPLY ───────────────────────────────────────
    session.history.push({ role: 'user', content: rawMsg });
    const sysPrompt = buildSystemPrompt(session, activeState, menuState);
    const rawReply  = await getClaudeReply(sysPrompt, session.history, rawMsg);
    const cleanReply = stripClaudeGeneratedFooter(rawReply);

    // Quick topics only make sense once we know WHO the user is and WHERE they want to go.
    // Before that, the options are meaningless — show nothing.
    const hasName    = !!(session.leadData.name);
    const hasTarget  = !!(session.leadData.targetCountry || session.leadData.currentCountry);
    const showTopics = hasName && hasTarget;

    let finalReply;
    if (showTopics) {
      const bank = detectTopicBank(session, rawMsg);
      const { footer, options } = buildQuickReplyFooter(bank);
      finalReply = cleanReply + footer;
      menuState.validOptions = options;
      menuState.optionTopics = options;
      menuState.menuShownAt  = new Date();
    } else {
      // No footer yet — still collecting name / country
      finalReply = cleanReply;
      menuState.validOptions = [];
      menuState.optionTopics = [];
    }

    await sendWhatsApp(phone, finalReply);
    session.history.push({ role: 'assistant', content: finalReply });

    // menuState already updated correctly inside the if/else above — do NOT overwrite here

    // Lead completion check
    if (!session.leadCollected && isLeadComplete(session.leadData)) {
      await finalizeLead(session);
    }

    activeState.lastInteractionAt = new Date();
    activeState.messageCount++;

    // ⚡ Parallel saves
    await Promise.all([saveSession(session), saveActiveState(activeState), saveMenuState(menuState)]);
    await logInteraction(phone, 'QA', { intent: intent.type });

  } catch (err) {
    console.error('❌  Webhook error:', err.message, err.stack);
  }
});

// ─────────────────────────────────────────────
// ANALYTICS LOGGER
// ─────────────────────────────────────────────
async function logInteraction(phone, type, data = {}) {
  if (!analyticsCol) return;
  analyticsCol.insertOne({ phone, type, data, ts: new Date() }).catch(() => {});
}

// ─────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// CRM COMPATIBILITY ENDPOINTS
// The CRM dashboard pings these to show "connected" status.
// Multiple URL patterns covered since the CRM may use any of them.
// ─────────────────────────────────────────────

// Status / ping — CRM checks this to show "WhatsApp backend ✓"
app.get('/api/status',    (req, res) => res.json({ status: 'ok', service: 'whatsapp-bot', ts: new Date() }));
app.get('/api/ping',      (req, res) => res.json({ status: 'ok', ts: new Date() }));
app.get('/status',        (req, res) => res.json({ status: 'ok', service: 'whatsapp-bot', ts: new Date() }));
app.get('/ping',          (req, res) => res.json({ ok: true }));
app.get('/whatsapp/ping', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// Leads endpoints — alias under /api/ and /crm/ in case the CRM uses those paths
app.get('/api/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  const leads = await leadsCol.find({}).sort({ completedAt: -1 }).limit(200).toArray();
  // Normalise field names to match what the CRM expects
  const normalised = leads.map(l => ({
    ...l,
    source: l.source || 'whatsapp',
    name:   l.name   || l.leadData?.name,
    phone:  l.phone  || l.leadData?.phone,
    email:  l.email  || l.leadData?.email,
    currentCountry:  l.currentCountry  || l.leadData?.currentCountry,
    targetCountry:   l.targetCountry   || l.leadData?.targetCountry,
    serviceNeeded:   l.serviceNeeded   || l.leadData?.serviceNeeded,
    businessStage:   l.businessStage   || l.leadData?.businessStage,
    timeline:        l.timeline        || l.leadData?.timeline,
  }));
  res.json(normalised);
});

app.get('/crm/leads',      async (req, res) => { req.url = '/api/leads'; app.handle(req, res); });
app.get('/whatsapp/leads', async (req, res) => { req.url = '/api/leads'; app.handle(req, res); });

// Delete a lead — CRM "Reset CRM" or per-row delete button
app.delete('/api/leads/:id', async (req, res) => {
  if (!leadsCol) return res.json({ ok: false, error: 'no db' });
  try {
    const { ObjectId } = require('mongodb');
    await leadsCol.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/admin/leads/all', async (req, res) => {
  if (!leadsCol) return res.json({ ok: false });
  await leadsCol.deleteMany({});
  res.json({ ok: true, deleted: true });
});

// Clear a bad saved name for a phone number (use when bot saved garbage)
// GET /admin/fix-name?phone=918448227988&name=Udhay
// GET /admin/fix-name?phone=918448227988        (just clears the name)
app.get('/admin/fix-name', async (req, res) => {
  const phone   = (req.query.phone || '').replace(/\D/g, '');
  const newName = (req.query.name  || '').trim();
  if (!phone) return res.status(400).send('Missing phone');

  try {
    const session = await getSession(phone);
    const oldName = session.leadData.name || '(none)';
    session.leadData.name = newName || null;

    // Also reset conversationStage so bot doesn't re-ask name
    const activeState = await getActiveState(phone);
    if (activeState.conversationStage === 'NAME') {
      activeState.conversationStage = 'QA';
    }

    await Promise.all([saveSession(session), saveActiveState(activeState)]);

    // Clear cache so next message picks up the fix immediately
    sessionCache.delete(phone);
    activeStateCache.delete(phone);

    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:500px">
      <h2>✅ Name fixed for +${phone}</h2>
      <p><b>Was:</b> ${oldName}</p>
      <p><b>Now:</b> ${newName || '(cleared — bot will re-ask)'}</p>
      <p style="color:#666;font-size:13px">Cache cleared. Next message from this user will use the updated name.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// Full session reset for a phone (fresh start, keeps nothing)
app.get('/admin/reset-session', async (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).send('Missing phone');

  try {
    if (sessionsCol)    await sessionsCol.deleteOne({ phone });
    if (activeStateCol) await activeStateCol.deleteOne({ phone });
    if (menuStateCol)   await menuStateCol.deleteOne({ phone });
    sessionCache.delete(phone);
    activeStateCache.delete(phone);
    menuStateCache.delete(phone);

    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px">
      <h2>✅ Session fully reset for +${phone}</h2>
      <p>Next message from this user will get a fresh greeting.</p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/admin/leads', async (req, res) => {
  if (!leadsCol) return res.json([]);
  const leads = await leadsCol.find({}).sort({ completedAt: -1 }).limit(100).toArray();
  res.json(leads);
});

app.get('/admin/sessions', async (req, res) => {
  if (!sessionsCol) return res.json([]);
  const sessions = await sessionsCol
    .find({}, { projection: { phone: 1, leadData: 1, leadCollected: 1, lastActive: 1 } })
    .sort({ lastActive: -1 }).limit(50).toArray();
  res.json(sessions);
});

// Resume bot manually — linked from the handoff email button
app.get('/admin/resume', async (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '');
  if (!phone) return res.status(400).send('Missing phone parameter');

  try {
    const activeState = await getActiveState(phone);
    activeState.humanModeActive = false;
    activeState.humanModeSince  = null;
    activeState.handoffPending  = false;
    activeState.handoffStage    = null;
    await saveActiveState(activeState);

    console.log(`✅  Bot manually resumed for ${phone}`);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ Bot resumed for +${phone}</h2>
      <p>The bot will now respond to messages from this customer again.</p>
    </body></html>`);
  } catch (err) {
    console.error('Resume error:', err);
    res.status(500).send('Error resuming bot: ' + err.message);
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    caches: {
      sessions:     sessionCache.size,
      activeStates: activeStateCache.size,
      menus:        menuStateCache.size,
      kbChunks:     kbChunkCache.size,
    },
  });
});

app.get('/', (req, res) => {
  res.send('<h1>Comply Globally — WhatsApp Bot v3</h1><p>Webhook ready.</p>');
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  Server running on port ${PORT}`);
    console.log(`📡  POST /webhook`);
    console.log(`📊  GET  /admin/leads`);
    console.log(`📊  GET  /admin/sessions`);
    console.log(`🔁  GET  /admin/resume?phone=XXXX`);
    console.log(`❤️   GET  /health\n`);
  });
});
