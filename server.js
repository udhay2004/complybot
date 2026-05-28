'use strict';

/**
 * ============================================================
 *  COMPLY GLOBALLY — WhatsApp AI Chatbot Backend
 *  PRODUCTION EDITION v4.0
 *  Token-Efficient | Menu-Deterministic | Rate-Limit-Safe
 * ============================================================
 */

const express         = require('express');
const path            = require('path');
const fetch           = require('node-fetch');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
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
const INTERAKT_API_KEY  = (process.env.INTERAKT_API_KEY  || '').replace(/['"` \n\r]/g, '');
const ANTHROPIC_API_KEY = (process.env.ANTHROPIC_API_KEY || '').replace(/['"` \n\r]/g, '');
const MONGODB_URI       = process.env.MONGODB_URI        || '';
const RESEND_API_KEY    = (process.env.RESEND_API_KEY    || '').replace(/['"` \n\r]/g, '');
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL       || 'udhaymarwah96@gmail.com';
const FROM_EMAIL        = process.env.FROM_EMAIL         || 'onboarding@resend.dev';
const HUMAN_TIMEOUT_MS  = parseInt(process.env.HUMAN_TIMEOUT_MS || '7200000', 10);

[['INTERAKT_API_KEY', INTERAKT_API_KEY], ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY], ['MONGODB_URI', MONGODB_URI]]
  .forEach(([k, v]) => v ? console.log(`✅  ENV loaded:  ${k}`) : console.error(`❌  ENV MISSING: ${k}`));

// ─────────────────────────────────────────────
// KNOWLEDGE BASE — SELECTIVE RETRIEVAL
//
// ⚠️  DO NOT embed KNOWLEDGE_BASE in ADVISOR_SYSTEM_PROMPT.
//     It is injected per-request only for the relevant jurisdiction(s).
//     This is the #1 fix for rate limit / token overuse.
//
// HOW TO ADD YOUR KNOWLEDGE BASE:
//   1. Keep each jurisdiction as a separate string in KB_SECTIONS below.
//   2. Each key maps to a lowercase keyword array used for routing.
//   3. The router (selectKBSections) picks only the relevant 1-2 sections
//      per request — never the whole thing at once.
//
// EXAMPLE STRUCTURE (paste your content in each string):
//
// const KB_SECTIONS = {
//   usa: {
//     keywords: ['usa','united states','america','delaware','wyoming','llc','c-corp'],
//     content: `...your USA knowledge base text...`
//   },
//   fema: {
//     keywords: ['fema','odi','rbi','apr','fla','form oi','lrs','outward remittance'],
//     content: `...your FEMA/ODI knowledge base text...`
//   },
//   // ... etc
// };
// ─────────────────────────────────────────────

const KB_SECTIONS = {
  usa: {
    keywords: ['usa','united states','america','delaware','wyoming','nevada','florida','texas','new mexico','llc','c-corp','s-corp','form 5472','ein','fincen','boi','mercury','relay'],
    content: `[PASTE USA KNOWLEDGE BASE HERE]`
  },
  fema: {
    keywords: ['fema','odi','rbi','apr','fla return','form oi','lrs','outward remittance','round-trip','flip','uin','ad bank','authorised dealer','compounding','lsf'],
    content: `[PASTE FEMA/ODI KNOWLEDGE BASE HERE]`
  },
  canada: {
    keywords: ['canada','toronto','vancouver','calgary','ontario','cra','gst','hst','cbca','obca','cusma','cptpp','ceta','pei','asc'],
    content: `[PASTE CANADA KNOWLEDGE BASE HERE]`
  },
  uk: {
    keywords: ['uk','united kingdom','britain','england','companies house','hmrc','vat','ltd','paye','corporation tax','visa uk','skilled worker','innovator','eccta'],
    content: `[PASTE UK KNOWLEDGE BASE HERE]`
  },
  singapore: {
    keywords: ['singapore','pte ltd','acra','iras','gst singapore','cpf','ep','employment pass','entrepass','mom','one pass','pdpa','siac'],
    content: `[PASTE SINGAPORE KNOWLEDGE BASE HERE]`
  },
  uae: {
    keywords: ['uae','dubai','abu dhabi','sharjah','dmcc','jafza','difc','adgm','freezone','free zone','mainland','trade licence','emara','corporate tax uae','vat uae','golden visa','green visa'],
    content: `[PASTE UAE KNOWLEDGE BASE HERE]`
  },
  philippines: {
    keywords: ['philippines','manila','cebu','sec philippines','bir','peza','boi philippines','create act','ith','scit','sss','philhealth','pag-ibig','9g visa'],
    content: `[PASTE PHILIPPINES KNOWLEDGE BASE HERE]`
  },
  thailand: {
    keywords: ['thailand','bangkok','eec','boi thailand','dbd','fba','foreign business act','vat thailand','cit thailand','work permit thailand','smart visa','ltr visa','dbiz regist'],
    content: `[PASTE THAILAND KNOWLEDGE BASE HERE]`
  },
  estonia: {
    keywords: ['estonia','tallinn','e-residency','eresidency','ou','oü','osauhing','e-resident','xolo','1office','enty','eu company','sepa','eu vat oss'],
    content: `[PASTE ESTONIA KNOWLEDGE BASE HERE]`
  },
  italy: {
    keywords: ['italy','milan','rome','srl','spa','agenzia delle entrate','ires','irap','registro imprese','inps','ccnl','golden power italy','startup visa italy'],
    content: `[PASTE ITALY KNOWLEDGE BASE HERE]`
  },
  vietnam: {
    keywords: ['vietnam','ho chi minh','hanoi','llc vietnam','firc','vat vietnam','cit vietnam','work permit vietnam','pdp vietnam','binh duong','dong nai','bac ninh'],
    content: `[PASTE VIETNAM KNOWLEDGE BASE HERE]`
  },
  indonesia: {
    keywords: ['indonesia','jakarta','bali','batam','pt pma','kbli','oss','rba','coretax','npwp','vat indonesia','cit indonesia','bpjs','rptka','itas','dhi','dhie'],
    content: `[PASTE INDONESIA KNOWLEDGE BASE HERE]`
  },
  general: {
    keywords: ['document','passport','aadhar','pan card','business plan','required','checklist','contact','pricing','quote','fee','cost'],
    content: `[PASTE DOCUMENTS REQUIRED + CONTACT & PRICING SECTION HERE]`
  },
};

/**
 * Selects the 1–2 most relevant KB sections for a given user message.
 * Returns a compact string to inject into the system prompt.
 * If no match: returns empty string (no KB injected — keeps tokens low).
 */
function selectKBSections(userMessage) {
  const lower = userMessage.toLowerCase();
  const scored = [];

  for (const [key, section] of Object.entries(KB_SECTIONS)) {
    let score = 0;
    for (const kw of section.keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > 0) scored.push({ key, score, content: section.content });
  }

  // Sort by relevance, take top 2
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 2);

  if (top.length === 0) return '';

  return '\n\n[KNOWLEDGE BASE — RELEVANT SECTIONS]\n' +
    top.map(s => s.content).join('\n\n---\n\n');
}

// ─────────────────────────────────────────────
// ADVISOR SYSTEM PROMPT — STATIC BASE
// Compact. No KB here. KB injected per-request selectively.
// ─────────────────────────────────────────────
const ADVISOR_SYSTEM_PROMPT = `You are a premium international business expansion advisor for Comply Globally. You help founders expand globally — covering incorporation, banking, tax, compliance, residency, and FEMA/ODI for Indian clients across 47+ jurisdictions.

PERSONALITY:
- Warm, sharp, consultative — like a trusted advisor, not a bot
- Use the person's name naturally when you have it
- Never robotic. Vary sentence structures. Sound like a real expert.
- Never say "Great question!", "Certainly!", "Of course!", "How can I help today?"

ONBOARDING FLOW:
- First message: greet warmly, introduce yourself briefly, ask their name
- Second message (after name): ask which market they're exploring
- After name + market: switch fully to advisory mode. Never re-ask known info.
- NEVER ask name and country in the same message.

ADVISORY RESPONSES:
- Answer substantively from the knowledge base sections provided below
- After any substantive advisory answer (NOT during greetings, small talk, or handoff), end with EXACTLY this format:

Want to explore further?
1️⃣ [relevant follow-up question]
2️⃣ [relevant follow-up question]
3️⃣ [relevant follow-up question]
4️⃣ [relevant follow-up question]

- Always generate all 4 options when you include this block. Never fewer.
- NEVER include this block during: greeting messages, casual chitchat, handoff conversations.

MENU SELECTION:
- If the context shows [ACTIVE MENU] with 4 stored options, and the user selects a number 1-4, answer that exact question fully.
- If user gives a number outside 1-4, reply: "I had options 1 to 4 there — did you mean one of those? Or feel free to ask directly!"

HUMAN HANDOFF:
- ONLY trigger when user explicitly says: human / agent / speak to someone / connect me / call / your team
- When triggered, respond EXACTLY:
  "Of course! I'll connect you with our specialist team right away. 😊
  
  📞 Direct contact:
  • Email: sales@complyglobally.com
  • Phone: +1 (302) 214-1717 | +91 99999 81613
  
  Is there any additional context you'd like to share before they reach out?"
- After their reply (any), confirm: "Perfect — they'll be in touch shortly! 🙌"
- NO menus. NO follow-up questions during handoff.

RULES:
- Never push contact info unless user requests it or is ready for next steps
- Never invent facts not in the knowledge base
- Never guess names from regular sentences — only accept explicit introductions`;

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
let sessionsCol, activeStateCol, memoryCol;

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️  No MONGODB_URI — memory-only mode'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const db    = client.db('complybot');
    sessionsCol    = db.collection('sessions');
    activeStateCol = db.collection('activeStates');
    memoryCol      = db.collection('memory');
    await Promise.all([
      sessionsCol.createIndex({ phone: 1 }, { unique: true }),
      activeStateCol.createIndex({ phone: 1 }, { unique: true }),
      memoryCol.createIndex({ phone: 1 }, { unique: true }),
    ]);
    console.log('✅  MongoDB connected');
  } catch (err) {
    console.error('❌  MongoDB failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// CACHE — 30-min TTL in-memory layer
// ─────────────────────────────────────────────
const CACHE_TTL = 30 * 60 * 1000;
const _cache = { session: new Map(), state: new Map(), memory: new Map() };

function cSet(store, key, val) { _cache[store].set(key, { val, ts: Date.now() }); }
function cGet(store, key) {
  const e = _cache[store].get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { _cache[store].delete(key); return null; }
  return e.val;
}

// ─────────────────────────────────────────────
// SESSION — history (capped at 16 messages)
// ─────────────────────────────────────────────
function newSession(phone) {
  return { phone, history: [], createdAt: new Date(), lastActive: new Date() };
}
async function getSession(phone) {
  const c = cGet('session', phone);
  if (c) return c;
  let s = sessionsCol ? await sessionsCol.findOne({ phone }) : null;
  if (!s) s = newSession(phone);
  s.history = s.history || [];
  cSet('session', phone, s);
  return s;
}
async function saveSession(s) {
  s.lastActive = new Date();
  if (s.history.length > 16) s.history = s.history.slice(-16); // hard cap
  cSet('session', s.phone, s);
  if (sessionsCol) { const { _id, ...doc } = s; await sessionsCol.replaceOne({ phone: s.phone }, doc, { upsert: true }); }
}

// ─────────────────────────────────────────────
// ACTIVE STATE — conversation flow + deterministic menu engine
// ─────────────────────────────────────────────
function newState(phone) {
  return {
    phone,
    phase: 'new',           // new | onboarding | advisory | escalating | human_mode
    topicsDiscussed: [],
    // ── DETERMINISTIC MENU ENGINE ──────────────────────────────────
    // lastMenu is the ONLY source of truth for active menu options.
    // It is set deterministically by parseMenuFromReply() — never by LLM memory.
    // It persists until: user selects a valid option, topic changes clearly, or new menu replaces it.
    lastMenu: null,         // { id, options: string[4], context: string, createdAt: number }
    // ────────────────────────────────────────────────────────────────
    humanMode: false,
    humanModeAt: null,
    pendingHandoff: false,
    handoffEmailSent: false,
    lastActive: new Date(),
  };
}
async function getState(phone) {
  const c = cGet('state', phone);
  if (c) return c;
  let s = activeStateCol ? await activeStateCol.findOne({ phone }) : null;
  if (!s) s = newState(phone);
  s.topicsDiscussed = s.topicsDiscussed || [];
  cSet('state', phone, s);
  return s;
}
async function saveState(s) {
  s.lastActive = new Date();
  cSet('state', s.phone, s);
  if (activeStateCol) { const { _id, ...doc } = s; await activeStateCol.replaceOne({ phone: s.phone }, doc, { upsert: true }); }
}

// ─────────────────────────────────────────────
// MEMORY — locked validated entities
// ─────────────────────────────────────────────
function newMemory(phone) {
  return { phone, name: null, targetCountry: null, currentCountry: null, serviceNeeded: null, email: null, updatedAt: new Date() };
}
async function getMemory(phone) {
  const c = cGet('memory', phone);
  if (c) return c;
  let m = memoryCol ? await memoryCol.findOne({ phone }) : null;
  if (!m) m = newMemory(phone);
  cSet('memory', phone, m);
  return m;
}
async function saveMemory(m) {
  m.updatedAt = new Date();
  cSet('memory', m.phone, m);
  if (memoryCol) { const { _id, ...doc } = m; await memoryCol.replaceOne({ phone: m.phone }, doc, { upsert: true }); }
}

// ─────────────────────────────────────────────
// NAME EXTRACTION — strict, production-grade
// Only fires on explicit introduction patterns. Never guesses.
// ─────────────────────────────────────────────
const NAME_BLACKLIST = new Set([
  'hi','hello','hey','okay','ok','yes','no','sure','thanks','thank','please',
  'tell','about','how','what','where','when','why','which','who','can','could',
  'would','should','need','want','like','just','also','even','still','now',
  'india','usa','uae','uk','singapore','canada','dubai','delhi','mumbai','bangalore','hyderabad','chennai','pune','kolkata',
  'expanding','expand','incorporate','incorporating','business','company','startup','venture',
  'help','advice','information','details','guide','looking','trying','planning','exploring',
  'more','some','any','all','this','that','these','those','with','from','into','for','the','and','but',
  'not','are','is','was','will','been','have','get','got','we','us','my','me',
  'good','great','fine','well','very','quite','really','actually',
  'comply','globally','setup','setting','service','services','incorporation','registration',
  'taxation','banking','fema','odi','compliance','question','options','option',
]);

const NAME_INTRO_RE = /(?:my name is|i am|i'm|this is|call me|you can call me|they call me)\s+([A-Za-z][a-zA-Z'\-]{1,30}(?:\s+[A-Za-z][a-zA-Z'\-]{1,30}){0,2})/i;
const NAME_STANDALONE_RE = /^([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20}){0,2})\s*(?:here|speaking|this side)?[.!]?\s*$/;

function extractName(msg) {
  const t = msg.trim();
  if (t.length > 80) return null;
  if (t.includes('?')) return null;
  const lower = t.toLowerCase();
  // Reject if message contains business/query keywords
  if (/tell me|about|how|what|expand|incorporat|setup|looking|need|want|tax|bank|fema|odi|visa|compli|register|market|country|jurisdict/.test(lower)) return null;

  // Try explicit introduction pattern first
  const intro = t.match(NAME_INTRO_RE);
  if (intro) {
    const candidate = intro[1].trim();
    const words = candidate.split(/\s+/);
    if (words.length <= 3 && words.every(w => w.length >= 2 && !NAME_BLACKLIST.has(w.toLowerCase()) && /^[A-Za-z'\-]+$/.test(w))) {
      return candidate;
    }
  }

  // Try standalone name (short message that looks like just a name)
  const standalone = t.match(NAME_STANDALONE_RE);
  if (standalone) {
    const candidate = standalone[1].trim();
    const words = candidate.split(/\s+/);
    if (words.length >= 1 && words.length <= 3 && words.every(w => w.length >= 2 && !NAME_BLACKLIST.has(w.toLowerCase()) && /^[A-Za-z'\-]+$/.test(w))) {
      return candidate;
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// ENTITY EXTRACTION — country, service, email
// ─────────────────────────────────────────────
const COUNTRY_MAP = {
  'uae': 'UAE', 'dubai': 'UAE', 'abu dhabi': 'UAE', 'sharjah': 'UAE',
  'usa': 'USA', 'united states': 'USA', 'america': 'USA',
  'uk': 'UK', 'united kingdom': 'UK', 'britain': 'UK', 'england': 'UK',
  'singapore': 'Singapore',
  'india': 'India',
  'canada': 'Canada',
  'australia': 'Australia',
  'germany': 'Germany',
  'netherlands': 'Netherlands',
  'mauritius': 'Mauritius',
  'hong kong': 'Hong Kong',
  'philippines': 'Philippines',
  'thailand': 'Thailand',
  'indonesia': 'Indonesia',
  'vietnam': 'Vietnam',
  'estonia': 'Estonia',
  'italy': 'Italy',
};

const SERVICE_MAP = {
  'incorporat': 'Incorporation', 'register': 'Incorporation', 'set up': 'Incorporation',
  'bank': 'Banking',
  'tax': 'Taxation',
  'fema': 'FEMA/ODI', 'odi': 'FEMA/ODI', 'remittance': 'FEMA/ODI',
  'residency': 'Residency', 'visa': 'Residency', 'immigrat': 'Residency',
  'compliance': 'Compliance',
  'fundrais': 'Fundraising', 'vc ': 'Fundraising', 'investor': 'Fundraising',
};

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/;
const EXPAND_INTENT_RE = /expand|incorporat|setup|set up|open|register|move|launch|start|going to|looking at|consider|want to|thinking about/i;

function extractEntities(msg, mem) {
  const lower = msg.toLowerCase();
  const updates = {};

  const em = msg.match(EMAIL_RE);
  if (em && !mem.email) updates.email = em[0];

  if (!mem.targetCountry) {
    for (const [kw, country] of Object.entries(COUNTRY_MAP)) {
      if (lower.includes(kw) && EXPAND_INTENT_RE.test(lower)) {
        updates.targetCountry = country; break;
      }
    }
  }
  if (!mem.currentCountry && /\b(indian|from india|based in india|india-based|indian founder|indian entrepreneur)\b/i.test(lower)) {
    updates.currentCountry = 'India';
  }
  if (!mem.serviceNeeded) {
    for (const [kw, svc] of Object.entries(SERVICE_MAP)) {
      if (lower.includes(kw)) { updates.serviceNeeded = svc; break; }
    }
  }
  return updates;
}

// ─────────────────────────────────────────────
// TOPIC DETECTION
// ─────────────────────────────────────────────
const TOPIC_REs = [
  [/\bbank|account opening/i,            'Banking'],
  [/incorporat|register|company|setup/i, 'Incorporation'],
  [/\btax\b|gst|vat|withholding/i,       'Taxation'],
  [/fema|odi|outward|remittance/i,       'FEMA/ODI'],
  [/residency|visa|immigrat/i,           'Residency'],
  [/cost|fee|price|budget/i,             'Costs'],
  [/timeline|how long|urgent|asap/i,     'Timeline'],
  [/document|require/i,                  'Documentation'],
  [/fundrais|vc|investor|raise/i,        'Fundraising'],
  [/compliance|deadline|penalt/i,        'Compliance'],
];
function inferTopic(msg) {
  for (const [re, t] of TOPIC_REs) if (re.test(msg)) return t;
  return null;
}

// ─────────────────────────────────────────────
// INTENT DETECTION — deterministic, no LLM needed
// ─────────────────────────────────────────────
const HUMAN_RE = /\b(human|agent|speak to|talk to|real person|connect me|your team|manager|expert|someone from|call me|get me)\b/i;

// Ordinal word → number
const ORDINAL_MAP = { first: 1, second: 2, third: 3, fourth: 4, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };

function detectIntent(msg) {
  const lower = msg.toLowerCase().trim();

  if (HUMAN_RE.test(lower)) return { type: 'human_request' };

  // Ordinal words: "third one", "the second", "fourth option"
  for (const [word, num] of Object.entries(ORDINAL_MAP)) {
    if (lower.includes(word)) return { type: 'menu_select', num };
  }

  // "last option" → 4
  if (/\blast\b/.test(lower) && lower.length < 25) return { type: 'menu_select', num: 4 };

  // Numeric selection: "3", "option 3", "question 3", "#3"
  const numMatch = lower.match(/(?:^|\b)(?:option\s*|question\s*|no\.?\s*|#\s*)?([1-4])(?:\b|$)/);
  if (numMatch && lower.replace(/\D/g, '').length <= 2 && lower.length < 35) {
    return { type: 'menu_select', num: parseInt(numMatch[1]) };
  }

  // Out-of-range number
  const badNum = lower.match(/(?:^|\b)(?:option\s*|question\s*)?([5-9]|1[0-9])(?:\b|$)/);
  if (badNum && lower.length < 20) return { type: 'invalid_menu' };

  return { type: 'query' };
}

// ─────────────────────────────────────────────
// GREETING DETECTION — deterministic
// ─────────────────────────────────────────────
const GREETING_RE = /^(hi|hey|hello|good morning|good evening|good afternoon|hola|yo|sup|howdy|greetings)\b[!.,]?\s*$/i;

// ─────────────────────────────────────────────
// DETERMINISTIC MENU PARSER
// Parses options from Claude's reply and stores them.
// Supports: 1️⃣ text, 1. text, 1) text
// ─────────────────────────────────────────────
function parseMenuFromReply(reply) {
  // Emoji number: 1️⃣  2️⃣  3️⃣  4️⃣
  const emojiRE = /[1-4]️⃣\s*(.+?)(?=\n[1-4]️⃣|\n*$)/g;
  // Plain: 1. text or 1) text
  const plainRE = /^([1-4])[.)]\s*(.+)/gm;

  let opts = [];
  let m;

  while ((m = emojiRE.exec(reply)) !== null) opts.push(m[1].trim());

  if (opts.length < 3) {
    opts = [];
    while ((m = plainRE.exec(reply)) !== null) opts.push(m[2].trim());
  }

  if (opts.length >= 3) {
    // Pad to 4 if only 3
    while (opts.length < 4) opts.push(opts[opts.length - 1]);
    return opts.slice(0, 4);
  }
  return null;
}

// ─────────────────────────────────────────────
// CONTEXT BLOCK — compact, per-request injection
// This is what Claude sees about the user each call — keep it tiny.
// ─────────────────────────────────────────────
function buildContextBlock(mem, state) {
  const lines = [];
  if (mem.name)           lines.push(`Name: ${mem.name}`);
  if (mem.targetCountry)  lines.push(`Target: ${mem.targetCountry}`);
  if (mem.currentCountry) lines.push(`Based: ${mem.currentCountry}`);
  if (mem.serviceNeeded)  lines.push(`Interest: ${mem.serviceNeeded}`);
  if (state.topicsDiscussed.length > 0) lines.push(`Topics: ${state.topicsDiscussed.slice(-4).join(', ')}`);
  if (state.phase)        lines.push(`Phase: ${state.phase}`);

  // Active menu — critical for menu continuity
  if (state.lastMenu) {
    const m = state.lastMenu;
    lines.push(`\n[ACTIVE MENU — context: "${m.context}"]\n1. ${m.options[0]}\n2. ${m.options[1]}\n3. ${m.options[2]}\n4. ${m.options[3]}`);
  }

  return lines.length ? `\n\n[USER CONTEXT]\n${lines.join('\n')}` : '';
}

// ─────────────────────────────────────────────
// TOKEN ESTIMATOR — rough character-based estimate
// Prevents accidental oversized requests
// ─────────────────────────────────────────────
function estimateTokens(text) {
  // ~4 chars per token on average
  return Math.ceil((text || '').length / 4);
}

// ─────────────────────────────────────────────
// RATE LIMIT STATE — per-process, resets with server
// ─────────────────────────────────────────────
let _rateLimitUntil = 0;
let _rateLimitRetryAfter = 0;

// ─────────────────────────────────────────────
// CLAUDE API CALL — token-safe, rate-limit-aware
// ─────────────────────────────────────────────
async function callClaude(session, state, mem, userMessage, kbSection, phaseHint) {
  // Check if we're in rate-limit backoff
  if (Date.now() < _rateLimitUntil) {
    const waitSec = Math.ceil((_rateLimitUntil - Date.now()) / 1000);
    console.warn(`⚠️  Rate limit active — ${waitSec}s remaining`);
    return { reply: null, rateLimited: true, waitSec };
  }

  const contextBlock = buildContextBlock(mem, state);
  const systemPrompt = ADVISOR_SYSTEM_PROMPT + contextBlock + (phaseHint || '') + (kbSection || '');

  // Use only last 6 history messages — 3 turns — enough for context, minimal tokens
  const history = session.history.slice(-6);
  const messages = [...history, { role: 'user', content: userMessage }];

  // Rough token check — warn if approaching limits
  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(messages));
  console.log(`📊  Est. input tokens: ~${estimatedInputTokens}`);
  if (estimatedInputTokens > 25000) {
    console.warn(`⚠️  Large prompt detected (${estimatedInputTokens} est. tokens) — trimming history further`);
    // Emergency: trim to 4 messages
    messages.splice(0, Math.max(0, messages.length - 5));
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 650,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json();

    // ── Rate limit handling ──
    if (response.status === 429) {
      const retryAfter = parseInt(data?.error?.message?.match(/\d+/)?.[0] || '60');
      _rateLimitUntil = Date.now() + (retryAfter * 1000);
      _rateLimitRetryAfter = retryAfter;
      console.error(`❌  Rate limited. Retry after ${retryAfter}s`);
      return { reply: null, rateLimited: true, waitSec: retryAfter };
    }

    if (!response.ok) {
      console.error(`❌  Claude error ${response.status}:`, JSON.stringify(data));
      return { reply: null, rateLimited: false };
    }

    // Clear rate limit state on success
    _rateLimitUntil = 0;

    const reply = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim() || null;

    return { reply, rateLimited: false };

  } catch (err) {
    console.error('❌  Claude fetch failed:', err.message);
    return { reply: null, rateLimited: false };
  }
}

// ─────────────────────────────────────────────
// WHATSAPP SENDER
// ─────────────────────────────────────────────
function parsePhone(raw) {
  const d = String(raw).replace(/\D/g, '');
  if (/^91[6-9]\d{9}$/.test(d))  return { countryCode: '+91',  phoneNumber: d.slice(2) };
  if (/^1[2-9]\d{9}$/.test(d))   return { countryCode: '+1',   phoneNumber: d.slice(1) };
  if (/^971\d{9}$/.test(d))      return { countryCode: '+971', phoneNumber: d.slice(3) };
  return { countryCode: '+91', phoneNumber: d };
}

async function send(phone, text) {
  console.log(`📤  [${phone}] ${text.substring(0, 100)}…`);
  if (!INTERAKT_API_KEY) { console.warn('⚠️  No INTERAKT_API_KEY'); return; }
  const { countryCode, phoneNumber } = parsePhone(phone);
  try {
    const r = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { Authorization: `Basic ${INTERAKT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode, phoneNumber, callbackData: 'bot_reply', type: 'Text', data: { message: text } }),
    });
    if (r.ok) console.log('✅  Sent');
    else console.error(`❌  Interakt ${r.status}`);
  } catch (err) {
    console.error('❌  Send failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// STRUCTURED HANDOFF EMAIL
// Built entirely from structured memory — zero LLM, zero hallucination risk.
// ─────────────────────────────────────────────
async function sendHandoffEmail(phone, mem, session, extraInfo) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) { console.warn('⚠️  Email not configured'); return; }

  const name     = mem.name           || 'Not provided';
  const target   = mem.targetCountry  || 'Not specified';
  const based    = mem.currentCountry || 'Not specified';
  const service  = mem.serviceNeeded  || 'Not specified';
  const email    = mem.email          || 'Not provided';

  // Raw last 8 turns — no LLM summarisation
  const chatLog = session.history.slice(-8)
    .map(m => `${m.role === 'user' ? '👤 Customer' : '🤖 Advisor'}: ${m.content}`)
    .join('\n\n');

  const html = `
<div style="font-family:Arial,sans-serif;max-width:640px;color:#222">
  <h2 style="color:#1a365d;margin-bottom:4px">New Consultation Request</h2>
  <p style="color:#666;margin-top:0">Comply Globally WhatsApp Bot</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr style="background:#f0f4f8"><td style="padding:8px 12px;font-weight:bold;width:160px">Phone</td><td style="padding:8px 12px">+${phone}</td></tr>
    <tr style="background:#fff">    <td style="padding:8px 12px;font-weight:bold">Name</td><td style="padding:8px 12px">${name}</td></tr>
    <tr style="background:#f0f4f8"><td style="padding:8px 12px;font-weight:bold">Email</td><td style="padding:8px 12px">${email}</td></tr>
    <tr style="background:#fff">    <td style="padding:8px 12px;font-weight:bold">Target Market</td><td style="padding:8px 12px">${target}</td></tr>
    <tr style="background:#f0f4f8"><td style="padding:8px 12px;font-weight:bold">Based In</td><td style="padding:8px 12px">${based}</td></tr>
    <tr style="background:#fff">    <td style="padding:8px 12px;font-weight:bold">Service</td><td style="padding:8px 12px">${service}</td></tr>
    ${extraInfo ? `<tr style="background:#fff8e1"><td style="padding:8px 12px;font-weight:bold">Extra Info</td><td style="padding:8px 12px">${extraInfo}</td></tr>` : ''}
  </table>
  <h3 style="color:#1a365d">Conversation Log</h3>
  <pre style="background:#f8f9fa;padding:16px;border-radius:6px;font-size:13px;white-space:pre-wrap;border-left:4px solid #4299e1;overflow-x:auto">${chatLog}</pre>
  <div style="margin-top:20px;padding:16px;background:#e6ffed;border-radius:6px">
    <strong>Quick Actions</strong><br>
    🔗 <a href="https://app.interakt.ai">Open Interakt (respond on WhatsApp)</a><br>
    📞 Call: +${phone}<br>
    ${email !== 'Not provided' ? `📧 Email: ${email}<br>` : ''}
  </div>
</div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [NOTIFY_EMAIL], subject: `Consultation Request — ${name} (+${phone})`, html }),
    });
    if (r.ok) console.log('✅  Handoff email sent');
    else console.error(`❌  Email ${r.status}: ${await r.text()}`);
  } catch (err) {
    console.error('❌  Email failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// RATE LIMIT GRACEFUL RESPONSE
// ─────────────────────────────────────────────
function rateLimitResponse(waitSec) {
  if (waitSec <= 30) {
    return `Just a moment — I'll have your answer in about ${waitSec} seconds. Feel free to hold on! ⏳`;
  }
  return `I'm handling several conversations right now — could you give me about a minute? I'll be right with you. Your question is important and I don't want to give you a rushed answer.`;
}

// ─────────────────────────────────────────────
// WEBHOOK — MAIN HANDLER
// ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Always ack WhatsApp immediately

  try {
    const body   = req.body;
    if (body.type !== 'message_received') return;

    const phone  = (body.data?.customer?.phone_number || '').replace(/\D/g, '');
    const rawMsg = (body.data?.message?.message || '').trim();
    if (!phone || !rawMsg) return;

    console.log(`\n📩  [${phone}] "${rawMsg}"`);

    // Detect first-time user before loading (avoids loading empty docs)
    const isFirstTime = sessionsCol ? !(await sessionsCol.findOne({ phone })) : !cGet('session', phone);

    const [session, state, mem] = await Promise.all([
      getSession(phone), getState(phone), getMemory(phone),
    ]);

    // ══════════════════════════════════════════════
    // 1. FIRST-TIME USER
    // ══════════════════════════════════════════════
    if (isFirstTime) {
      const msg = `Hi there! 👋 Welcome to Comply Globally.\n\nI'm your international business expansion advisor — here to help you navigate incorporation, banking, tax, and compliance across 47+ jurisdictions.\n\nBefore we dive in — who am I speaking with?`;
      await send(phone, msg);
      session.history.push({ role: 'assistant', content: msg });
      state.phase = 'onboarding';
      await Promise.all([saveSession(session), saveState(state), saveMemory(mem)]);
      return;
    }

    // ══════════════════════════════════════════════
    // 2. HUMAN MODE — suppress bot
    // ══════════════════════════════════════════════
    if (state.humanMode) {
      const elapsed = Date.now() - new Date(state.humanModeAt || 0).getTime();
      if (elapsed < HUMAN_TIMEOUT_MS) {
        console.log(`🧑  Human mode active — suppressing for ${phone}`);
        return;
      }
      console.log(`⏰  Human mode expired — resuming bot for ${phone}`);
      state.humanMode = false;
      state.humanModeAt = null;
      state.phase = 'advisory';
    }

    // ══════════════════════════════════════════════
    // 3. PENDING HANDOFF — collect extra info then send email
    // ══════════════════════════════════════════════
    if (state.pendingHandoff) {
      const isNegative = /^(no|nope|nothing|n\/a|nah|not really|skip|none)$/i.test(rawMsg.trim());
      const extraInfo  = isNegative ? null : rawMsg;

      const confirmMsg = `Perfect — our team will be in touch with you shortly! 🙌`;
      await send(phone, confirmMsg);

      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: confirmMsg });

      state.pendingHandoff   = false;
      state.handoffEmailSent = true;
      state.humanMode        = true;
      state.humanModeAt      = new Date();
      state.phase            = 'human_mode';
      state.lastMenu         = null; // clear any active menu

      await sendHandoffEmail(phone, mem, session, extraInfo);
      await Promise.all([saveSession(session), saveState(state)]);
      return;
    }

    // ══════════════════════════════════════════════
    // 4. ENTITY EXTRACTION (runs on every message)
    // ══════════════════════════════════════════════
    if (!mem.name) {
      const n = extractName(rawMsg);
      if (n) { mem.name = n; console.log(`✅  Name locked: ${n}`); }
    }
    const entityUpdates = extractEntities(rawMsg, mem);
    if (Object.keys(entityUpdates).length > 0) {
      Object.assign(mem, entityUpdates);
      console.log(`📝  Entities:`, entityUpdates);
    }

    // Topic tracking
    const topic = inferTopic(rawMsg);
    if (topic && !state.topicsDiscussed.includes(topic)) {
      state.topicsDiscussed.push(topic);
    }

    // Phase update
    if (state.phase === 'new' || state.phase === 'onboarding') {
      if (mem.name && mem.targetCountry) state.phase = 'advisory';
    }

    // ══════════════════════════════════════════════
    // 5. INTENT ROUTING — deterministic, no LLM
    // ══════════════════════════════════════════════
    const intent = detectIntent(rawMsg);

    // ── 5a. Human handoff request ──
    if (intent.type === 'human_request') {
      const msg = `Of course! I'll connect you with our specialist team right away. 😊\n\n📞 Direct contact:\n• Email: sales@complyglobally.com\n• Phone: +1 (302) 214-1717 | +91 99999 81613\n\nIs there any additional context you'd like to share before they reach out?`;
      await send(phone, msg);
      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: msg });
      state.pendingHandoff = true;
      state.phase          = 'escalating';
      state.lastMenu       = null;
      await Promise.all([saveSession(session), saveState(state)]);
      return;
    }

    // ── 5b. Invalid menu number ──
    if (intent.type === 'invalid_menu') {
      // KEEP lastMenu active — don't clear it
      const msg = state.lastMenu
        ? `I had options 1 to 4 there — did you mean one of those? 😊 Or go ahead and ask directly!`
        : `Just ask me anything directly and I'll help you out!`;
      await send(phone, msg);
      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: msg });
      await Promise.all([saveSession(session), saveState(state)]);
      return;
    }

    // ── 5c. Valid menu selection ──
    if (intent.type === 'menu_select' && state.lastMenu) {
      const num      = intent.num;
      const selected = state.lastMenu.options[num - 1];
      if (selected) {
        console.log(`📋  Menu ${num} selected: "${selected}"`);
        // Select relevant KB section for this option
        const kbSection = selectKBSections(selected);
        const menuHint  = `\n\n[INSTRUCTION: The user selected option ${num}: "${selected}" from the active menu. Answer this question fully and accurately from the knowledge base. You may show new follow-up options after answering.]`;

        const { reply, rateLimited, waitSec } = await callClaude(session, state, mem, selected, kbSection, menuHint);

        if (rateLimited) {
          await send(phone, rateLimitResponse(waitSec || 60));
          // Don't push to history — let them retry
          return;
        }
        if (!reply) {
          await send(phone, `I hit a brief snag there. Please try again in a moment!`);
          return;
        }

        await send(phone, reply);
        session.history.push({ role: 'user', content: rawMsg });
        session.history.push({ role: 'assistant', content: reply });

        // Update or clear menu deterministically
        const newMenu = parseMenuFromReply(reply);
        state.lastMenu = newMenu
          ? { id: Date.now(), options: newMenu, context: selected, createdAt: Date.now() }
          : null;

        await Promise.all([saveSession(session), saveState(state), saveMemory(mem)]);
        return;
      }
    }

    // ══════════════════════════════════════════════
    // 6. RETURNING USER GREETING — no LLM needed
    // ══════════════════════════════════════════════
    if (GREETING_RE.test(rawMsg) && session.history.length > 2) {
      const nameGreet = mem.name ? `, ${mem.name}` : '';
      const topicRef  = state.topicsDiscussed.length > 0
        ? ` Last time we were discussing ${state.topicsDiscussed.slice(-2).join(' and ')} — want to pick up there, or something new on your mind?`
        : ` What are you working on today?`;
      const msg = `Hey${nameGreet}! Great to have you back. 😊${topicRef}`;
      await send(phone, msg);
      session.history.push({ role: 'user', content: rawMsg });
      session.history.push({ role: 'assistant', content: msg });
      await Promise.all([saveSession(session), saveState(state), saveMemory(mem)]);
      return;
    }

    // ══════════════════════════════════════════════
    // 7. STANDARD CLAUDE ADVISORY RESPONSE
    // ══════════════════════════════════════════════

    // Select relevant KB sections (only what's needed for this query)
    const kbSection = selectKBSections(rawMsg);

    // Phase-specific instruction hint
    let phaseHint = '';
    if (state.phase === 'onboarding' || state.phase === 'new') {
      if (!mem.name) {
        phaseHint = `\n\n[PHASE: Onboarding. You don't have the user's name yet. Answer their question, then warmly ask their name at the end if natural.]`;
      } else if (!mem.targetCountry) {
        phaseHint = `\n\n[PHASE: Onboarding. You have name (${mem.name}) but not target country. Answer their question, then ask which market they're exploring.]`;
      }
    }

    const { reply, rateLimited, waitSec } = await callClaude(session, state, mem, rawMsg, kbSection, phaseHint);

    if (rateLimited) {
      await send(phone, rateLimitResponse(waitSec || 60));
      return;
    }
    if (!reply) {
      await send(phone, `I hit a brief connectivity issue. Please try your question again — I don't want you to miss out on this!`);
      return;
    }

    await send(phone, reply);
    session.history.push({ role: 'user', content: rawMsg });
    session.history.push({ role: 'assistant', content: reply });

    // Parse and store any menu Claude generated
    const newMenu = parseMenuFromReply(reply);
    if (newMenu) {
      state.lastMenu = { id: Date.now(), options: newMenu, context: topic || rawMsg.substring(0, 60), createdAt: Date.now() };
      console.log(`📋  Menu stored: [${newMenu.join(' | ')}]`);
    }
    // Note: if no menu in reply, we intentionally KEEP the previous lastMenu active
    // (don't clear it on unrelated short replies or interruptions)
    // It only gets cleared when: new menu replaces it, valid selection made, or handoff triggered.

    await Promise.all([saveSession(session), saveState(state), saveMemory(mem)]);

  } catch (err) {
    console.error('❌  Webhook error:', err.message, err.stack);
  }
});

// ─────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  rateLimitActive: Date.now() < _rateLimitUntil,
  rateLimitUntil: _rateLimitUntil > 0 ? new Date(_rateLimitUntil).toISOString() : null,
}));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Full reset — dev/test only
app.post('/reset/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  ['session','state','memory'].forEach(s => _cache[s].delete(phone));
  await Promise.all([
    sessionsCol    && sessionsCol.deleteOne({ phone }),
    activeStateCol && activeStateCol.deleteOne({ phone }),
    memoryCol      && memoryCol.deleteOne({ phone }),
  ].filter(Boolean));
  console.log(`🗑️  Reset: ${phone}`);
  res.json({ success: true });
});

// Release human mode (call after agent finishes)
app.post('/release-human/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const state = await getState(phone);
  state.humanMode   = false;
  state.humanModeAt = null;
  state.phase       = 'advisory';
  await saveState(state);
  res.json({ success: true, message: `Bot resumed for ${phone}` });
});

// Debug view
app.get('/debug/:phone', async (req, res) => {
  const phone = req.params.phone.replace(/\D/g, '');
  const [session, state, mem] = await Promise.all([getSession(phone), getState(phone), getMemory(phone)]);
  res.json({
    memory: { name: mem.name, targetCountry: mem.targetCountry, currentCountry: mem.currentCountry, serviceNeeded: mem.serviceNeeded, email: mem.email },
    state:  { phase: state.phase, topicsDiscussed: state.topicsDiscussed, humanMode: state.humanMode, lastMenu: state.lastMenu },
    historyLength: session.history.length,
    lastMessages: session.history.slice(-4),
  });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀  ComplyGlobally Bot v4.0 — Token-Efficient Edition`);
    console.log(`📡  Port: ${PORT}`);
    console.log(`📮  POST /webhook`);
    console.log(`❤️   GET  /health`);
    console.log(`🗑️   POST /reset/:phone`);
    console.log(`🔓  POST /release-human/:phone`);
    console.log(`🔍  GET  /debug/:phone\n`);
  });
});
