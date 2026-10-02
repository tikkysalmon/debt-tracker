// Shared header-key check for the internal read APIs (api/debt-summary.js, api/state-export.js).
// Fails CLOSED: if the env var is unset/short, every request is refused — so deploying the endpoint
// before the key is configured on Vercel exposes nothing. Constant-time compare to avoid timing leaks.
const crypto = require('crypto');

function keyOk(req, headerName, envName) {
  const expected = process.env[envName] || '';
  if (expected.length < 32) return false;
  const given = String((req.headers && req.headers[headerName]) || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// 403 with an empty body — deliberately says nothing about whether a customer exists.
function deny(res) { res.status(403).end(); }

module.exports = { keyOk, deny };
