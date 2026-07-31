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
    owner_share REAL NOT NULL,
    downstairs_share REAL NOT NULL,
    period TEXT,
    notes TEXT,
    notified INTEGER DEFAULT 0,
    receipt_url TEXT,
    receipt_data TEXT,
    receipt_text TEXT,
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

  CREATE TABLE IF NOT EXISTS lease_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    data TEXT NOT NULL,
    mime_type TEXT DEFAULT 'application/pdf',
    summary TEXT,
    active INTEGER DEFAULT 1,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  );

  CREATE TABLE IF NOT EXISTS message_previews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    tenant_id TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    ref_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT,
    incident_date TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT DEFAULT 'minor',
    title TEXT NOT NULL,
    description TEXT,
    lease_reference TEXT,
    action_taken TEXT,
    photo_data TEXT,
    photo_name TEXT,
    resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS moveouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    moveout_date TEXT NOT NULL,
    notice_received_date TEXT,
    inspection_date TEXT,
    inspection_notes TEXT,
    deposit_amount REAL DEFAULT 0,
    deductions TEXT,
    final_utilities REAL DEFAULT 0,
    amount_returned REAL DEFAULT 0,
    forwarding_address TEXT,
    status TEXT DEFAULT 'upcoming',
    returned_date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    to_number TEXT,
    recipient_name TEXT,
    recipient_kind TEXT,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'sent',
    error TEXT,
    trigger_source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN receipt_url TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN receipt_data TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN receipt_text TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN owner_share REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE utility_bills ADD COLUMN downstairs_share REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS lease_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, filename TEXT NOT NULL, data TEXT NOT NULL, mime_type TEXT DEFAULT 'application/pdf', summary TEXT, active INTEGER DEFAULT 1, uploaded_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS message_previews (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, tenant_id TEXT, content TEXT NOT NULL, status TEXT DEFAULT 'pending', ref_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, incident_date TEXT NOT NULL, category TEXT NOT NULL, severity TEXT DEFAULT 'minor', title TEXT NOT NULL, description TEXT, lease_reference TEXT, action_taken TEXT, photo_data TEXT, photo_name TEXT, resolved INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS moveouts (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, moveout_date TEXT NOT NULL, notice_received_date TEXT, inspection_date TEXT, inspection_notes TEXT, deposit_amount REAL DEFAULT 0, deductions TEXT, final_utilities REAL DEFAULT 0, amount_returned REAL DEFAULT 0, forwarding_address TEXT, status TEXT DEFAULT 'upcoming', returned_date TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}

// Richer tenant profile fields
try { db.exec(`CREATE TABLE IF NOT EXISTS message_log (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT NOT NULL, to_number TEXT, recipient_name TEXT, recipient_kind TEXT, body TEXT NOT NULL, status TEXT DEFAULT 'sent', error TEXT, trigger_source TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN room TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN move_in_date TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN emergency_name TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN emergency_phone TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN employer TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN notes TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN status TEXT DEFAULT 'current'`); } catch(e) {}
try { db.exec(`ALTER TABLE tenants ADD COLUMN deposit_held INTEGER DEFAULT 1`); } catch(e) {}

const seedTenants = () => {
  const existing = db.prepare('SELECT COUNT(*) as count FROM tenants').get();
  if (existing.count > 0) return;
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('temi', 'Temitope W Onayemi', 'Temi', '+17089292466', 'Apple Pay / Venmo', 1850, 1850, '2026-05-14', '2027-05-31', 1074.19, '#185FA5', 'TW');
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('chloe', 'Chloe Moslener', 'Chloe', '+18143924015', 'Zelle', 1750, 1750, '2026-05-15', '2026-08-31', 960.48, '#0F6E56', 'CM');
};

const seedConfig = () => {
  const defaults = [
    ['agent_persona', 'You are a professional property management agent for 9 Quincy Pl NE #2, Washington DC 20002, managed by the owner Dongyeon Suh (Eastring LLC). You communicate professionally, warmly, and efficiently on behalf of the owner. You never reveal personal details about the owner or other tenants. You never promise resolutions without owner approval. You gather information systematically. Every response ends with a brief disclosure.'],
    ['agent_disclosure', 'Note: For confirmation of any lease terms, please review your lease agreement. For matters requiring a decision, the landlord will follow up after review.'],
    ['urgency_rules', 'EMERGENCY (respond ASAP): water leak, flooding, gas smell, fire, no heat below 40F, electrical sparks, security breach, injury, break-in. URGENT (1-2 business days): broken appliance, no hot water, AC broken above 85F, lock issue, pest infestation, mold, significant damage. ROUTINE (5 business days): cosmetic issues, general questions, non-critical maintenance, noise complaints, general inquiries.'],
    ['gather_maintenance', 'Ask ONE AT A TIME: 1) exact location (bedroom, bathroom, kitchen, living room, entryway, laundry area, balcony, common areas), 2) when it started, 3) is it getting worse?, 4) photos available?, 5) happened before?'],
    ['gather_complaint', 'Ask ONE AT A TIME: 1) nature of complaint in detail, 2) when did it start?, 3) how often?, 4) anyone else involved?, 5) how is it affecting your use of the unit?'],
    ['gather_payment', 'Ask ONE AT A TIME: 1) which month?, 2) amount paid?, 3) date and method?, 4) confirmation number or screenshot?'],
    ['gather_scheduling', 'Ask: 1) 2-3 availability windows over next 1-2 weeks, 2) any times that absolutely do not work?'],
    ['escalate_topics', `lease termination or ending the lease early
security deposit disputes or deposit return
renegotiating rent, utility split, or any lease term
requests for discretion, exceptions, or waivers
lease renewal or non-renewal
subletting or replacing themselves with another tenant
legal threats, attorney mentions, or housing authority complaints
disputes about another tenant or accusations against the owner
requests to change payment amounts or due dates`],
    ['escalate_response', 'Thanks for raising this. This is something the landlord needs to review personally, so I have forwarded it and she will follow up with you directly. — 9 Quincy Management'],
    ['quiet_hours_enabled', '1'],
    ['quiet_hours_start', '21'],
    ['quiet_hours_end', '8'],
    ['downstairs_occupants', '2'],
    ['owner_shares_utilities', '1'],
    ['custom_rules', `Keep SMS responses under 300 characters. Split longer messages naturally. Never be dismissive. Acknowledge feelings before asking questions. Sign off as: — 9 Quincy Management. Never discuss other tenants. Never reveal owner personal details. Use house-specific locations: bedroom, bathroom, kitchen, living room, entryway/hallway, laundry area, balcony, common areas.

When tenants question utility amounts or request a different split: Reference Paragraph 7 confirming equal split regardless of usage, time in unit, or travel. Bills reflect actual third-party charges. Direct them to contact the utility company directly. Confirm utilities are due the 1st. Never negotiate the split.

When tenants ask about cancelling any shared utility including internet: Prohibited per lease. They remain responsible for their share regardless.

When tenants push back on owner entry for repairs, smoke detectors, HVAC, internet, or pest control: Owner has right to enter with 24 hours notice per Paragraph 29. No further justification required.

When tenants request notification of owner guests: Owner is not required to notify tenants of their own guests. Politely decline.

When tenants question garbage, dishes, or common area cleanliness: All residents share equal responsibility. No exceptions.

When tenants mention water leaks, electrical problems, broken locks, pests, mold, HVAC issues, or any safety hazard: Remind them this must be reported in writing immediately per Paragraph 27. Failure to report may make them liable for resulting damage. For emergencies call (734) 707-5258 or 911.

When tenants make partial payments or ask for extensions: Acknowledge. Remind them full rent is due the 1st. Partial payments do not waive the remaining balance or late fees per Paragraph 33F. Log for owner review.

When tenants are past the 5th without full payment: Remind them late fee of 10% of outstanding balance applies per Paragraph 6. State total now due. Direct them to pay immediately.

When tenants dispute a utility charge or say they already paid: Ask for date, amount, payment method, and confirmation. Log for owner review. Never confirm or deny payment.

When tenants have any question not covered above: Let them know the landlord will review and get back to them. EMERGENCY within the hour, URGENT within 1-2 business days, ROUTINE within 5 business days.`],
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
