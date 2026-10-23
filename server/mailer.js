const fs = require('fs');
const nodemailer = require('nodemailer');

// Test-only hook: with this set, every send is appended as a JSON line to
// the given file instead of going anywhere near real SMTP, and the
// feature reports as "configured" without KEPT_SMTP_HOST - lets the test
// suite exercise the full invite-by-email flow (including recovering the
// token embedded in the email body) without a real mail relay. Never set
// by anything other than server/invite.test.js.
const testCaptureFile = process.env.KEPT_TEST_MAIL_CAPTURE_FILE || null;

// Generic, provider-agnostic SMTP for the handful of transactional emails
// Kept itself needs (right now: inviting a new user by email - see
// KEPT_SMTP_* in README.md). Any self-hoster can point this at whatever
// relay they already have (a personal account's SMTP, or any
// transactional-email provider's free tier) - nothing here is tied to a
// specific vendor, and nothing requires running a mail server.
function buildTransport() {
  const host = process.env.KEPT_SMTP_HOST;
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.KEPT_SMTP_PORT || 587),
    secure: process.env.KEPT_SMTP_SECURE === '1',
    auth: process.env.KEPT_SMTP_USER ? { user: process.env.KEPT_SMTP_USER, pass: process.env.KEPT_SMTP_PASS } : undefined
  });
}

const transport = buildTransport();
const fromAddress = process.env.KEPT_SMTP_FROM || 'Kept <no-reply@example.com>';

function isConfigured() {
  return !!transport || !!testCaptureFile;
}

// Never throws: a misconfigured/unreachable SMTP relay should not break
// whatever feature tried to send mail. Callers check isConfigured() first
// to decide whether to offer the feature at all; this is the last-resort
// guard for a relay that was configured but is temporarily down.
async function sendMail({ to, subject, text }) {
  if (testCaptureFile) {
    fs.appendFileSync(testCaptureFile, JSON.stringify({ to, subject, text }) + '\n');
    return { delivered: true };
  }
  if (!transport) {
    console.log(`[mailer:unconfigured] to=${to} subject=${JSON.stringify(subject)}`);
    return { delivered: false };
  }
  try {
    await transport.sendMail({ from: fromAddress, to, subject, text });
    return { delivered: true };
  } catch (error) {
    console.error('[mailer] send failed:', error.message);
    return { delivered: false, error: error.message };
  }
}

module.exports = { isConfigured, sendMail };
