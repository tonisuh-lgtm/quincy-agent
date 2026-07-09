require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');

const db = require('./db');
const { handleInboundSMS, sendRentReminder, checkOverdueRent, sendSMS, alertOwner } = require('./twilio-handler');
const { getConfig } = require('./agent');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'quincy2026';

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false, limit: '10mb' }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

function auth(req, res, next) {
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== DASHBOARD_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── TWILIO WEBHOOK ───────────────────────────────────────────
app.post('/webhook/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  if (!from || !body) return res.status(200).send('<Response></Response>');
  console.log(`SMS from ${from}: ${body}`);

  try {
    // Check if service provider
    const provider = db.prepare('SELECT * FROM service_providers WHERE phone = ? AND active = 1').get(from);
    if (provider) {
      db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run(from, 'inbound', body);
      const activeJob = db.prepare(`SELECT * FROM scheduling_jobs WHERE provider_phone = ? AND status IN ('confirmed','collecting_availability') ORDER BY created_at DESC LIMIT 1`).get(provider.phone);
      const jobRef = activeJob ? ` (Job #${activeJob.id} — ${activeJob.confirmed_slot || 'pending'})` : '';
      await alertOwner(`📞 Message from ${provider.name}${jobRef}:\n"${body}"\n\nReply via dashboard → Scheduling → ${provider.short_name} portal`);
      const confirmWords = ['confirm', 'confirmed', 'yes', 'ok', 'works', 'see you', 'will be there', 'got it'];
      if (activeJob && confirmWords.some(w => body.toLowerCase().includes(w))) {
        db.prepare(`UPDATE scheduling_jobs SET provider_confirmed = 1, updated_at = datetime('now') WHERE id = ?`).run(activeJob.id);
        await alertOwner(`✅ ${provider.name} confirmed for ${activeJob.confirmed_slot}`);
      }
      return res.status(200).send('<Response></Response>');
    }

    // Check if scheduling availability response
    const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND active = 1').get(from);
    if (tenant) {
      const activeSchedulingJob = db.prepare(`
        SELECT sj.*, sa.status as avail_status FROM scheduling_jobs sj
        JOIN scheduling_availability sa ON sa.job_id = sj.id
        WHERE sj.status = 'collecting_availability' AND sa.party_name = ? AND sa.status = 'waiting'
        ORDER BY sj.created_at DESC LIMIT 1
      `).get(tenant.short_name);

      if (activeSchedulingJob) {
        db.prepare(`UPDATE scheduling_availability SET availability_text = ?, status = 'received', updated_at = datetime('now') WHERE job_id = ? AND party_name = ?`).run(body, activeSchedulingJob.id, tenant.short_name);
        db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'inbound', ?, 'scheduling', 1)`).run(tenant.id, body);
        const ackMsg = `Thanks ${tenant.short_name}! We've noted your availability and will confirm the schedule shortly. — 9 Quincy Management`;
        await sendSMS(from, ackMsg);
        db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(tenant.id, ackMsg);

        const allWaiting = db.prepare(`SELECT COUNT(*) as count FROM scheduling_availability WHERE job_id = ? AND status = 'waiting'`).get(activeSchedulingJob.id).count;
        if (allWaiting === 0) {
          const availabilities = db.prepare('SELECT * FROM scheduling_availability WHERE job_id = ?').all(activeSchedulingJob.id);
          const availText = availabilities.map(a => `${a.party_name}: ${a.availability_text}`).join('\n');
          await alertOwner(`📅 All tenants responded for Job #${activeSchedulingJob.id}!\n\n${availText}\n\nLog in to dashboard → Scheduling to approve a time slot.`);
        }
        return res.status(200).send('<Response></Response>');
      }

      await handleInboundSMS(from, body);
    } else {
      await alertOwner(`⚠️ Unknown number: ${from}\n"${body}"`);
      await sendSMS(from, 'Thank you for reaching out to 9 Quincy Property Management. We\'ll be in touch shortly. — 9 Quincy Management');
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }

  res.status(200).send('<Response></Response>');
});

// ─── AUTH ─────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) res.json({ ok: true, token: DASHBOARD_PASSWORD });
  else res.status(401).json({ error: 'Wrong password' });
});

// ─── DASHBOARD ────────────────────────────────────────────────
app.get('/api/dashboard', auth, (req, res) => {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  const summary = tenants.map(t => {
    const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE tenant_id = ? AND month = ? AND type = 'rent'`).get(t.id, currentMonth).total;
    const lastMsg = db.prepare(`SELECT * FROM conversations WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT 1`).get(t.id);
    return { ...t, paid_this_month: paid, balance_due: Math.max(0, t.rent - paid), last_message: lastMsg };
  });
  const unread = db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE needs_review = 1 AND reviewed = 0`).get().count;
  const complaints = db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE category = 'complaint' AND resolved = 0 AND direction = 'inbound'`).get().count;
  const pendingScheduling = db.prepare(`SELECT COUNT(*) as count FROM scheduling_jobs WHERE status NOT IN ('completed','cancelled')`).get().count;
  res.json({ tenants: summary, unread, complaints, pendingScheduling, currentMonth });
});

// ─── CONVERSATIONS ────────────────────────────────────────────
app.get('/api/conversations', auth, (req, res) => {
  const { tenant_id, needs_review, category, limit = 60 } = req.query;
  let query = `SELECT c.*, t.short_name, t.color, t.initials FROM conversations c JOIN tenants t ON c.tenant_id = t.id WHERE 1=1`;
  const params = [];
  if (tenant_id) { query += ' AND c.tenant_id = ?'; params.push(tenant_id); }
  if (needs_review) { query += ' AND c.needs_review = 1 AND c.reviewed = 0'; }
  if (category) { query += ' AND c.category = ?'; params.push(category); }
  query += ` ORDER BY c.timestamp DESC LIMIT ${parseInt(limit)}`;
  res.json(db.prepare(query).all(...params));
});

app.post('/api/conversations/:id/review', auth, (req, res) => {
  db.prepare('UPDATE conversations SET reviewed = 1, needs_review = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/conversations/:id/resolve', auth, (req, res) => {
  db.prepare('UPDATE conversations SET resolved = 1, reviewed = 1, needs_review = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/send', auth, async (req, res) => {
  const { tenant_id, content } = req.body;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  await sendSMS(tenant.phone, content);
  db.prepare(`INSERT INTO conversations (tenant_id, direction, content, agent_classified) VALUES (?, 'outbound', ?, 0)`).run(tenant_id, content);
  res.json({ ok: true });
});

app.post('/api/broadcast', auth, async (req, res) => {
  const { tenant_id, content } = req.body;
  const targets = tenant_id === 'all'
    ? db.prepare('SELECT * FROM tenants WHERE active = 1').all()
    : [db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id)].filter(Boolean);
  for (const t of targets) {
    await sendSMS(t.phone, content);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, agent_classified) VALUES (?, 'outbound', ?, 0)`).run(t.id, content);
  }
  res.json({ ok: true, sent: targets.length });
});

// ─── PAYMENTS ─────────────────────────────────────────────────
app.get('/api/payments', auth, (req, res) => {
  const { month } = req.query;
  let query = `SELECT p.*, t.short_name, t.color, t.initials FROM payments p JOIN tenants t ON p.tenant_id = t.id`;
  const params = [];
  if (month) { query += ' WHERE p.month = ?'; params.push(month); }
  query += ' ORDER BY p.timestamp DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/payments', auth, (req, res) => {
  const { tenant_id, amount, type, month, note } = req.body;
  const result = db.prepare(`INSERT INTO payments (tenant_id, amount, type, month, note, confirmed) VALUES (?, ?, ?, ?, ?, 1)`).run(tenant_id, parseFloat(amount), type || 'rent', month, note || '');
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/payments/:id', auth, (req, res) => {
  const { amount, type, month, note } = req.body;
  db.prepare('UPDATE payments SET amount=?, type=?, month=?, note=? WHERE id=?').run(amount, type, month, note || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/payments/:id', auth, (req, res) => {
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── UTILITIES ────────────────────────────────────────────────
app.get('/api/utilities', auth, (req, res) => {
  res.json(db.prepare('SELECT id, type, total, tenant_share, period, notes, notified, receipt_url, timestamp FROM utility_bills ORDER BY timestamp DESC').all());
});

app.post('/api/utilities', auth, async (req, res) => {
  const { type, total, period, notes, receipt } = req.body;
  const rules = { water: 5, electricity: 3, gas: 3, internet: 3 };
  const divisor = rules[type] || 3;
  const share = parseFloat((parseFloat(total) / divisor).toFixed(2));
  let receipt_url = null;
  if (receipt && receipt.data) {
    const receiptId = Date.now();
    db.prepare('INSERT OR IGNORE INTO receipt_store (id, data, name, mime_type) VALUES (?, ?, ?, ?)').run(receiptId, receipt.data, receipt.name || 'receipt', receipt.type || 'application/octet-stream');
    receipt_url = `/receipt/${receiptId}`;
  }
  const result = db.prepare(`INSERT INTO utility_bills (type, total, tenant_share, period, notes, receipt_url) VALUES (?, ?, ?, ?, ?, ?)`).run(type, parseFloat(total), share, period || '', notes || '', receipt_url);
  res.json({ ok: true, id: result.lastInsertRowid, share, divisor });
});

app.get('/receipt/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM receipt_store WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).send('Not found');
    const base64Data = row.data.split(',')[1] || row.data;
    const buffer = Buffer.from(base64Data, 'base64');
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${row.name}"`);
    res.send(buffer);
  } catch (e) { res.status(404).send('Not found'); }
});

app.delete('/api/utilities/:id', auth, (req, res) => {
  db.prepare('DELETE FROM utility_bills WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/utilities/:id/notify', auth, async (req, res) => {
  const bill = db.prepare('SELECT * FROM utility_bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const typeLabels = { water: 'Water (÷5)', electricity: 'Electricity (÷3)', gas: 'Gas (÷3)', internet: 'Internet (÷3)' };
  const receiptPart = bill.receipt_url ? ` Receipt: https://${req.get('host')}${bill.receipt_url}` : '';
  const msg = `Hi, ${typeLabels[bill.type] || bill.type} bill for ${bill.period || 'current period'}: your share is $${bill.tenant_share.toFixed(2)} (total: $${bill.total.toFixed(2)}).${receiptPart} Please pay by the 5th. — 9 Quincy Management`;
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  for (const t of tenants) {
    await sendSMS(t.phone, msg);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'payment', 1)`).run(t.id, msg);
  }
  db.prepare('UPDATE utility_bills SET notified = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/utilities/notify-all', auth, async (req, res) => {
  const { period } = req.query;
  const bills = db.prepare('SELECT * FROM utility_bills WHERE period = ?').all(period);
  if (!bills.length) return res.status(404).json({ error: 'No bills found for period' });
  const typeLabels = { water: 'Water (÷5)', electricity: 'Electricity (÷3)', gas: 'Gas (÷3)', internet: 'Internet (÷3)' };
  const totalShare = bills.reduce((s, b) => s + b.tenant_share, 0);
  const breakdown = bills.map(b => `${typeLabels[b.type] || b.type}: $${b.tenant_share.toFixed(2)}`).join(', ');
  const receiptLinks = bills.filter(b => b.receipt_url).map(b => `https://${req.get('host')}${b.receipt_url}`).join(' ');
  const msg = `Hi, utilities for ${period} — ${breakdown}. Total per tenant: $${totalShare.toFixed(2)}.${receiptLinks ? ' Receipts: ' + receiptLinks : ''} Please pay by the 5th. — 9 Quincy Management`;
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  for (const t of tenants) {
    await sendSMS(t.phone, msg);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'payment', 1)`).run(t.id, msg);
  }
  db.prepare('UPDATE utility_bills SET notified = 1 WHERE period = ?').run(period);
  res.json({ ok: true });
});

// ─── AI DRAFT ─────────────────────────────────────────────────
app.post('/api/draft-message', auth, async (req, res) => {
  const { context, targetName } = req.body;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 400,
    messages: [{ role: 'user', content: `Draft a professional SMS to ${targetName} for a residential property manager. Context: ${context}. Keep under 5 sentences, warm and professional. Sign off as: — 9 Quincy Management. Output only the message text, no preamble.` }]
  });
  res.json({ draft: response.content[0].text.trim() });
});

// ─── PROVIDER MESSAGES ────────────────────────────────────────
app.get('/api/provider-messages', auth, (req, res) => {
  const { phone } = req.query;
  res.json(db.prepare('SELECT * FROM provider_messages WHERE provider_phone = ? ORDER BY timestamp ASC').all(phone));
});

app.post('/api/provider-send', auth, async (req, res) => {
  const { phone, content } = req.body;
  await sendSMS(phone, content);
  db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run(phone, 'outbound', content);
  res.json({ ok: true });
});

// ─── SCHEDULING ───────────────────────────────────────────────
app.delete('/api/scheduling/:id', auth, (req, res) => {
  db.prepare('DELETE FROM scheduling_jobs WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM scheduling_availability WHERE job_id = ?').run(req.params.id);
  db.prepare('DELETE FROM scheduled_reminders WHERE job_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/scheduling', auth, (req, res) => {
  const jobs = db.prepare(`SELECT * FROM scheduling_jobs ORDER BY created_at DESC LIMIT 20`).all();
  const jobsWithAvailability = jobs.map(j => ({
    ...j,
    proposed_slots: j.proposed_slots ? JSON.parse(j.proposed_slots) : [],
    availability: db.prepare('SELECT * FROM scheduling_availability WHERE job_id = ?').all(j.id),
  }));
  res.json(jobsWithAvailability);
});

app.post('/api/scheduling/start-manual', auth, async (req, res) => {
  const { type, notes, tenantMsg } = req.body;
  const providerMap = { cleaning: { name: 'Stanley', phone: '+12535188749' }, pest_control: { name: 'Mehmet', phone: '+12023897752' } };
  const provider = providerMap[type];
  const jobId = db.prepare(`INSERT INTO scheduling_jobs (type, provider_name, provider_phone, status, notes) VALUES (?, ?, ?, 'collecting_availability', ?)`).run(type, provider.name, provider.phone, notes || '').lastInsertRowid;
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  for (const t of tenants) {
    await sendSMS(t.phone, tenantMsg);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(t.id, tenantMsg);
    db.prepare(`INSERT INTO scheduling_availability (job_id, party, party_name, availability_text, status) VALUES (?, 'tenant', ?, 'pending', 'waiting')`).run(jobId, t.short_name);
  }
  await alertOwner(`📅 ${type === 'cleaning' ? 'Cleaning' : 'Pest Control'} scheduling started. Waiting for tenant availability. Job #${jobId}`);
  res.json({ ok: true, jobId });
});

app.post('/api/scheduling/notify-provider', auth, async (req, res) => {
  const { providerPhone, providerName, message, jobId } = req.body;
  await sendSMS(providerPhone, message);
  db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run(providerPhone, 'outbound', message);
  if (jobId) db.prepare('UPDATE scheduling_jobs SET provider_notified = 1 WHERE id = ?').run(jobId);
  res.json({ ok: true });
});

app.post('/api/scheduling/:id/approve', auth, async (req, res) => {
  const { slot } = req.body;
  const job = db.prepare('SELECT * FROM scheduling_jobs WHERE id = ?').get(req.params.id);
  db.prepare(`UPDATE scheduling_jobs SET confirmed_slot = ?, status = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(slot, req.params.id);
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  const typeLabel = job.type === 'cleaning' ? 'Cleaning' : 'Pest Control';
  const tenantMsg = `${typeLabel} has been scheduled for ${slot}. Please ensure unit access. A reminder will be sent the day before. Thank you! — 9 Quincy Management`;
  for (const t of tenants) {
    await sendSMS(t.phone, tenantMsg);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(t.id, tenantMsg);
  }
  if (job.type === 'pest_control') {
    const mehmetMsg = `Hi Mehmet, this is 9 Quincy Pl NE #2. We'd like to confirm pest control for ${slot}. Please confirm. Thank you!`;
    await sendSMS('+12023897752', mehmetMsg);
    db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run('+12023897752', 'outbound', mehmetMsg);
  }
  await alertOwner(`✅ ${typeLabel} confirmed for ${slot}. Tenants notified.`);
  res.json({ ok: true, slot });
});

app.post('/api/scheduling/:id/dazzling-confirm', auth, async (req, res) => {
  const { confirmation } = req.body;
  db.prepare(`UPDATE scheduling_jobs SET provider_confirmed = 1, updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  await alertOwner(`✅ Dazzling Cleaning confirmed: ${confirmation}`);
  res.json({ ok: true });
});

// ─── AGENT CONFIG ─────────────────────────────────────────────
app.get('/api/config', auth, (req, res) => res.json(getConfig()));

app.post('/api/config', auth, (req, res) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO agent_config (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
  Object.entries(req.body).forEach(([k, v]) => stmt.run(k, v));
  res.json({ ok: true });
});

// ─── TENANTS ──────────────────────────────────────────────────
app.get('/api/tenants', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tenants ORDER BY created_at').all());
});

app.post('/api/tenants', auth, (req, res) => {
  const { id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials } = req.body;
  db.prepare(`INSERT INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first || 0, color || '#185FA5', initials || name.slice(0, 2).toUpperCase());
  res.json({ ok: true });
});

app.patch('/api/tenants/:id', auth, (req, res) => {
  const updates = req.body;
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE tenants SET ${fields} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json({ ok: true });
});

// ─── SCHEDULED JOBS ───────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (tomorrow.getDate() === 1) { console.log('Sending rent reminders...'); await sendRentReminder(); }
  if (today.getDate() === 6) { console.log('Checking overdue rent...'); await checkOverdueRent(); }
});

// ─── ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));

app.listen(PORT, () => console.log(`9 Quincy Property Agent running on port ${PORT}`));
module.exports = app;
