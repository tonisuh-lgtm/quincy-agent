require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const db = require('./db');
const { handleInboundSMS, sendRentReminder, checkOverdueRent, sendSMS, alertOwner, sendConfirmedPreview, previewToOwner } = require('./twilio-handler');
const { getConfig, summarizeLease, extractUtilityTotal, answerUtilityQuestion } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'quincy2026';
const OWNER_PHONE = process.env.OWNER_PHONE;

app.use(cors());
app.use(bodyParser.urlencoded({ extended: false, limit: '15mb' }));
app.use(bodyParser.json({ limit: '15mb' }));
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
    const provider = db.prepare('SELECT * FROM service_providers WHERE phone = ? AND active = 1').get(from);
    if (provider) {
      db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run(from, 'inbound', body);
      const activeJob = db.prepare(`SELECT * FROM scheduling_jobs WHERE provider_phone = ? AND status IN ('confirmed','collecting_availability') ORDER BY created_at DESC LIMIT 1`).get(provider.phone);
      const jobRef = activeJob ? ` (Job #${activeJob.id})` : '';
      await alertOwner(`📞 ${provider.name}${jobRef}:\n"${body}"\n\nReply via dashboard → Scheduling`);
      const confirmWords = ['confirm', 'confirmed', 'yes', 'ok', 'works', 'see you', 'will be there', 'got it'];
      if (activeJob && confirmWords.some(w => body.toLowerCase().includes(w))) {
        db.prepare(`UPDATE scheduling_jobs SET provider_confirmed = 1, updated_at = datetime('now') WHERE id = ?`).run(activeJob.id);
        await alertOwner(`✅ ${provider.name} confirmed for ${activeJob.confirmed_slot}`);
      }
      return res.status(200).send('<Response></Response>');
    }

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
        const ack = `Thanks ${tenant.short_name}! We've noted your availability and will confirm shortly. — 9 Quincy Management`;
        await sendSMS(from, ack);
        db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(tenant.id, ack);
        const allWaiting = db.prepare(`SELECT COUNT(*) as count FROM scheduling_availability WHERE job_id = ? AND status = 'waiting'`).get(activeSchedulingJob.id).count;
        if (allWaiting === 0) {
          const avails = db.prepare('SELECT * FROM scheduling_availability WHERE job_id = ?').all(activeSchedulingJob.id);
          await alertOwner(`📅 All tenants responded for Job #${activeSchedulingJob.id}!\n${avails.map(a=>`${a.party_name}: ${a.availability_text}`).join('\n')}\n\nLog in to approve a time slot.`);
        }
        return res.status(200).send('<Response></Response>');
      }
      await handleInboundSMS(from, body);
    } else {
      await alertOwner(`⚠️ Unknown number: ${from}\n"${body}"`);
      await sendSMS(from, 'Thank you for reaching out to 9 Quincy Property Management. We\'ll be in touch shortly. — 9 Quincy Management');
    }
  } catch (err) { console.error('Webhook error:', err); }

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
  const today = new Date();
  const dayOfMonth = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  const summary = tenants.map(t => {
    const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE tenant_id = ? AND month = ? AND type = 'rent'`).get(t.id, currentMonth).total;
    const lastMsg = db.prepare(`SELECT * FROM conversations WHERE tenant_id = ? ORDER BY timestamp DESC LIMIT 1`).get(t.id);
    const hasLease = db.prepare(`SELECT COUNT(*) as count FROM lease_documents WHERE tenant_id = ? AND active = 1`).get(t.id).count > 0;
    const balance = Math.max(0, t.rent - paid);

    // Rent clock: due the 1st, 5-day grace, 10% late fee after
    let clock = null;
    if (balance > 0) {
      if (dayOfMonth === 1) clock = { text: 'Due today', tone: 'amber' };
      else if (dayOfMonth <= 5) clock = { text: `${6 - dayOfMonth} day${6 - dayOfMonth === 1 ? '' : 's'} left in grace period`, tone: 'amber' };
      else {
        const daysLate = dayOfMonth - 5;
        const fee = Math.min(balance * 0.1, t.rent * 0.1);
        clock = { text: `${daysLate} day${daysLate === 1 ? '' : 's'} past grace · $${fee.toFixed(2)} late fee applies`, tone: 'red', lateFee: parseFloat(fee.toFixed(2)) };
      }
    } else {
      const daysUntilDue = daysInMonth - dayOfMonth + 1;
      clock = { text: daysUntilDue <= 7 ? `Next rent due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}` : 'Paid in full', tone: 'green' };
    }

    // Lease end countdown, including the 40-day non-renewal notice deadline
    let leaseClock = null;
    if (t.lease_end) {
      const end = new Date(t.lease_end + 'T12:00:00');
      const daysToEnd = Math.ceil((end - today) / 86400000);
      const daysToNoticeDeadline = daysToEnd - 40;
      if (daysToEnd > 0 && daysToEnd <= 120) {
        leaseClock = daysToNoticeDeadline > 0
          ? { text: `Lease ends in ${daysToEnd} days · ${daysToNoticeDeadline} days to send non-renewal notice`, tone: daysToNoticeDeadline <= 21 ? 'red' : 'amber' }
          : { text: `Lease ends in ${daysToEnd} days · 40-day notice window has passed`, tone: 'red' };
      }
    }

    return { ...t, paid_this_month: paid, balance_due: balance, last_message: lastMsg, has_lease: hasLease, clock, leaseClock };
  });
  const unread = db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE needs_review = 1 AND reviewed = 0`).get().count;
  const complaints = db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE category = 'complaint' AND resolved = 0 AND direction = 'inbound'`).get().count;
  const pendingScheduling = db.prepare(`SELECT COUNT(*) as count FROM scheduling_jobs WHERE status NOT IN ('completed','cancelled')`).get().count;
  const pendingPreviews = db.prepare(`SELECT COUNT(*) as count FROM message_previews WHERE status = 'pending'`).get().count;
  const openIncidents = db.prepare(`SELECT COUNT(*) as count FROM incidents WHERE resolved = 0`).get().count;
  const activeMoveouts = db.prepare(`SELECT COUNT(*) as count FROM moveouts WHERE status != 'closed'`).get().count;
  res.json({ tenants: summary, unread, complaints, pendingScheduling, pendingPreviews, openIncidents, activeMoveouts, currentMonth });
});

// ─── MESSAGE PREVIEWS ─────────────────────────────────────────
app.get('/api/previews', auth, (req, res) => {
  const previews = db.prepare(`SELECT p.*, t.short_name, t.color, t.initials FROM message_previews p LEFT JOIN tenants t ON p.tenant_id = t.id WHERE p.status = 'pending' ORDER BY p.created_at DESC`).all();
  res.json(previews);
});

app.post('/api/previews/:id/confirm', auth, async (req, res) => {
  await sendConfirmedPreview(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/previews/:id/cancel', auth, (req, res) => {
  db.prepare(`UPDATE message_previews SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// Send preview to owner number first, then save for dashboard approval
app.post('/api/previews/create', auth, async (req, res) => {
  const { tenant_id, content, type } = req.body;
  const tenant = tenant_id ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id) : null;
  const tenantName = tenant ? tenant.short_name : 'All tenants';

  // Send preview SMS to owner
  await previewToOwner(content, tenantName, type || 'Message');

  // Save for dashboard confirmation
  const result = db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES (?, ?, ?, 'pending')`).run(type || 'broadcast', tenant_id || null, content);
  res.json({ ok: true, id: result.lastInsertRowid });
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
  res.json(db.prepare('SELECT id, type, total, tenant_share, owner_share, downstairs_share, period, notes, notified, receipt_url, timestamp FROM utility_bills ORDER BY timestamp DESC').all());
});

app.post('/api/utilities/extract', auth, async (req, res) => {
  const { data, type, name } = req.body;
  const extracted = await extractUtilityTotal(data, type, name);
  res.json({ ok: true, extracted });
});

app.post('/api/utilities', auth, async (req, res) => {
  const { type, total, period, notes, receipt } = req.body;
  const tenantCount = db.prepare('SELECT COUNT(*) as count FROM tenants WHERE active = 1').get().count;
  const divisors = { water: 5, electricity: 3, gas: 3, internet: 3 };
  const divisor = divisors[type] || 3;
  const tenantShare = parseFloat((parseFloat(total) / divisor).toFixed(2));
  const ownerShare = tenantShare;
  const downstairsShare = type === 'water' ? parseFloat((parseFloat(total) * 2 / 5).toFixed(2)) : 0;

  let receipt_url = null;
  let receipt_data = null;
  let receipt_text = null;

  if (receipt && receipt.data) {
    const receiptId = Date.now();
    const rawData = receipt.data.split(',')[1] || receipt.data;
    db.prepare('INSERT OR IGNORE INTO receipt_store (id, data, name, mime_type) VALUES (?, ?, ?, ?)').run(receiptId, rawData, receipt.name || 'receipt', receipt.type || 'application/octet-stream');
    receipt_url = `/receipt/${receiptId}`;
    receipt_data = rawData;
  }

  const result = db.prepare(`INSERT INTO utility_bills (type, total, tenant_share, owner_share, downstairs_share, period, notes, receipt_url, receipt_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    type, parseFloat(total), tenantShare, ownerShare, downstairsShare, period || '', notes || '', receipt_url, receipt_data
  );

  res.json({ ok: true, id: result.lastInsertRowid, tenantShare, ownerShare, downstairsShare, divisor });
});

app.get('/receipt/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM receipt_store WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).send('Not found');
    const buffer = Buffer.from(row.data, 'base64');
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
  const typeLabels = { water: 'Water', electricity: 'Electricity', gas: 'Gas', internet: 'Internet' };
  const receiptPart = bill.receipt_url ? ` Receipt: https://${req.get('host')}${bill.receipt_url}` : '';
  const msg = `Hi, ${typeLabels[bill.type] || bill.type} bill for ${bill.period || 'current period'}: your share is $${bill.tenant_share.toFixed(2)} (total: $${bill.total.toFixed(2)}).${receiptPart} Due the 1st. — 9 Quincy Management`;

  // Preview to owner first
  await previewToOwner(msg, 'all tenants', 'Utility Notice');
  const result = db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status, ref_id) VALUES ('utility_notice', NULL, ?, 'pending', ?)`).run(msg, bill.id);
  res.json({ ok: true, previewId: result.lastInsertRowid });
});

app.post('/api/utilities/notify-all', auth, async (req, res) => {
  const { period } = req.query;
  const bills = db.prepare('SELECT * FROM utility_bills WHERE period = ?').all(period);
  if (!bills.length) return res.status(404).json({ error: 'No bills found' });

  const typeLabels = { water: 'Water', electricity: 'Electricity', gas: 'Gas', internet: 'Internet' };
  const totalShare = bills.reduce((s, b) => s + b.tenant_share, 0);
  const breakdown = bills.map(b => `${typeLabels[b.type]||b.type}: $${b.tenant_share.toFixed(2)}`).join(', ');
  const receiptLinks = bills.filter(b => b.receipt_url).map(b => `https://${req.get('host')}${b.receipt_url}`).join(' ');
  const msg = `Hi, utilities for ${period}: ${breakdown}. Total per tenant: $${totalShare.toFixed(2)}.${receiptLinks ? ' Receipts: ' + receiptLinks : ''} Due the 1st. — 9 Quincy Management`;

  await previewToOwner(msg, 'all tenants', 'Utility Summary');
  const result = db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES ('utility_notice', NULL, ?, 'pending')`).run(msg);
  res.json({ ok: true, previewId: result.lastInsertRowid, message: msg });
});

// ─── LEASE DOCUMENTS ──────────────────────────────────────────
app.get('/api/leases', auth, (req, res) => {
  const { tenant_id } = req.query;
  let query = `SELECT id, tenant_id, filename, summary, active, uploaded_at FROM lease_documents`;
  const params = [];
  if (tenant_id) { query += ' WHERE tenant_id = ?'; params.push(tenant_id); }
  query += ' ORDER BY uploaded_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.post('/api/leases', auth, async (req, res) => {
  const { tenant_id, filename, data, mime_type } = req.body;
  if (!tenant_id || !data) return res.status(400).json({ error: 'Missing required fields' });

  // Deactivate previous leases for this tenant
  db.prepare(`UPDATE lease_documents SET active = 0 WHERE tenant_id = ?`).run(tenant_id);

  // Summarize the lease
  const rawData = data.split(',')[1] || data;
  const summary = await summarizeLease(rawData, filename);

  const result = db.prepare(`INSERT INTO lease_documents (tenant_id, filename, data, mime_type, summary, active) VALUES (?, ?, ?, ?, ?, 1)`).run(
    tenant_id, filename || 'lease.pdf', rawData, mime_type || 'application/pdf', summary
  );

  res.json({ ok: true, id: result.lastInsertRowid, summary });
});

app.patch('/api/leases/:id/activate', auth, (req, res) => {
  const lease = db.prepare('SELECT * FROM lease_documents WHERE id = ?').get(req.params.id);
  if (!lease) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE lease_documents SET active = 0 WHERE tenant_id = ?`).run(lease.tenant_id);
  db.prepare(`UPDATE lease_documents SET active = 1 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/leases/:id', auth, (req, res) => {
  db.prepare('DELETE FROM lease_documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── NOTICE TEMPLATES ─────────────────────────────────────────
const NOTICE_TEMPLATES = {
  entry_notice: {
    label: '24-Hour Entry Notice',
    fields: ['date', 'time', 'reason'],
    build: (t, f) => `Hi ${t.short_name}, this is written notice that the owner or an authorized representative will enter the unit on ${f.date} at approximately ${f.time} for the following purpose: ${f.reason}. This notice is provided per Paragraph 29 of your lease. You do not need to be present. Please reply if this timing creates a serious conflict. — 9 Quincy Management`
  },
  late_rent: {
    label: 'Late Rent Notice',
    fields: ['amount', 'lateFee', 'month'],
    build: (t, f) => `Hi ${t.short_name}, our records show rent for ${f.month} has not been received in full. Outstanding balance: $${f.amount}. Per Paragraph 6 of your lease, a late fee of $${f.lateFee} applies as the balance was not cleared by the 5th. Total now due: $${(parseFloat(f.amount) + parseFloat(f.lateFee)).toFixed(2)}. Please send via ${t.payment_method} and confirm here. — 9 Quincy Management`
  },
  utility_due: {
    label: 'Utility Payment Due',
    fields: ['amount', 'period'],
    build: (t, f) => `Hi ${t.short_name}, your utility share for ${f.period} is $${f.amount}. Utilities are treated as rent under Paragraph 7 of your lease and are due the 1st. Please send via ${t.payment_method} and confirm here. Bills are available on request. — 9 Quincy Management`
  },
  lease_violation: {
    label: 'Lease Violation Notice',
    fields: ['violation', 'paragraph', 'remedy'],
    build: (t, f) => `Hi ${t.short_name}, this is a formal notice regarding the following: ${f.violation}. This is a violation of Paragraph ${f.paragraph} of your lease. Required action: ${f.remedy}. Please confirm receipt of this notice. Continued noncompliance may be treated as a material violation of the lease. — 9 Quincy Management`
  },
  quiet_hours: {
    label: 'Noise / Quiet Hours Notice',
    fields: ['date', 'detail'],
    build: (t, f) => `Hi ${t.short_name}, we received a noise report regarding ${f.date}. ${f.detail} Please be mindful of quiet hours and of neighboring units. Repeated noise issues may be treated as a lease violation. Thank you for your cooperation. — 9 Quincy Management`
  },
  non_renewal: {
    label: 'Non-Renewal Notice',
    fields: ['leaseEnd'],
    build: (t, f) => `Hi ${t.short_name}, this is formal written notice that your lease will not be renewed beyond ${f.leaseEnd}. Per Paragraph 3 of your lease, this notice is provided at least 40 days in advance. Please plan to vacate the unit by that date and provide a forwarding address for your security deposit. We'll follow up with move-out details. — 9 Quincy Management`
  },
  moveout_reminder: {
    label: 'Move-Out Instructions',
    fields: ['moveoutDate'],
    build: (t, f) => `Hi ${t.short_name}, a reminder that your move-out date is ${f.moveoutDate}. Please: (1) remove all personal belongings, (2) leave the room and shared areas clean, (3) return all keys, (4) provide a written forwarding address. Your final utility cycle remains payable. The security deposit will be accounted for after inspection per your lease. — 9 Quincy Management`
  },
  rent_reminder: {
    label: 'Friendly Rent Reminder',
    fields: ['amount', 'month'],
    build: (t, f) => `Hi ${t.short_name}, friendly reminder that rent of $${f.amount} for ${f.month} is due on the 1st. Please send via ${t.payment_method} and confirm here. Thank you! — 9 Quincy Management`
  },
};

app.get('/api/notices/templates', auth, (req, res) => {
  res.json(Object.entries(NOTICE_TEMPLATES).map(([key, t]) => ({ key, label: t.label, fields: t.fields })));
});

app.post('/api/notices/build', auth, (req, res) => {
  const { template, tenant_id, fields } = req.body;
  const tpl = NOTICE_TEMPLATES[template];
  if (!tpl) return res.status(400).json({ error: 'Unknown template' });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  res.json({ ok: true, content: tpl.build(tenant, fields || {}), label: tpl.label });
});

// Build a notice, preview it to the owner's phone, and queue it for confirmation
app.post('/api/notices/send', auth, async (req, res) => {
  const { template, tenant_id, fields, content, logIncident } = req.body;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const tpl = NOTICE_TEMPLATES[template];
  const body = content || (tpl ? tpl.build(tenant, fields || {}) : null);
  if (!body) return res.status(400).json({ error: 'No content' });

  await previewToOwner(body, tenant.short_name, tpl ? tpl.label : 'Notice');
  const result = db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES (?, ?, ?, 'pending')`).run(template || 'notice', tenant_id, body);

  // Optionally create a matching incident record so the notice is part of the paper trail
  if (logIncident && tpl) {
    db.prepare(`INSERT INTO incidents (tenant_id, incident_date, category, severity, title, description, lease_reference, action_taken) VALUES (?, date('now'), 'notice', 'minor', ?, ?, ?, 'Written notice issued')`).run(
      tenant_id, tpl.label, body, fields && fields.paragraph ? `Paragraph ${fields.paragraph}` : ''
    );
  }

  res.json({ ok: true, id: result.lastInsertRowid, content: body });
});

// ─── INCIDENTS ────────────────────────────────────────────────
app.get('/api/incidents', auth, (req, res) => {
  const { tenant_id } = req.query;
  let q = `SELECT i.id, i.tenant_id, i.incident_date, i.category, i.severity, i.title, i.description, i.lease_reference, i.action_taken, i.photo_name, i.resolved, i.created_at, t.short_name, t.color, t.initials FROM incidents i LEFT JOIN tenants t ON i.tenant_id = t.id`;
  const params = [];
  if (tenant_id) { q += ' WHERE i.tenant_id = ?'; params.push(tenant_id); }
  q += ' ORDER BY i.incident_date DESC, i.id DESC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/incidents', auth, (req, res) => {
  const { tenant_id, incident_date, category, severity, title, description, lease_reference, action_taken, photo } = req.body;
  if (!title || !incident_date) return res.status(400).json({ error: 'Title and date required' });
  let photoData = null, photoName = null;
  if (photo && photo.data) { photoData = photo.data.split(',')[1] || photo.data; photoName = photo.name || 'photo'; }
  const result = db.prepare(`INSERT INTO incidents (tenant_id, incident_date, category, severity, title, description, lease_reference, action_taken, photo_data, photo_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    tenant_id || null, incident_date, category || 'other', severity || 'minor', title, description || '', lease_reference || '', action_taken || '', photoData, photoName
  );
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/incidents/:id', auth, (req, res) => {
  const allowed = ['incident_date','category','severity','title','description','lease_reference','action_taken','resolved'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE incidents SET ${fields} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/incidents/:id', auth, (req, res) => {
  db.prepare('DELETE FROM incidents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/incidents/:id/photo', (req, res) => {
  const row = db.prepare('SELECT photo_data, photo_name FROM incidents WHERE id = ?').get(req.params.id);
  if (!row || !row.photo_data) return res.status(404).send('Not found');
  res.set('Content-Type', 'image/jpeg');
  res.send(Buffer.from(row.photo_data, 'base64'));
});

// Export the full incident history for one tenant as plain text evidence
app.get('/api/incidents/export', auth, (req, res) => {
  const { tenant_id } = req.query;
  const tenant = tenant_id ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id) : null;
  const rows = tenant_id
    ? db.prepare('SELECT * FROM incidents WHERE tenant_id = ? ORDER BY incident_date').all(tenant_id)
    : db.prepare('SELECT * FROM incidents ORDER BY incident_date').all();

  let out = `INCIDENT LOG\n9 Quincy Pl NE #2, Washington DC 20002\nOwner: Dongyeon Suh / Eastring LLC\n`;
  out += tenant ? `Tenant: ${tenant.name}\n` : `All tenants\n`;
  out += `Generated: ${new Date().toISOString().slice(0,10)}\n\n${'='.repeat(60)}\n\n`;
  rows.forEach((r, i) => {
    out += `${i+1}. ${r.incident_date} — ${r.title}\n`;
    out += `   Category: ${r.category} | Severity: ${r.severity}\n`;
    if (r.lease_reference) out += `   Lease reference: ${r.lease_reference}\n`;
    if (r.description) out += `   Details: ${r.description}\n`;
    if (r.action_taken) out += `   Action taken: ${r.action_taken}\n`;
    if (r.photo_name) out += `   Photo on file: ${r.photo_name}\n`;
    out += `   Status: ${r.resolved ? 'Resolved' : 'Open'}\n\n`;
  });
  out += `${'='.repeat(60)}\nTotal entries: ${rows.length}\n`;
  res.set('Content-Type', 'text/plain');
  res.set('Content-Disposition', `attachment; filename="incident-log-${tenant_id||'all'}.txt"`);
  res.send(out);
});

// ─── MOVE-OUT ─────────────────────────────────────────────────
app.get('/api/moveouts', auth, (req, res) => {
  const rows = db.prepare(`SELECT m.*, t.short_name, t.name, t.color, t.initials, t.deposit as tenant_deposit FROM moveouts m JOIN tenants t ON m.tenant_id = t.id ORDER BY m.moveout_date DESC`).all();
  const today = new Date();
  res.json(rows.map(m => {
    const deductions = m.deductions ? JSON.parse(m.deductions) : [];
    const deductTotal = deductions.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
    const owedBack = Math.max(0, (m.deposit_amount || 0) - deductTotal - (m.final_utilities || 0));

    // 45-day deposit clock runs from the later of move-out or inspection completion
    let depositClock = null;
    if (m.status !== 'closed') {
      const anchor = m.inspection_date ? new Date(m.inspection_date + 'T12:00:00') : new Date(m.moveout_date + 'T12:00:00');
      const deadline = new Date(anchor.getTime() + 45 * 86400000);
      const daysLeft = Math.ceil((deadline - today) / 86400000);
      depositClock = {
        deadline: deadline.toISOString().slice(0, 10),
        daysLeft,
        tone: daysLeft < 0 ? 'red' : daysLeft <= 10 ? 'amber' : 'green',
        text: daysLeft < 0 ? `Deposit deadline passed ${Math.abs(daysLeft)} days ago` : `${daysLeft} days to return deposit`
      };
    }
    return { ...m, deductions, deductTotal: parseFloat(deductTotal.toFixed(2)), owedBack: parseFloat(owedBack.toFixed(2)), depositClock };
  }));
});

app.post('/api/moveouts', auth, (req, res) => {
  const { tenant_id, moveout_date, notice_received_date, deposit_amount } = req.body;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant_id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const result = db.prepare(`INSERT INTO moveouts (tenant_id, moveout_date, notice_received_date, deposit_amount, deductions, status) VALUES (?, ?, ?, ?, '[]', 'upcoming')`).run(
    tenant_id, moveout_date || tenant.lease_end, notice_received_date || null, deposit_amount != null ? deposit_amount : (tenant.deposit || 0)
  );
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/moveouts/:id', auth, (req, res) => {
  const allowed = ['moveout_date','notice_received_date','inspection_date','inspection_notes','deposit_amount','deductions','final_utilities','amount_returned','forwarding_address','status','returned_date'];
  const updates = {};
  Object.entries(req.body).forEach(([k, v]) => {
    if (!allowed.includes(k)) return;
    updates[k] = k === 'deductions' && typeof v !== 'string' ? JSON.stringify(v) : v;
  });
  if (!Object.keys(updates).length) return res.json({ ok: true });
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE moveouts SET ${fields} WHERE id = ?`).run(...Object.values(updates), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/moveouts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM moveouts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Itemized deposit accounting statement the tenant can be sent
app.get('/api/moveouts/:id/statement', auth, (req, res) => {
  const m = db.prepare(`SELECT m.*, t.name, t.short_name FROM moveouts m JOIN tenants t ON m.tenant_id = t.id WHERE m.id = ?`).get(req.params.id);
  if (!m) return res.status(404).send('Not found');
  const deductions = m.deductions ? JSON.parse(m.deductions) : [];
  const deductTotal = deductions.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const owedBack = Math.max(0, (m.deposit_amount || 0) - deductTotal - (m.final_utilities || 0));

  let out = `SECURITY DEPOSIT ACCOUNTING STATEMENT\n\n`;
  out += `Property: 9 Quincy Pl NE #2, Washington DC 20002\n`;
  out += `Owner: Dongyeon Suh / Eastring LLC\n`;
  out += `Tenant: ${m.name}\n`;
  out += `Move-out date: ${m.moveout_date}\n`;
  if (m.inspection_date) out += `Inspection completed: ${m.inspection_date}\n`;
  out += `Statement date: ${new Date().toISOString().slice(0,10)}\n\n${'='.repeat(55)}\n\n`;
  out += `Security deposit held:${' '.repeat(20)}$${(m.deposit_amount||0).toFixed(2)}\n\n`;
  out += `DEDUCTIONS\n`;
  if (deductions.length) deductions.forEach(d => { out += `  ${d.description}${' '.repeat(Math.max(1, 38 - String(d.description).length))}-$${parseFloat(d.amount||0).toFixed(2)}\n`; });
  else out += `  None\n`;
  if (m.final_utilities > 0) out += `  Final billing cycle utilities${' '.repeat(11)}-$${m.final_utilities.toFixed(2)}\n`;
  out += `\n  Total deductions:${' '.repeat(22)}-$${(deductTotal + (m.final_utilities||0)).toFixed(2)}\n`;
  out += `\n${'='.repeat(55)}\n`;
  out += `AMOUNT TO BE RETURNED:${' '.repeat(18)}$${owedBack.toFixed(2)}\n`;
  out += `${'='.repeat(55)}\n\n`;
  if (m.inspection_notes) out += `INSPECTION NOTES\n${m.inspection_notes}\n\n`;
  if (m.forwarding_address) out += `Forwarding address:\n${m.forwarding_address}\n\n`;
  out += `This statement is provided in accordance with the lease agreement and applicable District of Columbia law.\n`;
  res.set('Content-Type', 'text/plain');
  res.set('Content-Disposition', `attachment; filename="deposit-statement-${m.short_name}.txt"`);
  res.send(out);
});

// ─── AI DRAFT ─────────────────────────────────────────────────
app.post('/api/draft-message', auth, async (req, res) => {
  const { context, targetName } = req.body;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 400,
    messages: [{ role: 'user', content: `Draft a professional SMS to ${targetName} for a residential property manager. Context: ${context}. Keep under 5 sentences, warm and professional. Sign off as: — 9 Quincy Management. Output only the message text.` }]
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
  res.json(jobs.map(j => ({ ...j, proposed_slots: j.proposed_slots ? JSON.parse(j.proposed_slots) : [], availability: db.prepare('SELECT * FROM scheduling_availability WHERE job_id = ?').all(j.id) })));
});

app.post('/api/scheduling/start-manual', auth, async (req, res) => {
  const { type, notes, tenantMsg } = req.body;
  const providerMap = { cleaning: { name: 'Stanley', phone: '+12535188749' }, pest_control: { name: 'Mehmet', phone: '+12023897752' } };
  const provider = providerMap[type];
  const jobId = db.prepare(`INSERT INTO scheduling_jobs (type, provider_name, provider_phone, status, notes) VALUES (?, ?, ?, 'collecting_availability', ?)`).run(type, provider.name, provider.phone, notes || '').lastInsertRowid;
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();

  // Preview to owner first
  await previewToOwner(tenantMsg, 'all tenants', 'Scheduling');
  const previewId = db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status, ref_id) VALUES ('scheduling', NULL, ?, 'pending', ?)`).run(tenantMsg, jobId).lastInsertRowid;

  for (const t of tenants) {
    db.prepare(`INSERT INTO scheduling_availability (job_id, party, party_name, availability_text, status) VALUES (?, 'tenant', ?, 'pending', 'waiting')`).run(jobId, t.short_name);
  }

  await alertOwner(`📅 ${type === 'cleaning' ? 'Cleaning' : 'Pest Control'} scheduling ready. Review dashboard to send availability request to tenants. Job #${jobId}`);
  res.json({ ok: true, jobId, previewId });
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
  const tenantMsg = `${typeLabel} has been scheduled for ${slot}. Please ensure unit access. A reminder will be sent the day before. — 9 Quincy Management`;

  await previewToOwner(tenantMsg, 'all tenants', 'Scheduling Confirmation');
  db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status, ref_id) VALUES ('scheduling', NULL, ?, 'pending', ?)`).run(tenantMsg, job.id);

  if (job.type === 'pest_control') {
    const mehmetMsg = `Hi Mehmet, this is 9 Quincy Pl NE #2. Confirming pest control for ${slot}. Please confirm. Thank you!`;
    await sendSMS('+12023897752', mehmetMsg);
    db.prepare('INSERT INTO provider_messages (provider_phone, direction, content) VALUES (?, ?, ?)').run('+12023897752', 'outbound', mehmetMsg);
  }

  await alertOwner(`✅ ${typeLabel} confirmed for ${slot}. Preview sent to dashboard for tenant notification approval.`);
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
  const stmt = db.prepare(`INSERT OR REPLACE INTO agent_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`);
  Object.entries(req.body).forEach(([k, v]) => stmt.run(k, v));
  res.json({ ok: true });
});

// ─── TENANTS ──────────────────────────────────────────────────
app.get('/api/tenants', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tenants ORDER BY created_at').all());
});

app.post('/api/tenants', auth, (req, res) => {
  const { id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials } = req.body;
  db.prepare(`INSERT INTO tenants (id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first, color, initials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, name, short_name, phone, payment_method, rent, deposit, lease_start, lease_end, prorated_first || 0, color || '#185FA5', initials || name.slice(0, 2).toUpperCase()
  );
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
  if (tomorrow.getDate() === 1) { console.log('Queuing rent reminders...'); await sendRentReminder(); }
  if (today.getDate() === 6) { console.log('Checking overdue rent...'); await checkOverdueRent(); }
});

// ─── ROUTES ───────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/landing.html')));

app.listen(PORT, () => console.log(`9 Quincy Property Agent running on port ${PORT}`));
module.exports = app;
