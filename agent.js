const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM agent_config').all();
  return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
}

function getTenantContext() {
  const tenants = db.prepare('SELECT * FROM tenants WHERE active = 1').all();
  return tenants.map(t => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const paid = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE tenant_id = ? AND month = ? AND type = 'rent'`).get(t.id, currentMonth).total;
    const balance = Math.max(0, t.rent - paid);
    return `- ${t.name} ("${t.short_name}"): $${t.rent}/month, lease ${t.lease_start} to ${t.lease_end}, pays via ${t.payment_method}. Current month paid: $${paid.toFixed(2)}, balance due: $${balance.toFixed(2)}.`;
  }).join('\n');
}

async function classifyMessage(content, tenantName) {
  const config = getConfig();
  const prompt = `You are classifying a tenant message for a property manager.
Tenant: ${tenantName}
Message: "${content}"
Urgency rules: ${config.urgency_rules}
Respond with ONLY a JSON object (no markdown):
{"urgency":"emergency"|"urgent"|"routine","category":"maintenance"|"complaint"|"payment"|"move_out"|"general","summary":"one sentence summary","needs_info":true|false}`;

  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
  try { return JSON.parse(res.content[0].text.trim()); }
  catch { return { urgency: 'routine', category: 'general', summary: content.slice(0, 100), needs_info: false }; }
}

async function generateResponse(tenant, conversationHistory, newMessage, classification) {
  const config = getConfig();
  const tenantContext = getTenantContext();

  const responseTimeMap = {
    emergency: 'We are treating this as an emergency and escalating immediately. You will hear from us within the hour.',
    urgent: 'We will review this within 1-2 business days.',
    routine: 'We will review this within 5 business days.'
  };

  const gatheringInstructions = {
    maintenance: config.gather_maintenance,
    complaint: config.gather_complaint,
    payment: config.gather_payment,
    general: 'Ask any clarifying questions that would help the owner understand the situation.',
    move_out: 'Ask for their intended move-out date and reason. Remind them of the 40-day written notice requirement per their lease.'
  };

  const history = conversationHistory.map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
  history.push({ role: 'user', content: newMessage });

  const systemPrompt = `${config.agent_persona}

${config.custom_rules}

Current tenants:
${tenantContext}

Current message classification:
- Urgency: ${classification.urgency}
- Category: ${classification.category}
- Response time: ${responseTimeMap[classification.urgency]}

${gatheringInstructions[classification.category] || ''}

Instructions:
1. First message: acknowledge, state response time, ask ONE clarifying question only.
2. Follow-up: thank them, acknowledge, ask next question or confirm enough info gathered.
3. Emergency: skip gathering, give immediate help and emergency contacts (fire/gas: 911, Washington Gas: 1-844-927-4427).
4. Keep under 300 characters per SMS. Split naturally if longer.
5. Never promise resolutions. Never discuss other tenants. Never reveal owner details.
6. Sign off as: — 9 Quincy Management`;

  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 400, system: systemPrompt, messages: history });
  return res.content[0].text.trim();
}

async function shouldEscalate(conversationHistory, category) {
  if (conversationHistory.length < 2) return false;
  const minExchanges = { maintenance: 3, complaint: 3, payment: 2, move_out: 2, general: 1 };
  return conversationHistory.length >= (minExchanges[category] || 2) * 2;
}

async function generateOwnerSummary(tenant, conversationHistory, classification) {
  const history = conversationHistory.map(m => `${m.direction === 'inbound' ? tenant.short_name : 'Agent'}: ${m.content}`).join('\n');
  const prompt = `Summarize this tenant conversation for the landlord in 3-5 bullet points. Be concise and factual. Include: issue, urgency, key details, recommended next action.\n\nConversation:\n${history}\n\nRespond with plain text bullet points only (use • symbol). No headers.`;
  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
  return res.content[0].text.trim();
}

module.exports = { classifyMessage, generateResponse, shouldEscalate, generateOwnerSummary, getConfig };
