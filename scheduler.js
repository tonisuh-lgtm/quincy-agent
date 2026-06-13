const db = require('./db');
const { sendSMS, alertOwner } = require('./twilio-handler');
const { generateResponse, getConfig } = require('./agent');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROVIDERS = {
  pest_control: {
    name: 'Mehmet',
    phone: '+12023897752',
    label: 'Pest Control',
    via: 'sms',
    frequency: 'quarterly',
  },
  cleaning: {
    name: 'Stanley / Dazzling Cleaning',
    phone: '+12535188749',
    schedulingPhone: '+18443252663',
    website: 'dazzlingcleaners.com',
    label: 'Cleaning',
    via: 'manual_website',
    frequency: 'monthly',
  },
};

// Create a new scheduling job
function createSchedulingJob(type, requestedBy = 'owner', notes = '') {
  const provider = PROVIDERS[type];
  if (!provider) throw new Error(`Unknown service type: ${type}`);

  const job = db.prepare(`
    INSERT INTO scheduling_jobs (type, provider_name, provider_phone, status, notes, requested_by)
    VALUES (?, ?, ?, 'collecting_availability', ?, ?)
  `).run(type, provider.name, provider.phone, notes, requestedBy);

  return job.lastInsertRowid;
}

// Ask tenants for availability
async function askTenantsAvailability(jobId) {
  const job = db.prepare('SELECT * FROM scheduling_jobs WHERE id = ?').get(jobId);
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  const provider = PROVIDERS[job.type];

  const msg = `Hi, we're scheduling ${provider.label.toLowerCase()} at the property. Could you please share 2-3 windows of availability over the next 1-2 weeks (e.g., "Mon June 23 morning" or "any weekday after 3pm")? We'll confirm the time once we coordinate. Thank you! — 9 Quincy Management`;

  for (const tenant of tenants) {
    await sendSMS(tenant.phone, msg);
    db.prepare(`
      INSERT INTO scheduling_availability (job_id, party, party_name, availability_text, status)
      VALUES (?, 'tenant', ?, 'pending', 'waiting')
    `).run(jobId, tenant.short_name);

    // Log in conversations
    db.prepare(`
      INSERT INTO conversations (tenant_id, direction, content, category, agent_classified)
      VALUES (?, 'outbound', ?, 'scheduling', 1)
    `).run(tenant.id, msg);
  }

  db.prepare(`UPDATE scheduling_jobs SET status = 'collecting_availability', updated_at = datetime('now') WHERE id = ?`).run(jobId);
  await alertOwner(`📅 ${provider.label} scheduling started. Waiting for Temi & Chloe's availability. Job #${jobId}`);

  return jobId;
}

// Log availability response from tenant
function logTenantAvailability(jobId, tenantId, availabilityText) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
  db.prepare(`
    UPDATE scheduling_availability
    SET availability_text = ?, status = 'received', updated_at = datetime('now')
    WHERE job_id = ? AND party_name = ?
  `).run(availabilityText, jobId, tenant.short_name);

  // Check if all tenants responded
  const pending = db.prepare(`
    SELECT COUNT(*) as count FROM scheduling_availability
    WHERE job_id = ? AND party = 'tenant' AND status = 'waiting'
  `).get(jobId).count;

  return pending === 0;
}

// Find overlap and propose to owner
async function proposeSchedule(jobId) {
  const job = db.prepare('SELECT * FROM scheduling_jobs WHERE id = ?').get(jobId);
  const availabilities = db.prepare(`
    SELECT * FROM scheduling_availability WHERE job_id = ?
  `).all(jobId);
  const provider = PROVIDERS[job.type];

  const availText = availabilities.map(a => `${a.party_name}: ${a.availability_text}`).join('\n');

  const prompt = `Based on these availability windows from tenants, suggest the best 2-3 time slots that could work for a ${provider.label} appointment. The appointment typically takes 2-3 hours. Prefer weekday mornings.

Availabilities:
${availText}

Respond with ONLY a JSON array of suggested slots (no markdown):
[
  {"slot": "Monday June 23, 9am-12pm", "reasoning": "works for both"},
  {"slot": "Wednesday June 25, 10am-1pm", "reasoning": "Chloe preferred"}
]`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  let suggestions = [];
  try {
    suggestions = JSON.parse(res.content[0].text.trim());
  } catch {
    suggestions = [{ slot: 'To be determined', reasoning: 'Please review availabilities manually' }];
  }

  db.prepare(`
    UPDATE scheduling_jobs SET proposed_slots = ?, status = 'awaiting_owner_approval', updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(suggestions), jobId);

  const slotText = suggestions.map((s, i) => `${i + 1}. ${s.slot} (${s.reasoning})`).join('\n');
  await alertOwner(`📅 ${provider.label} scheduling — all tenants responded!\n\nSuggested times:\n${slotText}\n\nLog in to dashboard to approve a slot. Job #${jobId}`);

  return suggestions;
}

// Owner approves a slot
async function approveSlot(jobId, slot) {
  const job = db.prepare('SELECT * FROM scheduling_jobs WHERE id = ?').get(jobId);
  const provider = PROVIDERS[job.type];
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();

  db.prepare(`
    UPDATE scheduling_jobs SET confirmed_slot = ?, status = 'confirmed', updated_at = datetime('now') WHERE id = ?
  `).run(slot, jobId);

  // Notify tenants
  const tenantMsg = `Great news! ${provider.label} has been scheduled for ${slot}. Please ensure access to the unit. A reminder will be sent the day before. Thank you! — 9 Quincy Management`;
  for (const tenant of tenants) {
    await sendSMS(tenant.phone, tenantMsg);
    db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(tenant.id, tenantMsg);
  }

  // Notify / book provider
  if (job.type === 'pest_control') {
    // Text Mehmet directly
    const mehmetMsg = `Hi Mehmet, this is 9 Quincy Pl NE #2. We'd like to schedule pest control for ${slot}. Please confirm. Thank you!`;
    await sendSMS(PROVIDERS.pest_control.phone, mehmetMsg);
    db.prepare(`UPDATE scheduling_jobs SET provider_notified = 1, updated_at = datetime('now') WHERE id = ?`).run(jobId);
    await alertOwner(`✅ Pest control confirmed for ${slot}. Mehmet has been texted. Tenants notified.`);
  } else if (job.type === 'cleaning') {
    // Draft booking for owner to complete on website
    const bookingDraft = `Booking details for dazzlingcleaners.com:\nDate/time: ${slot}\nAddress: 9 Quincy Pl NE #2, Washington DC 20002\nService: Standard cleaning\nContact: ${process.env.OWNER_EMAIL}`;
    db.prepare(`UPDATE scheduling_jobs SET booking_draft = ?, updated_at = datetime('now') WHERE id = ?`).run(bookingDraft, jobId);
    await alertOwner(`✅ Cleaning scheduled for ${slot}. Tenants notified.\n\nPlease book at dazzlingcleaners.com:\n${bookingDraft}\n\nPaste confirmation back in dashboard when done.`);
  }

  // Schedule day-before reminder
  db.prepare(`
    INSERT INTO scheduled_reminders (job_id, send_date, status)
    VALUES (?, date(?, '-1 day'), 'pending')
  `).run(jobId, slot.split(',')[0]);

  return { slot, provider };
}

// Send day-before reminders
async function sendDayBeforeReminders() {
  const today = new Date().toISOString().slice(0, 10);
  const reminders = db.prepare(`
    SELECT r.*, j.type, j.confirmed_slot FROM scheduled_reminders r
    JOIN scheduling_jobs j ON r.job_id = j.id
    WHERE r.send_date = ? AND r.status = 'pending'
  `).all(today);

  for (const reminder of reminders) {
    const provider = PROVIDERS[reminder.type];
    const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();

    const msg = `Reminder: ${provider.label} is scheduled for tomorrow, ${reminder.confirmed_slot}. Please ensure the unit is accessible. Thank you! — 9 Quincy Management`;
    for (const tenant of tenants) {
      await sendSMS(tenant.phone, msg);
      db.prepare(`INSERT INTO conversations (tenant_id, direction, content, category, agent_classified) VALUES (?, 'outbound', ?, 'scheduling', 1)`).run(tenant.id, msg);
    }

    if (reminder.type === 'pest_control') {
      await sendSMS(PROVIDERS.pest_control.phone, `Reminder: Pest control appointment at 9 Quincy Pl NE #2 tomorrow, ${reminder.confirmed_slot}. Please confirm.`);
    }

    db.prepare(`UPDATE scheduled_reminders SET status = 'sent', updated_at = datetime('now') WHERE id = ?`).run(reminder.id);
    await alertOwner(`🔔 Day-before reminders sent for ${provider.label} on ${reminder.confirmed_slot}.`);
  }
}

// Generate Thumbtack job post draft
async function generateThumbтackDraft(issueDescription) {
  const prompt = `Draft a clear, professional Thumbtack job posting for a home repair/service need. Be specific enough to get accurate quotes.

Issue: ${issueDescription}
Property: 9 Quincy Pl NE #2, Washington DC 20002 (condo unit)

Respond with JSON only:
{
  "title": "short job title",
  "description": "2-3 sentence description of the work needed",
  "category": "suggested Thumbtack category",
  "budget_range": "estimated budget range based on typical DC rates",
  "urgency": "when this needs to be done",
  "questions_to_ask_pros": ["question 1", "question 2", "question 3"]
}`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return { title: issueDescription, description: issueDescription, category: 'Home Services', budget_range: 'TBD', urgency: 'Within 2 weeks', questions_to_ask_pros: [] };
  }
}

// Once owner has hired a Thumbtack pro, schedule with tenants
async function scheduleThumbтackPro(proName, proPhone, jobDescription, requestedSlot) {
  const jobId = db.prepare(`
    INSERT INTO scheduling_jobs (type, provider_name, provider_phone, status, notes, confirmed_slot)
    VALUES ('thumbtack', ?, ?, 'collecting_availability', ?, ?)
  `).run(proName, proPhone, jobDescription, requestedSlot || '').lastInsertRowid;

  if (requestedSlot) {
    await approveSlot(jobId, requestedSlot);
  } else {
    await askTenantsAvailability(jobId);
  }

  return jobId;
}

module.exports = {
  createSchedulingJob,
  askTenantsAvailability,
  logTenantAvailability,
  proposeSchedule,
  approveSlot,
  sendDayBeforeReminders,
  generateThumbтackDraft,
  scheduleThumbтackPro,
  PROVIDERS,
};
