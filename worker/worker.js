/**
 * Carte sonore – Worker API (Cloudflare Workers, syntaxe "module")
 * --------------------------------------------------------------
 * Fait le lien entre les pages web (GitHub Pages) et Google Drive / Google Sheets.
 *
 * Authentification hybride :
 *   - Google Sheets : COMPTE DE SERVICE (JWT signé dans le worker), la Sheet est partagée avec lui en Éditeur.
 *   - Google Drive  : APPS SCRIPT déployé sous le compte propriétaire du dossier. Il ouvre une session
 *                     d'envoi (les fichiers appartiennent donc à ce compte) et met les fichiers à la corbeille.
 *                     Le contenu audio est envoyé directement par le worker à Google, pas à Apps Script.
 *     (Les comptes de service créés après le 15/04/2025 n'ont aucun quota de stockage Drive.)
 *
 * Routes publiques
 *   GET  /list            -> liste des sons (lue dans la Google Sheet)
 *   GET  /health          -> vérifie que les variables sont présentes (?deep=1 : teste Google)
 *
 * Routes protégées (en-tête  Authorization: Bearer <ADMIN_PASSWORD>)
 *   POST /login           -> vérifie le mot de passe
 *   POST /upload          -> multipart/form-data : file, title, description, duration, lat, lng
 *   POST /update          -> JSON : { id, title?, description?, lat?, lng? }
 *   POST /delete          -> JSON : { id }
 *
 * Variables (Settings > Variables and Secrets du worker)
 *   SPREADSHEET_ID               (texte)  ID de la Google Sheet
 *   SHEET_NAME                   (texte)  Nom de l'onglet, par défaut "Sons"
 *   ALLOWED_ORIGINS              (texte)  ex. "https://monpseudo.github.io" (plusieurs : virgules, "*" = tout)
 *   MAX_UPLOAD_MB                (texte)  taille max d'un fichier, par défaut 50
 *   GOOGLE_SERVICE_ACCOUNT_JSON  (secret) contenu COMPLET du fichier .json de la clé du compte de service
 *   APPS_SCRIPT_URL              (secret) URL de l'application Web Apps Script (se termine par /exec)
 *   APPS_SCRIPT_SECRET           (secret) même valeur que la propriété SECRET de l'Apps Script
 *   ADMIN_PASSWORD               (secret) mot de passe de la page d'administration
 */

const COLUMNS = ['id', 'titre', 'description', 'duree', 'duree_s', 'latitude', 'longitude', 'fichier', 'type', 'date_ajout', 'lien_drive'];
const LAST_COL = 'K';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SA_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const REQUIRED_VARS = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_SECRET', 'SPREADSHEET_ID'];

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', webm: 'audio/webm', weba: 'audio/webm'
};

// Caches en mémoire (par instance du worker)
let tokenCache = { token: null, exp: 0 };
let listCache = { data: null, exp: 0 };
let gidCache = null;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname.replace(/\/+$/, '') || '/'}`;

    let res;
    try {
      switch (route) {
        case 'GET /':
        case 'GET /list':
          res = await handleList(request, env);
          break;
        case 'GET /health':
          res = await handleHealth(request, env);
          break;
        case 'POST /login':
          await requireAdmin(request, env);
          res = json({ ok: true });
          break;
        case 'POST /upload':
          await requireAdmin(request, env);
          res = await handleUpload(request, env);
          break;
        case 'POST /update':
          await requireAdmin(request, env);
          res = await handleUpdate(request, env);
          break;
        case 'POST /delete':
          await requireAdmin(request, env);
          res = await handleDelete(request, env);
          break;
        default:
          res = json({ error: 'Route inconnue' }, 404);
      }
    } catch (err) {
      res = json({ error: err.message || String(err) }, err.status || 500);
    }

    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  }
};

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function handleList(request, env) {
  assertConfig(env);
  const fresh = new URL(request.url).searchParams.has('fresh');
  if (!fresh && listCache.data && Date.now() < listCache.exp) {
    return json(listCache.data, 200, { 'Cache-Control': 'public, max-age=15' });
  }
  const { rows } = await readRows(env);
  const items = rows.map(r => rowToItem(r.values));
  const data = { items, count: items.length, updatedAt: new Date().toISOString() };
  listCache = { data, exp: Date.now() + 15000 };
  return json(data, 200, { 'Cache-Control': fresh ? 'no-store' : 'public, max-age=15' });
}

async function handleHealth(request, env) {
  const keys = [...REQUIRED_VARS, 'ADMIN_PASSWORD'];
  const config = Object.fromEntries(keys.map(k => [k, Boolean(env[k])]));
  const out = { ok: Object.values(config).every(Boolean), config, sheetName: sheetName(env), allowedOrigins: env.ALLOWED_ORIGINS || '*' };

  if (new URL(request.url).searchParams.has('deep')) {
    out.checks = {};
    try {
      out.serviceAccount = serviceAccount(env).client_email;
      await getAccessToken(env);
      out.checks.serviceAccount = 'ok';
    } catch (e) { out.checks.serviceAccount = e.message; out.ok = false; }
    try {
      const values = await readValues(env);
      out.checks.sheet = `ok (${values.length} ligne(s) dans l'onglet "${sheetName(env)}")`;
    } catch (e) { out.checks.sheet = e.message; out.ok = false; }
    try {
      const d = await appsScript(env, 'ping');
      out.checks.appsScript = `ok (dossier "${d.folder}", propriétaire ${d.owner}, partage ${d.sharing})`;
    } catch (e) { out.checks.appsScript = e.message; out.ok = false; }
  }
  return json(out, out.ok ? 200 : 500);
}

async function handleUpload(request, env) {
  assertConfig(env);
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('multipart/form-data')) throw httpError(400, 'Envoi multipart/form-data attendu');

  const maxBytes = Number(env.MAX_UPLOAD_MB || 50) * 1024 * 1024;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len && len > maxBytes + 1024 * 1024) throw httpError(413, `Fichier trop volumineux (max ${env.MAX_UPLOAD_MB || 50} Mo)`);

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') throw httpError(400, 'Aucun fichier audio reçu');
  if (file.size > maxBytes) throw httpError(413, `Fichier trop volumineux (max ${env.MAX_UPLOAD_MB || 50} Mo)`);
  if (file.size === 0) throw httpError(400, 'Fichier vide');

  const mime = detectMime(file);
  if (!mime) throw httpError(415, 'Ce fichier ne semble pas être un fichier audio (mp3, m4a, wav, ogg, flac…)');

  const fileName = sanitizeFileName(file.name || 'audio');
  const title = cleanText(form.get('title'), 200) || fileName.replace(/\.[^.]+$/, '');
  const description = cleanText(form.get('description'), 5000);
  const { lat, lng } = parseCoords(form.get('lat'), form.get('lng'));
  const durS = toNum(form.get('duration'));
  const durationSeconds = durS && durS > 0 ? Math.round(durS * 10) / 10 : '';

  // 1. Fichier -> Drive
  const uploaded = await uploadToDrive(env, file, fileName, mime);

  // 2. Ligne -> Sheet (si ça échoue, on remet le fichier à la corbeille)
  try {
    const state = await readRows(env);
    await ensureHeader(env, state);
    const item = {
      id: uploaded.id,
      title,
      description,
      duration: durationSeconds ? formatDuration(durationSeconds) : '',
      durationSeconds,
      lat,
      lng,
      fileName,
      mimeType: mime,
      createdAt: new Date().toISOString(),
      driveUrl: `https://drive.google.com/file/d/${uploaded.id}/view`
    };
    await appendRow(env, itemToRow(item));
    listCache.exp = 0;
    return json({ ok: true, item }, 201);
  } catch (err) {
    await trashFile(env, uploaded.id).catch(() => {});
    throw err;
  }
}

async function handleUpdate(request, env) {
  assertConfig(env);
  const body = await readJson(request);
  const id = cleanId(body.id);
  const { rows } = await readRows(env);
  const row = rows.find(r => String(r.values[0]) === id);
  if (!row) throw httpError(404, 'Son introuvable dans la feuille');

  const item = rowToItem(row.values);
  if ('title' in body) {
    const t = cleanText(body.title, 200);
    if (!t) throw httpError(400, 'Le titre ne peut pas être vide');
    item.title = t;
  }
  if ('description' in body) item.description = cleanText(body.description, 5000);
  if ('lat' in body || 'lng' in body) Object.assign(item, parseCoords(body.lat ?? item.lat, body.lng ?? item.lng));

  await updateRow(env, row.rowNumber, itemToRow(item));
  listCache.exp = 0;
  return json({ ok: true, item });
}

async function handleDelete(request, env) {
  assertConfig(env);
  const body = await readJson(request);
  const id = cleanId(body.id);
  const { rows } = await readRows(env);
  const row = rows.find(r => String(r.values[0]) === id);
  if (!row) throw httpError(404, 'Son introuvable dans la feuille');

  await deleteRow(env, row.rowNumber);
  listCache.exp = 0;

  let warning;
  try { await trashFile(env, id); } catch (e) { warning = `Ligne supprimée, mais le fichier Drive n'a pas pu être mis à la corbeille : ${e.message}`; }
  return json({ ok: true, id, warning });
}

/* ------------------------------------------------------------------ */
/* Google : authentification par compte de service (JWT RS256)          */
/* ------------------------------------------------------------------ */

let saCache = null;
let keyCache = null;

function serviceAccount(env) {
  if (saCache) return saCache;
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { throw httpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON invalide : collez TOUT le contenu du fichier .json de la clé'); }
  if (!sa.client_email || !sa.private_key) throw httpError(500, 'GOOGLE_SERVICE_ACCOUNT_JSON : client_email ou private_key manquant');
  sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  saCache = sa;
  return sa;
}

async function signingKey(pem) {
  if (keyCache) return keyCache;
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  keyCache = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return keyCache;
}

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const sa = serviceAccount(env);
  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, scope: SA_SCOPE, aud: tokenUri, iat: now, exp: now + 3600
  }))}`;
  let key;
  try { key = await signingKey(sa.private_key); }
  catch (e) { throw httpError(500, `Clé privée du compte de service illisible : ${e.message}`); }
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw httpError(502, `Compte de service refusé par Google : ${data.error_description || data.error || res.status}`);
  }
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function google(env, url, init = {}) {
  const token = await getAccessToken(env);
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let msg = String(res.status);
    try { const d = await res.json(); msg = d.error?.message || d.error_description || JSON.stringify(d); } catch {}
    if (res.status === 403 || res.status === 404) msg += ` (la Sheet est-elle partagée en Éditeur avec ${serviceAccount(env).client_email} ?)`;
    throw httpError(502, `Google Sheets (${res.status}) : ${msg}`);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* Google Drive via Apps Script                                         */
/* ------------------------------------------------------------------ */

async function appsScript(env, action, payload = {}) {
  let res;
  try {
    res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.APPS_SCRIPT_SECRET, action, ...payload }),
      redirect: 'follow'
    });
  } catch (e) { throw httpError(502, `Apps Script injoignable : ${e.message}`); }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw httpError(502, `Réponse inattendue de l'Apps Script (URL /exec ? accès "Tout le monde" ?) : ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`); }
  if (!data.ok) {
    const e = httpError(502, `Apps Script : ${data.error}`);
    e.code = data.code;
    throw e;
  }
  return data;
}

async function uploadToDrive(env, file, fileName, mime) {
  // 1. L'Apps Script (exécuté sous le compte propriétaire du dossier) ouvre une session d'envoi "resumable"
  const { uploadUrl } = await appsScript(env, 'createUploadSession', { name: fileName, mimeType: mime, size: file.size });
  if (!uploadUrl) throw httpError(502, 'L\'Apps Script n\'a pas renvoyé de session d\'envoi');

  // 2. Le worker envoie le contenu directement à Google Drive (pas de limite Apps Script)
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: await file.arrayBuffer() });
  if (!put.ok) throw httpError(502, `Envoi vers Google Drive échoué (${put.status}) : ${(await put.text()).slice(0, 300)}`);
  return put.json();
}

async function trashFile(env, fileId) {
  try {
    await appsScript(env, 'trash', { id: fileId });
  } catch (e) {
    if (e.code !== 'not_found') throw e; // déjà supprimé : pas grave
  }
}

/* ------------------------------------------------------------------ */
/* Google Sheets                                                       */
/* ------------------------------------------------------------------ */

function sheetName(env) { return env.SHEET_NAME || 'Sons'; }
function a1(env, range) { return `'${sheetName(env).replace(/'/g, "''")}'!${range}`; }
function valuesUrl(env, range) { return `${SHEETS}/${env.SPREADSHEET_ID}/values/${encodeURIComponent(a1(env, range))}`; }

async function readValues(env) {
  const res = await google(env, `${valuesUrl(env, `A:${LAST_COL}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
  const data = await res.json();
  return data.values || [];
}

async function readRows(env) {
  const values = await readValues(env);
  const hasHeader = values.length > 0 && String(values[0][0] ?? '').trim().toLowerCase() === 'id';
  const rows = [];
  values.forEach((v, i) => {
    if (i === 0 && hasHeader) return;
    if (!v || !v[0]) return;
    rows.push({ rowNumber: i + 1, values: v });
  });
  return { rows, hasHeader, count: values.length };
}

async function ensureHeader(env, state) {
  if (state.hasHeader || state.count > 0) return;
  await google(env, `${valuesUrl(env, `A1:${LAST_COL}1`)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [COLUMNS] })
  });
}

async function appendRow(env, row) {
  await google(env, `${valuesUrl(env, 'A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] })
  });
}

async function updateRow(env, rowNumber, row) {
  await google(env, `${valuesUrl(env, `A${rowNumber}:${LAST_COL}${rowNumber}`)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] })
  });
}

async function getSheetGid(env) {
  if (gidCache && gidCache.name === sheetName(env)) return gidCache.gid;
  const res = await google(env, `${SHEETS}/${env.SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`);
  const data = await res.json();
  const sheet = (data.sheets || []).find(s => s.properties.title === sheetName(env));
  if (!sheet) throw httpError(500, `Onglet "${sheetName(env)}" introuvable dans la Google Sheet`);
  gidCache = { name: sheetName(env), gid: sheet.properties.sheetId };
  return gidCache.gid;
}

async function deleteRow(env, rowNumber) {
  const gid = await getSheetGid(env);
  await google(env, `${SHEETS}/${env.SPREADSHEET_ID}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }]
    })
  });
}

function rowToItem(v) {
  const g = i => (v[i] === undefined || v[i] === null ? '' : v[i]);
  const id = String(g(0));
  return {
    id,
    title: String(g(1)),
    description: String(g(2)),
    duration: String(g(3)),
    durationSeconds: toNum(g(4)),
    lat: toNum(g(5)),
    lng: toNum(g(6)),
    fileName: String(g(7)),
    mimeType: String(g(8)),
    createdAt: String(g(9)),
    driveUrl: String(g(10)) || `https://drive.google.com/file/d/${id}/view`
  };
}

function itemToRow(it) {
  return [it.id, it.title, it.description, it.duration || '', it.durationSeconds ?? '', it.lat, it.lng, it.fileName || '', it.mimeType || '', it.createdAt || '', it.driveUrl || ''];
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allowed.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function requireAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) throw httpError(500, 'ADMIN_PASSWORD n\'est pas configuré dans le worker');
  const auth = request.headers.get('Authorization') || '';
  let given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  try { given = decodeURIComponent(given); } catch {}
  if (!(await safeEqual(given, env.ADMIN_PASSWORD))) {
    await new Promise(r => setTimeout(r, 600)); // ralentit les essais en série
    throw httpError(401, 'Mot de passe incorrect');
  }
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function assertConfig(env) {
  const missing = REQUIRED_VARS.filter(k => !env[k]);
  if (missing.length) throw httpError(500, `Variables manquantes dans le worker : ${missing.join(', ')}`);
}

async function readJson(request) {
  try { return await request.json(); } catch { throw httpError(400, 'JSON invalide'); }
}

function detectMime(file) {
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (file.type && file.type.startsWith('audio/')) return file.type;
  return MIME_BY_EXT[ext] || null; // certains navigateurs envoient video/webm ou application/octet-stream
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'audio';
}

function cleanText(v, max) {
  return String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function cleanId(id) {
  const s = String(id || '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(s)) throw httpError(400, 'Identifiant de son invalide');
  return s;
}

function toNum(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (x === null || x === undefined || x === '') return null;
  const n = parseFloat(String(x).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseCoords(lat, lng) {
  const la = toNum(lat), ln = toNum(lng);
  if (la === null || ln === null || la < -90 || la > 90 || ln < -180 || ln > 180) {
    throw httpError(400, 'Position invalide : choisissez un point sur la carte');
  }
  return { lat: Math.round(la * 1e6) / 1e6, lng: Math.round(ln * 1e6) / 1e6 };
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra }
  });
}
