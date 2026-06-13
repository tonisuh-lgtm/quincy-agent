const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Get all agent config as an object
function getConfig() {
  const rows = db.prepare('SELECT key, value FROM agent_config').all();
  return rows.reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
}

// Classify message urgency and category
async function classifyMessage(content, tenantName) {
  const config = getConfig();
  const prompt = `You are classifying a tenant message for a property manager.

Tenant: ${tenantName}
Message: "${content}"

Urgency rules:
${config.urgency_rules}

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "urgency": "emergency" | "urgent" | "routine",
  "category": "maintenance" | "complaint" | "payment" | "move_out" | "general",
  "summary": "one sentence summary of the issue",
  "needs_info": true | false
}`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    return JSON.parse(res.content[0].text.trim());
  } catch {
    return { urgency: 'routine', category: 'general', summary: content.slice(0, 100), needs_info: false };
  }
}

// Generate agent response based on conversation history
async function generateResponse(tenant, conversationHistory, newMessage, classification) {
  const config = getConfig();

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

  const history = conversationHistory.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content
  }));

  history.push({ role: 'user', content: newMessage });

  const systemPrompt = `${config.agent_persona}

${config.custom_rules}

Current message classification:
- Urgency: ${classification.urgency}
- Category: ${classification.category}
- Response time to communicate: ${responseTimeMap[classification.urgency]}

${gatheringInstructions[classification.category] || ''}

Instructions for this response:
1. If this is the FIRST message in the conversation: acknowledge the message, state the response time, and ask the FIRST most important clarifying question only (not all at once).
2. If this is a FOLLOW-UP: thank them for the info, acknowledge what they said, ask the next most important question if still needed, or confirm you have enough and will escalate to the owner.
3. For EMERGENCIES: skip information gathering, tell them help is coming, give emergency contacts if applicable (fire: 911, gas: Washington Gas 1-844-927-4427).
4. Keep each SMS under 300 characters. If longer, it will be split automatically.
5. Be warm, professional, never dismissive. Never promise what the owner will do.
6. Sign off as: "— 9 Quincy Management"`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: systemPrompt,
    messages: history
  });

  return res.content[0].text.trim();
}

// Check if conversation has enough info to summarize for owner
async function shouldEscalate(conversationHistory, category) {
  if (conversationHistory.length < 2) return false;
  if (category === 'general' && conversationHistory.length >= 2) return true;

  const minExchanges = { maintenance: 3, complaint: 3, payment: 2, move_out: 2, general: 1 };
  return conversationHistory.length >= (minExchanges[category] || 2) * 2;
}

// Generate a summary for the owner
async function generateOwnerSummary(tenant, conversationHistory, classification) {
  const history = conversationHistory.map(m =>
    `${m.direction === 'inbound' ? tenant.short_name : 'Agent'}: ${m.content}`
  ).join('\n');

  const prompt = `Summarize this tenant conversation for the landlord in 3-5 bullet points. Be concise and factual. Include: issue, urgency, key details gathered, recommended next action.

Conversation:
${history}

Respond with plain text bullet points only (use • symbol). No headers.`;

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }]
  });

  return res.content[0].text.trim();
}

module.exports = { classifyMessage, generateResponse, shouldEscalate, generateOwnerSummary, getConfig };
