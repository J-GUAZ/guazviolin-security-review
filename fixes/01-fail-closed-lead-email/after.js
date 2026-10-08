// AFTER: reduced excerpt of the lead-notification serverless function (api/notify-lead.js).
// Pricing, travel-estimate and email-template code is removed; the verification control flow
// is the same as production. If the lead can't be verified, nothing is emailed.
'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function supabaseConfig() {
  const url = envValue('SUPABASE_URL').replace(/\/+$/, '');
  const key = envValue('SUPABASE_SERVICE_ROLE_KEY');
  return url && key ? { url, key } : null;
}

async function supabaseRest(config, path, options = {}) {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: config.key, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase request failed with status ${response.status}.`);
  return response;
}

// Returns found | missing | unverified.
async function loadStoredLead(id) {
  const config = supabaseConfig();
  if (!config) return { status: 'unverified' };
  if (!UUID_PATTERN.test(String(id || ''))) return { status: 'missing' };
  try {
    const response = await supabaseRest(config, `booking_leads?id=eq.${id}&select=id,created_at,lead_data`);
    const rows = await response.json();
    return rows[0] ? { status: 'found', row: rows[0], config } : { status: 'missing' };
  } catch (error) {
    console.warn('Lead lookup failed:', error);
    return { status: 'unverified' };
  }
}

async function markNotified(config, row) {
  await supabaseRest(config, `booking_leads?id=eq.${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ lead_data: { ...(row.lead_data || {}), notifiedAt: new Date().toISOString() } }),
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { skipped: true };
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Resend email failed with status ${response.status}.`);
  return response.json();
}

function readBody(request) {
  const body = request.body;
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  return body;
}

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = readBody(request);
    const submitted = body?.lead || body || {};

    const stored = await loadStoredLead(submitted.id);
    if (stored.status === 'missing') return response.status(404).json({ error: 'Lead not found.' });
    // Fail closed: if the lead can't be checked against the database, never email request-supplied content.
    if (stored.status !== 'found') {
      console.error('Lead email skipped: database lookup unavailable.');
      return response.status(503).json({ error: 'Lead notification temporarily unavailable.' });
    }
    const age = Date.now() - new Date(stored.row.created_at).getTime();
    if (stored.row.lead_data?.notifiedAt || age > LEAD_MAX_AGE_MS) return response.status(200).json({ ok: true });

    // Always use the saved copy so the email matches what's in the CRM.
    const lead = { ...stored.row.lead_data, id: stored.row.id, createdAt: stored.row.created_at };
    await sendEmail({
      from: process.env.LEAD_EMAIL_FROM || 'Bookings <bookings@example.com>',
      to: [process.env.LEAD_EMAIL_TO || 'owner@example.com'],
      subject: `New inquiry: ${lead.name || 'Unknown client'}`,
      html: `<p>${escapeHtml(lead.name)}</p><p>${escapeHtml(lead.message)}</p>`,
    });

    await markNotified(stored.config, stored.row).catch((error) => console.warn('Marking lead notified failed:', error));
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('Lead notification failed:', error);
    return response.status(500).json({ error: 'Unable to send lead notification.' });
  }
};
