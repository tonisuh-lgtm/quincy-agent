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

// Get active lease summary for a tenant
function getActiveLeaseSummary(tenantId) {
  const lease = db.prepare(`SELECT summary, filename FROM lease_documents WHERE tenant_id = ? AND active = 1 ORDER BY uploaded_at DESC LIMIT 1`).get(tenantId);
  return lease ? `Active lease: ${lease.filename}\n${lease.summary}` : null;
}

// Get active lease PDF data for a tenant (for direct reading)
function getActiveLeaseData(tenantId) {
  return db.prepare(`SELECT data, filename FROM lease_documents WHERE tenant_id = ? AND active = 1 ORDER BY uploaded_at DESC LIMIT 1`).get(tenantId);
}

// Summarize a lease PDF using Claude
async function summarizeLease(pdfBase64, filename) {
  const prompt = `You are reviewing a residential lease agreement. Extract and summarize the key provisions in a structured format covering:
1. Parties and property address
2. Lease term and dates
3. Rent amount and due date
4. Late fees
5. Utilities obligations
6. Guest policy
7. Entry rights
8. Common area rules
9. Move-out requirements
10. Security deposit terms
11. Any special provisions or addenda

Be comprehensive but concise. This summary will be used by a property management agent to answer tenant questions accurately.`;

  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: prompt }
        ]
      }]
    });
    return res.content[0].text.trim();
  } catch(e) {
    console.error('Lease summary error:', e.message);
    return 'Lease uploaded but could not be summarized automatically.';
  }
}

// Extract utility bill total from receipt
async function extractUtilityTotal(fileData, fileType, filename) {
  const prompt = `This is a utility bill receipt. Extract:
1. The total amount due (the final amount to be paid)
2. The billing period
3. The utility company name
4. The service address if visible

Respond with JSON only:
{"total": 123.45, "period": "June 2026", "company": "Pepco", "address": "9 Quincy Pl NE"}`;

  try {
    const content = fileType === 'application/pdf'
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }, { type: 'text', text: prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: fileType, data: fileData } }, { type: 'text', text: prompt }];

    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content }]
    });

    return JSON.parse(res.content[0].text.trim());
  } catch(e) {
    console.error('Receipt extraction error:', e.message);
    return null;
  }
}

// Answer a question about a utility bill using the receipt
async function answerUtilityQuestion(question, receiptData, receiptType, billInfo) {
  const content = [];

  if (receiptData) {
    if (receiptType === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: receiptData } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: receiptType, data: receiptData } });
    }
  }

  content.push({ type: 'text', text: `A tenant is asking about a utility bill. Bill info: ${JSON.stringify(billInfo)}. Question: "${question}". Answer based on the receipt and bill information. Be factual and concise. If you cannot determine the answer from the receipt, say so.` });

  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{ role: 'user', content }]
  });

  return res.content[0].text.trim();
}

// Detect whether a message touches an escalate-only topic the agent must not answer
async function checkEscalation(content) {
  const config = getConfig();
  const topics = (config.escalate_topics || '').trim();
  if (!topics) return { escalate: false };

  const prompt = `A tenant sent this message to a property management agent:
"${content}"

The agent is FORBIDDEN from answering or taking any position on these topics:
${topics}

Does this message touch on ANY of those topics, even partially or indirectly? Be strict: if the tenant is asking for an exception, pushing back on a term, or opening a negotiation, that counts.

Respond with ONLY JSON: {"escalate": true|false, "reason": "short reason"}`;

  try {
    const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    return JSON.parse(res.content[0].text.trim());
  } catch { return { escalate: false }; }
}

// Analyze a message received outside the system (personal text, email, in person)
// Accepts pasted text, screenshots, or both
async function analyzeExternalMessage(content, tenantName, leaseSummary, images) {
  const hasImages = Array.isArray(images) && images.length > 0;

  const prompt = `You are assisting a residential landlord in Washington DC. ${hasImages ? `The landlord uploaded ${images.length === 1 ? 'a screenshot' : images.length + ' screenshots'} of messages from a tenant named ${tenantName}.` : `A tenant named ${tenantName} sent the following message outside the property management system.`} The landlord wants it read and filed as a record.

${content ? `ADDITIONAL CONTEXT OR PASTED TEXT:\n"""\n${content}\n"""` : ''}

${leaseSummary ? `RELEVANT LEASE TERMS:\n${leaseSummary.slice(0, 3000)}` : ''}

${hasImages ? `Read the screenshot(s) carefully. Screenshots may show a back-and-forth thread. Focus on what the TENANT said. Messages from the landlord (usually the sender's own side of the conversation) are context only. If the screenshots are in sequence, read them in order.` : ''}

Respond with ONLY a JSON object, no markdown:
{
  "transcript": "${hasImages ? 'verbatim text of the tenant messages you can read in the screenshots, with speaker labels like "Tenant:" and "Landlord:" where the thread shows both sides. Preserve wording exactly.' : 'leave as empty string'}",
  "title": "short factual title, under 10 words",
  "category": "lease_violation" | "damage" | "noise" | "cleanliness" | "payment" | "safety" | "unauthorized_access" | "complaint" | "request" | "notice" | "other",
  "severity": "minor" | "moderate" | "serious",
  "summary": "2-3 sentence neutral factual summary of what the tenant is saying or asking",
  "lease_reference": "relevant lease paragraph numbers if any apply, else empty string",
  "asks": ["each specific thing the tenant is requesting or demanding"],
  "tone": "one short phrase describing tone, e.g. cordial, frustrated, adversarial, negotiating",
  "requires_owner_decision": true | false,
  "recommended_action": "one sentence on what the landlord should do next",
  "documentation_note": "one sentence on why this is or is not worth keeping in the record",
  "unreadable": true | false
}

Set "unreadable" to true only if the ${hasImages ? 'screenshots are too blurry or cropped to read' : 'message is empty or meaningless'}. Be neutral and factual. Do not editorialize about the tenant. If the tenant is negotiating or asking for an exception, set requires_owner_decision to true.`;

  try {
    const messageContent = [];
    if (hasImages) {
      images.forEach(img => {
        messageContent.push({
          type: 'image',
          source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data }
        });
      });
    }
    messageContent.push({ type: 'text', text: prompt });

    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: messageContent }]
    });
    let text = res.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('Message analysis error:', e.message);
    return null;
  }
}

async function classifyMessage(content, tenantName) {
  const config = getConfig();
  const prompt = `Classify this tenant message for a property manager.
Tenant: ${tenantName}
Message: "${content}"
Urgency rules: ${config.urgency_rules}
Respond with ONLY JSON (no markdown):
{"urgency":"emergency"|"urgent"|"routine","category":"maintenance"|"complaint"|"payment"|"lease_question"|"utility_question"|"move_out"|"scheduling"|"general","summary":"one sentence","needs_info":true|false}`;

  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 200, messages: [{ role: 'user', content: prompt }] });
  try { return JSON.parse(res.content[0].text.trim()); }
  catch { return { urgency: 'routine', category: 'general', summary: content.slice(0, 100), needs_info: false }; }
}

async function generateResponse(tenant, conversationHistory, newMessage, classification) {
  const config = getConfig();
  const tenantContext = getTenantContext();
  const leaseSummary = getActiveLeaseSummary(tenant.id);

  const responseTimeMap = {
    emergency: 'We are treating this as an emergency and escalating immediately. You will hear from us within the hour.',
    urgent: 'We will review this within 1-2 business days.',
    routine: 'We will review this within 5 business days.'
  };

  const gatheringInstructions = {
    maintenance: config.gather_maintenance,
    complaint: config.gather_complaint,
    payment: config.gather_payment,
    scheduling: config.gather_scheduling,
    lease_question: 'Answer based on the lease summary provided. If uncertain, say the landlord will confirm.',
    utility_question: 'Answer based on Paragraph 7 of the lease. Direct billing questions to the utility company.',
    general: 'Ask any clarifying questions that would help the owner.',
    move_out: 'Ask for intended move-out date. Remind them of the 40-day written notice requirement.'
  };

  const history = conversationHistory.map(m => ({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: m.content }));
  history.push({ role: 'user', content: newMessage });

  const systemPrompt = `${config.agent_persona}

${config.custom_rules}

Current tenants:
${tenantContext}

${leaseSummary ? `Lease on file for ${tenant.short_name}:\n${leaseSummary}` : ''}

Current classification:
- Urgency: ${classification.urgency}
- Category: ${classification.category}
- Response time: ${responseTimeMap[classification.urgency]}

${gatheringInstructions[classification.category] || ''}

Instructions:
1. First message: acknowledge, state response time, ask ONE clarifying question only.
2. Follow-up: thank them, acknowledge, ask next question or confirm info gathered.
3. Emergency: skip gathering, give immediate help. Fire/gas: 911. Washington Gas: 1-844-927-4427.
4. Lease questions: answer based on lease summary if available, otherwise say landlord will confirm.
5. Keep under 300 characters per SMS.
6. End EVERY response with: "${config.agent_disclosure}"
7. Sign off as: — 9 Quincy Management`;

  const res = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 500, system: systemPrompt, messages: history });
  return res.content[0].text.trim();
}

async function shouldEscalate(conversationHistory, category) {
  if (conversationHistory.length < 2) return false;
  const minExchanges = { maintenance: 3, complaint: 3, payment: 2, move_out: 2, general: 1, lease_question: 1, utility_question: 1, scheduling: 2 };
  return conversationHistory.length >= (minExchanges[category] || 2) * 2;
}

async function generateOwnerSummary(tenant, conversationHistory, classification) {
  const history = conversationHistory.map(m => `${m.direction === 'inbound' ? tenant.short_name : 'Agent'}: ${m.content}`).join('\n');
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 300,
    messages: [{ role: 'user', content: `Summarize this tenant conversation for the landlord in 3-5 bullet points. Be concise. Include: issue, urgency, key details, recommended next action.\n\nConversation:\n${history}\n\nUse • for bullets. No headers.` }]
  });
  return res.content[0].text.trim();
}

module.exports = { classifyMessage, generateResponse, shouldEscalate, generateOwnerSummary, getConfig, summarizeLease, extractUtilityTotal, answerUtilityQuestion, getActiveLeaseData, checkEscalation, analyzeExternalMessage, getActiveLeaseSummary };
