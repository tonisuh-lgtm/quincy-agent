const twilio = require('twilio');
const db = require('./db');
const { classifyMessage, generateResponse, shouldEscalate, generateOwnerSummary } = require('./agent');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const OWNER_PHONE = process.env.OWNER_PHONE;
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

async function sendSMS(to, body) {
  const chunks = [];
  let text = body;
  while (text.length > 300) {
    const split = text.lastIndexOf(' ', 300);
    chunks.push(text.slice(0, split > 0 ? split : 300));
    text = text.slice(split > 0 ? split + 1 : 300);
  }
  chunks.push(text);
  for (const chunk of chunks) {
    await client.messages.create({ from: FROM_NUMBER, to, body: chunk });
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function alertOwner(message) {
  try { await client.messages.create({ from: FROM_NUMBER, to: OWNER_PHONE, body: message }); }
  catch (e) { console.error('Owner alert failed:', e.message); }
}

async function handleInboundSMS(from, body) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE phone = ? AND active = 1').get(from);

  if (!tenant) {
    await alertOwner(`⚠️ Unknown number texted property line: ${from}\n"${body}"`);
    await sendSMS(from, 'Thank you for reaching out to 9 Quincy Property Management. We\'ll be in touch shortly. — 9 Quincy Management');
    return;
  }

  const history = db.prepare(`SELECT * FROM conversations WHERE tenant_id = ? AND status = 'open' ORDER BY timestamp DESC LIMIT 10`).all(tenant.id).reverse();
  const inserted = db.prepare(`INSERT INTO conversations (tenant_id, direction, content, needs_review) VALUES (?, 'inbound', ?, 0)`).run(tenant.id, body);
  const msgId = inserted.lastInsertRowid;

  const classification = await classifyMessage(body, tenant.short_name);
  db.prepare(`UPDATE conversations SET urgency = ?, category = ?, agent_classified = 1 WHERE id = ?`).run(classification.urgency, classification.category, msgId);

  const agentReply = await generateResponse(tenant, history, body, classification);
  db.prepare(`INSERT INTO conversations (tenant_id, direction, content, urgency, category, agent_classified) VALUES (?, 'outbound', ?, ?, ?, 1)`).run(tenant.id, agentReply, classification.urgency, classification.category);

  await sendSMS(from, agentReply);

  const allHistory = [...history, { direction: 'inbound', content: body }];
  const shouldAlert = classification.urgency === 'emergency' || classification.urgency === 'urgent' || await shouldEscalate(allHistory, classification.category);

  if (shouldAlert) {
    const urgencyEmoji = { emergency: '🚨', urgent: '⚠️', routine: '📋' };
    const summary = await generateOwnerSummary(tenant, allHistory, classification);
    db.prepare('UPDATE conversations SET needs_review = 1 WHERE id = ?').run(msgId);
    await alertOwner(`${urgencyEmoji[classification.urgency]} ${classification.urgency.toUpperCase()} — ${tenant.short_name}\n${classification.summary}\n\n${summary}\n\nReview dashboard: /app`);
  }

  const paymentKeywords = ['paid', 'sent', 'payment', 'venmo', 'zelle', 'apple pay', 'transferred'];
  if (paymentKeywords.some(kw => body.toLowerCase().includes(kw))) {
    await alertOwner(`💰 Payment mention from ${tenant.short_name}:\n"${body}"\n\nLog in dashboard to confirm.`);
  }

  return { tenant, classification, agentReply };
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

    const msg = `Hi ${tenant.short_name}, friendly reminder that rent of $${owed.toFixed(2)} is due tomorrow, ${dayName}. Please send via ${tenant.payment_method} and text this number to confirm. Thank you! — 9 Quincy Management`;
    try {
      await sendSMS(tenant.phone, msg);
      db.prepare(`INSERT INTO conversations (tenant_id, direction, content, urgency, category, agent_classified) VALUES (?, 'outbound', ?, 'routine', 'payment', 1)`).run(tenant.id, msg);
    } catch (e) { console.error(`Reminder failed for ${tenant.short_name}:`, e.message); }
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
    const msg = `Hi ${tenant.short_name}, per Paragraph 6 of your lease, rent of $${owed.toFixed(2)} is past the 5-day grace period. A late fee of $${lateFee.toFixed(2)} has been applied. Total due: $${(owed + lateFee).toFixed(2)}. Please send via ${tenant.payment_method} immediately. — 9 Quincy Management`;
    try {
      await sendSMS(tenant.phone, msg);
      db.prepare(`INSERT INTO conversations (tenant_id, direction, content, urgency, category, agent_classified, needs_review) VALUES (?, 'outbound', ?, 'urgent', 'payment', 1, 1)`).run(tenant.id, msg);
      await alertOwner(`⚠️ Late fee notice sent to ${tenant.short_name}. Outstanding: $${owed.toFixed(2)} + $${lateFee.toFixed(2)} late fee.`);
    } catch (e) { console.error(`Late fee notice failed for ${tenant.short_name}:`, e.message); }
  }
}

module.exports = { sendSMS, alertOwner, handleInboundSMS, sendRentReminder, checkOverdueRent };
