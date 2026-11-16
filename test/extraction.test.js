'use strict';
// Offline tests for name/country extraction and reply handling. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../server');

test('bad names from the old summary scraper are rejected', () => {
  for (const bad of ['is exploring', 'is looking', 'The user', 'Pty ltd', 'FEMA', 'Australia', 'urgent', 'Banking Setup', 'has expressed']) {
    assert.equal(s.isPlausibleName(bad), false, bad);
  }
  for (const good of ['Arjun Mehta', 'Vikram KS Kapoor', 'CA Vikram KS Kapoor', 'Rahul', "D'Souza", 'Anil (Andy)']) {
    assert.equal(s.isPlausibleName(good), true, good);
  }
});

test('explicit intros are captured, sentences are not', () => {
  assert.equal(s.extractExplicitName('my name is arjun mehta'), 'Arjun Mehta');
  assert.equal(s.extractExplicitName("Hi, I'm Rahul"), 'Rahul');
  assert.equal(s.extractExplicitName('i am interested in UAE'), null);
  assert.equal(s.extractExplicitName('this is urgent'), null);
  assert.equal(s.extractExplicitName("I'm looking to expand to Dubai"), null);
  assert.equal(s.extractExplicitName('Call me Andy'), 'Andy');
});

test('standalone reply to "who am I speaking with?"', () => {
  assert.equal(s.extractStandaloneName('Arjun Mehta'), 'Arjun Mehta');
  assert.equal(s.extractStandaloneName('CA Vikram KS Kapoor'), 'Vikram KS Kapoor');
  assert.equal(s.extractStandaloneName('FEMA'), null);
  assert.equal(s.extractStandaloneName('Australia'), null);
  assert.equal(s.extractStandaloneName('who is required to do APR Filling??'), null);
});

test('LLM names must be grounded in the user message', () => {
  const mem = s.newMemory('1');
  s.applyProfile(mem, 'Australia', { llm: { name: 'Arjun', preferredName: null, targetCountries: ['Australia'], currentCountry: null, services: [] } });
  assert.equal(mem.name, null);                  // "Arjun" not in message → rejected
  assert.deepEqual(mem.targetCountries, ['Australia']);
  s.applyProfile(mem, 'CA Vikram KS Kapoor', { llm: { name: 'Vikram KS Kapoor', preferredName: null, targetCountries: [], currentCountry: null, services: [] } });
  assert.equal(mem.name, 'Vikram KS Kapoor');
  assert.equal(s.firstName(mem.name), 'Vikram');
});

test('country matching uses word boundaries', () => {
  assert.deepEqual(s.findCountries('Ukraine business'), []);
  assert.deepEqual(s.findCountries('set up in saudi arabia and dubai'), ['Saudi Arabia', 'UAE']);
  assert.equal(s.canonicalCountry('United Arab Emirates'), 'UAE');
  const rx = s.regexProfile("I'm based in India, want to expand to Singapore", s.newMemory('1'));
  assert.equal(rx.currentCountry, 'India');
  assert.deepEqual(rx.targetCountries, ['Singapore']);
});

test('menu parsing does not duplicate options', () => {
  const reply = 'Text.\n\nWant to explore further?\n1️⃣ A one\n2️⃣ B two\n3️⃣ C three\n4️⃣ D four';
  assert.deepEqual(s.parseMenuFromReply(reply), ['A one', 'B two', 'C three', 'D four']);
});

test('cut-off replies are trimmed to complete text', () => {
  const cut = 'Good point. Here is the plan.\n\nWant to explore further?\n1️⃣ What are taxes?\n2️⃣ How does the dir';
  assert.equal(s.trimIncompleteReply(cut), 'Good point. Here is the plan.');
  const cut4 = 'Plan.\n\nWant to explore further?\n1️⃣ A one\n2️⃣ B two\n3️⃣ C three\n4️⃣ D fo';
  assert.equal(s.trimIncompleteReply(cut4), 'Plan.\n\nWant to explore further?\n1️⃣ A one\n2️⃣ B two\n3️⃣ C three');
  assert.equal(s.trimIncompleteReply('First sentence. Second sentence is cut mid'), 'First sentence.');
});

test('long replies split under WhatsApp limit', () => {
  const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i} with some words in it.`).join('\n\n');
  const parts = s.splitForWhatsApp(long, 500);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 500));
  assert.equal(parts.join('\n\n'), long);
});

test('markdown converted to WhatsApp formatting', () => {
  assert.equal(s.toWhatsApp('## Title\n**bold** and - item'), '*Title*\n*bold* and - item');
});

test('history sent to Claude starts with a user turn', () => {
  const msgs = s.buildMessages([{ role: 'assistant', content: 'Hi! who am I speaking with?' }], 'Arjun');
  assert.equal(msgs[0].role, 'user');
});

test('"first" inside a sentence is not a menu pick', async () => {
  assert.equal((await s.classifyIntent('what do I need first for banking')).type, 'query');
  assert.deepEqual(await s.classifyIntent('the second one'), { type: 'menu_select', num: 2 });
  assert.deepEqual(await s.classifyIntent('3'), { type: 'menu_select', num: 3 });
});
