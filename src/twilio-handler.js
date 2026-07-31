const twilio = require('twilio');
const db = require('./db');
const { classifyMessage, generateResponse, shouldEscalate, generateOwnerSummary, checkEscalation, getConfig } = require('./agent');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const OWNER_PHONE = process.env.OWNER_PHONE;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

// Returns true if the current time falls inside configured quiet hours (US Eastern)
function isQuietHours() {
  const config = getConfig();
  if (config.quiet_hours_enabled !== '1') return false;
  const start = parseInt(config.quiet_hours_start || '21');
  const end = parseInt(config.quiet_hours_end || '8');
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end);
}

// Resolve a phone number to a human name so the log is readable
function whoIs(number) {
  if (number === OWNER_PHONE) return { name: 'You (owner)', kind: 'owner' };
  const t = db.prepare('SELECT short_name FROM tenants WHERE phone = ?').get(number);
  if (t) return { name: t.short_name, kind: 'tenant' };
  const p = db.prepare('SELECT short_name FROM service_providers WHERE phone = ?').get(number);
  if (p) return { name: p.short_name, kind: 'provider' };
  return { name: 'Unknown number', kind: 'unknown' };
}

// Single record of every message that leaves or enters the system
function logMessage({ direction, number, body, status, error, source }) {
  try {
    const who = whoIs(number);
    db.prepare(`INSERT INTO message_log (direction, to_number, recipient_name, recipient_kind, body, status, error, trigger_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      direction, number, who.name, who.kind, body, status || 'sent', error || null, source || null
    );
  } catch (e) { console.error('Log write failed:', e.message); }
}

async function sendSMS(to, body, source) {
  const chunks = [];
  let text = body;
  while (text.length > 300) {
    const split = text.lastIndexOf(' ', 300);
    chunks.push(text.slice(0, split > 0 ? split : 300));
    text = text.slice(split > 0 ? split + 1 : 300);
  }
  chunks.push(text);
  try {
    for (const chunk of chunks) {
      await client.messages.create({ from: FROM_NUMBER, to, body: chunk });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
    }
    logMessage({ direction: 'outbound', number: to, body, status: 'sent', source });
  } catch (e) {
    logMessage({ direction: 'outbound', number: to, body, status: 'failed', error: e.message, source });
    throw e;
  }
}

async function alertOwner(message, source) {
  try {
    await client.messages.create({ from: FROM_NUMBER, to: OWNER_PHONE, body: message });
    logMessage({ direction: 'outbound', number: OWNER_PHONE, body: message, status: 'sent', source: source || 'owner alert' });
  } catch (e) {
    console.error('Owner alert failed:', e.message);
    logMessage({ direction: 'outbound', number: OWNER_PHONE, body: message, status: 'failed', error: e.message, source: source || 'owner alert' });
  }
}

// Preview message to owner before sending to tenant
async function previewToOwner(content, tenantName, type) {
  const preview = `PREVIEW (${type} to ${tenantName}):\n\n${content}\n\nLog in to dashboard to confirm or cancel.`;
  await alertOwner(preview);
}

async function handleInboundSMS(from, body) {
  logMessage({ direction: 'inbound', number: from, body, status: 'received', source: 'tenant reply' });
  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND active = 1').get(from);

  if (!tenant) {
    await alertOwner(`⚠️ Unknown number: ${from}\n"${body}"`);
    await sendSMS(from, 'Thank you for reaching out to 9 Quincy Property Management. We\'ll be in touch shortly. — 9 Quincy Management');
    return;
  }

  const history = db.prepare(`SELECT * FROM conversations WHERE tenant_id = ? AND status = 'open' ORDER BY timestamp DESC LIMIT 10`).all(tenant.id).reverse();
  const inserted = db.prepare(`INSERT INTO conversations (tenant_id, direction, content, needs_review) VALUES (?, 'inbound', ?, 0)`).run(tenant.id, body);
  const msgId = inserted.lastInsertRowid;

  const classification = await classifyMessage(body, tenant.short_name);
  db.prepare(`UPDATE conversations SET urgency = ?, category = ?, agent_classified = 1 WHERE id = ?`).run(classification.urgency, classification.category, msgId);

  // Escalate-only topics: the agent must not take a position. Acknowledge and route to owner.
  const esc = await checkEscalation(body);
  if (esc.escalate && classification.urgency !== 'emergency') {
    const config = getConfig();
    const holdReply = config.escalate_response || 'Thanks for raising this. The landlord will review and follow up with you directly. — 9 Quincy Management';
    await sendSMS(from, holdReply);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, urgency, category, agent_classified) VALUES (?, 'outbound', ?, ?, ?, 1)`).run(tenant.id, holdReply, classification.urgency, classification.category);
    db.prepare('UPDATE conversations SET needs_review = 1 WHERE id = ?').run(msgId);
    await alertOwner(`🔴 ESCALATED — ${tenant.short_name}\nReason: ${esc.reason || 'protected topic'}\n\n"${body}"\n\nThe agent did NOT answer. It told them you'll follow up. Reply from the dashboard.`);
    return;
  }

  const agentReply = await generateResponse(tenant, history, body, classification);

  // Quiet hours: hold non-emergency replies until morning rather than texting overnight
  if (isQuietHours() && classification.urgency !== 'emergency') {
    db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES ('quiet_hours_hold', ?, ?, 'pending')`).run(tenant.id, agentReply);
    db.prepare('UPDATE conversations SET needs_review = 1 WHERE id = ?').run(msgId);
    await alertOwner(`🌙 Quiet hours — reply to ${tenant.short_name} held.\n\nTheir message: "${body}"\n\nDrafted reply is waiting in Previews. It will not send until you confirm.`);
    return;
  }

  db.prepare(`INSERT INTO conversations (tenant_id, direction, content, urgency, category, agent_classified) VALUES (?, 'outbound', ?, ?, ?, 1)`).run(tenant.id, agentReply, classification.urgency, classification.category);

  await sendSMS(from, agentReply);

  const allHistory = [...history, { direction: 'inbound', content: body }];
  const shouldAlert = classification.urgency === 'emergency' || classification.urgency === 'urgent' || await shouldEscalate(allHistory, classification.category);

  if (shouldAlert) {
    const urgencyEmoji = { emergency: '🚨', urgent: '⚠️', routine: '📋' };
    const summary = await generateOwnerSummary(tenant, allHistory, classification);
    db.prepare('UPDATE conversations SET needs_review = 1 WHERE id = ?').run(msgId);
    await alertOwner(`${urgencyEmoji[classification.urgency]} ${classification.urgency.toUpperCase()} — ${tenant.short_name}\n${classification.summary}\n\n${summary}\n\nReview: /app`);
  }

  const paymentKeywords = ['paid', 'sent', 'payment', 'venmo', 'zelle', 'apple pay', 'transferred'];
  if (paymentKeywords.some(kw => body.toLowerCase().includes(kw))) {
    await alertOwner(`💰 Payment mention from ${tenant.short_name}:\n"${body}"\n\nLog in dashboard to confirm.`);
  }
}

async function sendRentReminder() {
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayName = tomorrow.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  for (const tenant of tenants) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const paid = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE tenant_id = ? AND month = ? AND type = 'rent'`).get(tenant.id, currentMonth).total;
    const owed = tenant.rent - paid;
    if (owed <= 0) continue;

    const msg = `Hi ${tenant.short_name}, friendly reminder that rent of $${owed.toFixed(2)} is due tomorrow, ${dayName}. Please send via ${tenant.payment_method} and confirm here. — 9 Quincy Management`;

    // Preview to owner first
    await previewToOwner(msg, tenant.short_name, 'Rent Reminder');

    // Save as pending preview
    db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES ('rent_reminder', ?, ?, 'pending')`).run(tenant.id, msg);
  }
}

async function checkOverdueRent() {
  const today = new Date();
  if (today.getDate() <= 5) return;
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  const currentMonth = today.toISOString().slice(0, 7);

  for (const tenant of tenants) {
    const paid = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE tenant_id = ? AND month = ? AND type = 'rent'`).get(tenant.id, currentMonth).total;
    const owed = tenant.rent - paid;
    if (owed <= 0) continue;

    const alreadyNotified = db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE tenant_id = ? AND direction = 'outbound' AND category = 'payment' AND content LIKE '%late fee%' AND timestamp >= ?`).get(tenant.id, currentMonth + '-01').count;
    if (alreadyNotified > 0) continue;

    const lateFee = Math.min(owed * 0.1, tenant.rent * 0.1);
    const msg = `Hi ${tenant.short_name}, per Paragraph 6 of your lease, rent of $${owed.toFixed(2)} is past the 5-day grace period. A late fee of $${lateFee.toFixed(2)} applies. Total due: $${(owed + lateFee).toFixed(2)}. Please send via ${tenant.payment_method} immediately. — 9 Quincy Management`;

    // Save as pending preview for owner approval
    db.prepare(`INSERT INTO message_previews (type, tenant_id, content, status) VALUES ('late_fee_notice', ?, ?, 'pending')`).run(tenant.id, msg);
    await alertOwner(`⚠️ Late fee notice ready for ${tenant.short_name}. Outstanding: $${owed.toFixed(2)} + $${lateFee.toFixed(2)} fee. Review dashboard to send.`);
  }
}

async function sendConfirmedPreview(previewId) {
  const preview = db.prepare('SELECT * FROM message_previews WHERE id = ?').get(previewId);
  if (!preview || preview.status !== 'pending') return;

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(preview.tenant_id);
  if (!tenant) return;

  await sendSMS(tenant.phone, preview.content, `confirmed preview: ${preview.type}`);
  db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'payment', 1)`).run(preview.tenant_id, preview.content);
  db.prepare(`UPDATE message_previews SET status = 'sent' WHERE id = ?`).run(previewId);
}

module.exports = { sendSMS, alertOwner, logMessage, handleInboundSMS, sendRentReminder, checkOverdueRent, sendConfirmedPreview, previewToOwner, isQuietHours };
