const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/tmp/property.db';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

console.log('Opening database at:', DB_PATH);
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    payment_method TEXT,
    rent REAL NOT NULL,
    deposit REAL,
    lease_start TEXT,
    lease_end TEXT,
    prorated_first REAL,
    color TEXT DEFAULT '#185FA5',
    initials TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    urgency TEXT DEFAULT 'routine',
    category TEXT DEFAULT 'general',
    status TEXT DEFAULT 'open',
    needs_review INTEGER DEFAULT 0,
    reviewed INTEGER DEFAULT 0,
    resolved INTEGER DEFAULT 0,
    agent_classified INTEGER DEFAULT 0,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT DEFAULT 'rent',
    month TEXT NOT NULL,
    note TEXT,
    confirmed INTEGER DEFAULT 0,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS utility_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    total REAL NOT NULL,
    tenant_share REAL NOT NULL,
    period TEXT,
    notes TEXT,
    notified INTEGER DEFAULT 0,
    receipt_url TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    tenant_id TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    ref_conversation_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduling_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    provider_name TEXT,
    provider_phone TEXT,
    status TEXT DEFAULT 'collecting_availability',
    notes TEXT,
    requested_by TEXT DEFAULT 'owner',
    proposed_slots TEXT,
    confirmed_slot TEXT,
    booking_draft TEXT,
    provider_notified INTEGER DEFAULT 0,
    provider_confirmed INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scheduling_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    party TEXT NOT NULL,
    party_name TEXT NOT NULL,
    availability_text TEXT DEFAULT 'pending',
    status TEXT DEFAULT 'waiting',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES scheduling_jobs(id)
  );

  CREATE TABLE IF NOT EXISTS scheduled_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    send_date TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (job_id) REFERENCES scheduling_jobs(id)
  );

  CREATE TABLE IF NOT EXISTS provider_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_phone TEXT NOT NULL,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    short_name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    service_type TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS receipt_store (
    id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    name TEXT,
    mime_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations for existing databases
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN receipt_url TEXT`); } catch(e) {}

const seedTenants = () => {
  const existing = db.prepare('SELECT COUNT(*) as count FROM tenants').get();
  if (existing.count > 0) return;
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('temi', 'Temitope W Onayemi', 'Temi', '+17089292466', 'Apple Pay / Venmo', 1850, 1850, '2026-05-14', '2027-05-31', 1074.19, '#185FA5', 'TW');
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('chloe', 'Chloe Moslener', 'Chloe', '+18143924015', 'Zelle', 1750, 1750, '2026-05-15', '2026-08-31', 960.48, '#0F6E56', 'CM');
};

const seedConfig = () => {
  const defaults = [
    ['agent_persona', 'You are a professional property management agent for 9 Quincy Pl NE #2, Washington DC 20002, managed by the owner Dongyeon Suh. You communicate on behalf of the owner professionally, warmly, and efficiently. You never reveal personal details about the owner or other tenants. You never promise resolutions without owner approval. You gather information systematically to help the owner make decisions.'],
    ['urgency_rules', 'EMERGENCY (respond ASAP, escalate immediately): water leak, flooding, gas smell, fire, no heat in winter below 40F, electrical sparks, security breach, injury, break-in. URGENT (1-2 business days): broken appliance, no hot water, AC broken in summer above 85F, lock issue, pest infestation, significant damage, mold. ROUTINE (5 business days): cosmetic issues, general questions, non-critical maintenance, noise complaints, general inquiries, minor repairs.'],
    ['gather_maintenance', 'Ask these questions ONE AT A TIME: 1) exact location in unit (bedroom, bathroom, kitchen, living room, entryway/hallway, laundry area, balcony, or common areas), 2) when it started, 3) is it getting worse?, 4) any photos you can send?, 5) has this happened before?'],
    ['gather_complaint', 'Ask these questions ONE AT A TIME: 1) nature of the complaint in more detail, 2) when did it start?, 3) how often is it happening?, 4) is anyone else involved?, 5) how is it affecting your use of the unit?'],
    ['gather_payment', 'Ask these questions ONE AT A TIME: 1) which month is in question?, 2) how much do you believe you paid?, 3) what date and method did you use?, 4) do you have a confirmation number or screenshot?'],
    ['gather_scheduling', 'Ask: 1) What are 2-3 windows of availability over the next 1-2 weeks? 2) Is there any time that absolutely does not work?'],
    ['custom_rules', 'Keep SMS responses under 300 characters. Split longer messages naturally. Never be dismissive. If a tenant is upset or frustrated, acknowledge their feelings before asking questions. Sign off as: — 9 Quincy Management. Never discuss other tenants. Never reveal owner personal details. When asking about maintenance locations, use: bedroom, bathroom, kitchen, living room, entryway/hallway, laundry area, balcony, or common areas. Do not use technical terms like main basin or disposal area.'],
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO agent_config (key, value) VALUES (?, ?)');
  defaults.forEach(([k, v]) => stmt.run(k, v));
};

const seedProviders = () => {
  const existing = db.prepare('SELECT COUNT(*) as count FROM service_providers').get();
  if (existing.count > 0) return;
  db.prepare(`INSERT OR IGNORE INTO service_providers (name, short_name, phone, service_type) VALUES (?, ?, ?, ?)`).run('Mehmet', 'Mehmet', '+12023897752', 'pest_control');
  db.prepare(`INSERT OR IGNORE INTO service_providers (name, short_name, phone, service_type) VALUES (?, ?, ?, ?)`).run('Stanley / Dazzling Cleaning', 'Stanley', '+12535188749', 'cleaning');
};

seedTenants();
seedConfig();
seedProviders();

console.log('Database ready');
module.exports = db;
