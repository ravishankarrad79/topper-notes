const http = require('node:http');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.STORAGE_DIR || path.join(ROOT, 'storage'));
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const DB_FILE = path.join(DATA_DIR, 'documents.json');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'study-pdfs';
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const supabase = SUPABASE_CONFIGURED ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
}) : null;
const MAX_BYTES = 20 * 1024 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let failedLogins = 0;
let blockedUntil = 0;

function logSupabaseError(operation, error) {
  console.error('Supabase ' + operation + ' failed:', error?.code || error?.name || 'Unknown error');
}
async function readDocs() {
  if (SUPABASE_CONFIGURED) {
    const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false });
    if (error) { logSupabaseError('library read', error); throw new Error('Could not read cloud library. Check the Supabase settings.'); }
    return data.map(row => ({ id: row.id, title: row.title, category: row.category, isPaid: row.is_paid, price: Number(row.price), size: row.size, storagePath: row.storage_path, createdAt: row.created_at }));
  }
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
async function uploadCloudPdf(storagePath, pdf) {
  const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(storagePath, pdf, { contentType: 'application/pdf', upsert: false });
  if (error) { logSupabaseError('PDF upload', error); throw new Error('Cloud PDF upload failed. Check the Supabase settings and bucket.'); }
}
async function readCloudPdf(storagePath) {
  const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(storagePath);
  if (error) { logSupabaseError('PDF download', error); throw new Error('Cloud PDF download failed. Check the Supabase settings and bucket.'); }
  return Buffer.from(await data.arrayBuffer());
}
async function insertDoc(doc) {
  if (SUPABASE_CONFIGURED) {
    const { error } = await supabase.from('documents').insert({ id: doc.id, title: doc.title, category: doc.category, is_paid: doc.isPaid, price: doc.price, size: doc.size, storage_path: doc.storagePath, created_at: doc.createdAt });
    if (error) { logSupabaseError('document save', error); throw new Error('Could not save PDF details in the cloud database.'); }
    return;
  }
  const docs = await readDocs(); docs.unshift(doc); await writeDocs(docs);
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
  const { filename, storagePath, ...safe } = doc;
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
    const staticAssets = {
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
      '/icon-192.png': ['icon-192.png', 'image/png'],
      '/icon-512.png': ['icon-512.png', 'image/png'],
      '/apple-touch-icon.png': ['icon-192.png', 'image/png']
    };
    if (req.method === 'GET' && staticAssets[url.pathname]) {
      const [filename, contentType] = staticAssets[url.pathname];
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
      return res.end(await fs.readFile(path.join(ROOT, filename)));
    }
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
      if (process.env.RENDER && !SUPABASE_CONFIGURED) return json(res, 503, { error: 'Permanent cloud storage is not set up yet. Ask the site owner to finish storage setup before uploading PDFs.' });
      if ((SUPABASE_URL && !SUPABASE_SECRET_KEY) || (!SUPABASE_URL && SUPABASE_SECRET_KEY)) return json(res, 503, { error: 'Cloud storage needs both SUPABASE_URL and SUPABASE_SECRET_KEY.' });
      let title; try { title = decodeURIComponent(req.headers['x-document-title'] || '').trim(); } catch { return json(res, 400, { error: 'Invalid title.' }); }
      const category = req.headers['x-document-category'] || '';
      const paid = req.headers['x-document-paid'] === 'true';
      const price = paid ? Number(req.headers['x-document-price']) : 0;
      if (!title || title.length > 100) return json(res, 400, { error: 'Enter a title up to 100 characters.' });
      if (!['Polity', 'Class 10', 'Class 12', 'Master Computer', 'All Competition', 'Below Class 10', 'Other'].includes(category)) return json(res, 400, { error: 'Choose a valid subject.' });
      if (paid && (!Number.isFinite(price) || price < 1 || price > 100000)) return json(res, 400, { error: 'Enter a valid price.' });
      const pdf = await readBody(req);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) return json(res, 400, { error: 'The selected file is not a valid PDF.' });
      const id = crypto.randomUUID(); const storagePath = id + '.pdf';
      if (SUPABASE_CONFIGURED) await uploadCloudPdf(storagePath, pdf);
      else { await fs.mkdir(PDF_DIR, { recursive: true }); await fs.writeFile(path.join(PDF_DIR, storagePath), pdf, { flag: 'wx' }); }
      const doc = { id, title, category, isPaid: paid, price, size: (pdf.length / 1048576).toFixed(1) + ' MB', ...(SUPABASE_CONFIGURED ? { storagePath } : { filename: storagePath }), createdAt: new Date().toISOString() };
      await insertDoc(doc);
      return json(res, 201, safeDoc(doc));
    }
    const match = req.method === 'GET' && url.pathname.match(/^\/api\/documents\/([a-f0-9-]+)\/file$/i);
    if (match) {
      const doc = (await readDocs()).find(item => item.id === match[1]);
      if (!doc) return json(res, 404, { error: 'PDF not found.' });
      const download = url.searchParams.get('download') === '1';
      const safeTitle = String(doc.title || 'study-resource').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 80) || 'study-resource';
      const disposition = download ? 'attachment' : 'inline';
      if (doc.storagePath && SUPABASE_CONFIGURED) {
        const pdf = await readCloudPdf(doc.storagePath);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${disposition}; filename="study-resource.pdf"; filename*=UTF-8''${encodeURIComponent(safeTitle + '.pdf')}`, 'X-Content-Type-Options': 'nosniff' });
        return res.end(pdf);
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `${disposition}; filename="study-resource.pdf"; filename*=UTF-8''${encodeURIComponent(safeTitle + '.pdf')}`, 'X-Content-Type-Options': 'nosniff' });
      return fsSync.createReadStream(path.join(PDF_DIR, doc.filename)).pipe(res);
    }
    json(res, 404, { error: 'Not found.' });
  } catch (err) {
    console.error('Request failed:', err.name || 'Error', err.code || '');
    if (err.status === 413) return json(res, 413, { error: err.message });
    json(res, 500, { error: 'Server could not complete the request.' });
  }
});
fs.mkdir(DATA_DIR, { recursive: true }).then(() => server.listen(PORT, '0.0.0.0', () => console.log('Education Helping listening on port ' + PORT))).catch(err => { console.error(err); process.exit(1); });
