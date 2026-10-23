const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const DB_FILE = path.join(DATA_DIR, 'documents.json');
const MAX_BYTES = 20 * 1024 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let failedLogins = 0;
let blockedUntil = 0;

async function readDocs() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
async function writeDocs(docs) {
  const temp = DB_FILE + '.' + process.pid + '.tmp';
  await fs.writeFile(temp, JSON.stringify(docs, null, 2), 'utf8');
  await fs.rename(temp, DB_FILE);
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function safeDoc(doc) {
  const { filename, ...safe } = doc;
  return { ...safe, fileUrl: '/api/documents/' + encodeURIComponent(doc.id) + '/file' };
}
function cookieToken(req) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const c of cookies) { const pair = c.trim().split('='); if (pair[0] === 'nexus_admin') return pair.slice(1).join('='); }
  return '';
}
function isAdmin(req) {
  const token = cookieToken(req); const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}
async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES) throw Object.assign(new Error('PDF must be 20 MB or smaller.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await fs.readFile(path.join(ROOT, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/admin/session') return json(res, 200, { isAdmin: isAdmin(req) });
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (Date.now() < blockedUntil) return json(res, 429, { error: 'Too many incorrect attempts. Try again later.' });
      if (!process.env.ADMIN_PASSWORD) return json(res, 503, { error: 'Admin password is not configured on the server.' });
      const body = await readBody(req);
      let input; try { input = JSON.parse(body.toString('utf8')); } catch { return json(res, 400, { error: 'Invalid login request.' }); }
      const given = Buffer.from(String(input.password || ''));
      const expected = Buffer.from(process.env.ADMIN_PASSWORD);
      const valid = given.length === expected.length && crypto.timingSafeEqual(given, expected);
      if (!valid) {
        failedLogins++;
        if (failedLogins >= 8) { blockedUntil = Date.now() + 10 * 60 * 1000; failedLogins = 0; }
        return json(res, 401, { error: 'Incorrect admin password.' });
      }
      failedLogins = 0;
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_MS);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return json(res, 200, { isAdmin: true }, { 'Set-Cookie': 'nexus_admin=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' + secure });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      sessions.delete(cookieToken(req));
      return json(res, 200, { isAdmin: false }, { 'Set-Cookie': 'nexus_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (req.method === 'GET' && url.pathname === '/api/documents') return json(res, 200, (await readDocs()).map(safeDoc));
    if (req.method === 'POST' && url.pathname === '/api/documents') {
      if (!isAdmin(req)) return json(res, 401, { error: 'Admin login required.' });
      let title; try { title = decodeURIComponent(req.headers['x-document-title'] || '').trim(); } catch { return json(res, 400, { error: 'Invalid title.' }); }
      const category = req.headers['x-document-category'] || '';
      const paid = req.headers['x-document-paid'] === 'true';
      const price = paid ? Number(req.headers['x-document-price']) : 0;
      if (!title || title.length > 100) return json(res, 400, { error: 'Enter a title up to 100 characters.' });
      if (!['Social Science', 'Geography', 'Polity', 'Economics', 'Other'].includes(category)) return json(res, 400, { error: 'Choose a valid subject.' });
      if (paid && (!Number.isFinite(price) || price < 1 || price > 100000)) return json(res, 400, { error: 'Enter a valid price.' });
      const pdf = await readBody(req);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return json(res, 400, { error: 'The selected file is not a valid PDF.' });
      await fs.mkdir(PDF_DIR, { recursive: true });
      const id = crypto.randomUUID(); const filename = id + '.pdf';
      await fs.writeFile(path.join(PDF_DIR, filename), pdf, { flag: 'wx' });
      const doc = { id, title, category, isPaid: paid, price, size: (pdf.length / 1048576).toFixed(1) + ' MB', filename, createdAt: new Date().toISOString() };
      const docs = await readDocs(); docs.unshift(doc); await writeDocs(docs);
      return json(res, 201, safeDoc(doc));
    }
    const match = req.method === 'GET' && url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)\/file$/i);
    if (match) {
      const doc = (await readDocs()).find(item => item.id === match[1]);
      if (!doc) return json(res, 404, { error: 'PDF not found.' });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="study-resource.pdf"', 'X-Content-Type-Options': 'nosniff' });
      return fsSync.createReadStream(path.join(PDF_DIR, doc.filename)).pipe(res);
    }
    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error(err);
    if (err.status === 413) return json(res, 413, { error: err.message });
    json(res, 500, { error: 'Server could not complete the request.' });
  }
});
fs.mkdir(DATA_DIR, { recursive: true }).then(() => server.listen(PORT, '0.0.0.0', () => console.log('Topper Notes listening on port ' + PORT))).catch(err => { console.error(err); process.exit(1); });
