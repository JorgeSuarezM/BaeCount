/**
 * Autenticación compartida por los endpoints de /api.
 *
 * Tres cosas distintas que conviene no mezclar:
 *
 *  1. Quién entra en la app. El navegador manda el ID token que emite "Iniciar sesión
 *     con Google" y aquí se comprueba su firma contra las claves públicas de Google,
 *     que va dirigido a nuestro cliente OAuth y que el correo está en ALLOWED_EMAILS.
 *
 *  2. Cómo se recuerda la sesión. Ese ID token dura una hora y solo existe mientras la
 *     pestaña está abierta, así que en cuanto se valida emitimos una sesión propia:
 *     un token corto firmado con SESSION_SECRET que viaja en una cookie HttpOnly de 24
 *     horas. Al ser HttpOnly no la puede leer ningún script de la página, y al ser una
 *     cookie el navegador la reenvía sola cuando se reabre la web o la PWA.
 *
 *  3. Con qué permisos se lee la hoja. La app usa una cuenta de servicio propia, que
 *     tiene acceso de solo lectura al documento. Las credenciales viven en variables
 *     de entorno y nunca llegan al navegador.
 *
 * La lista de correos es la única barrera real: Google deja iniciar sesión a cualquier
 * cuenta aunque la app esté en modo de prueba, porque solo pedimos el perfil básico.
 * Se vuelve a comprobar en cada petición, no solo al entrar, para que quitar un correo
 * de ALLOWED_EMAILS cierre también las sesiones que ya estaban abiertas.
 *
 * Las funciones que tocan cookies reciben el contexto del endpoint de Astro, que es
 * quien sabe leer y escribir las cabeceras de la petición en curso.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, JWT } from 'google-auth-library';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Nombre de la cookie de sesión. */
const SESSION_COOKIE = 'baecount_session';

/** Cuánto dura la sesión sin volver a pasar por Google. */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Error con código HTTP, para que el endpoint responda con el estado adecuado. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Respuesta JSON sin caché: las cifras cambian a mano en la hoja. */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    },
  });
}

/** Traduce cualquier fallo del endpoint a una respuesta con el estado correcto. */
export function errorResponse(error, context) {
  if (error instanceof HttpError) {
    return json({ error: error.message }, error.status);
  }

  console.error(`Error inesperado en ${context}:`, error);
  return json({ error: `Error interno en ${context}.` }, 500);
}

/** Lee una variable de entorno obligatoria y avisa claramente si falta. */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new HttpError(500, `Falta la variable de entorno ${name} en el proyecto de Vercel.`);
  }
  return value;
}

/** Correos autorizados, normalizados a minúsculas. */
function allowedEmails() {
  const permitted = requireEnv('ALLOWED_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (permitted.length === 0) {
    throw new HttpError(500, 'ALLOWED_EMAILS está vacía: no hay ningún correo autorizado.');
  }

  return permitted;
}

// --- Sesión propia ---------------------------------------------------------

const base64url = (value) => Buffer.from(value).toString('base64url');

/** Firma el cuerpo del token con el secreto del servidor. */
function sign(body) {
  return createHmac('sha256', requireEnv('SESSION_SECRET')).update(body).digest('base64url');
}

/**
 * Emite el token de sesión para un correo ya verificado.
 * @param {string} email
 * @returns {string} token con formato cuerpo.firma
 */
function createSessionToken(email) {
  const payload = {
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = base64url(JSON.stringify(payload));

  return `${body}.${sign(body)}`;
}

/**
 * Comprueba la firma y la caducidad de un token de sesión.
 * @param {string} token
 * @returns {string} El correo que contiene
 */
function verifySessionToken(token) {
  const [body, signature] = String(token).split('.');

  if (!body || !signature) {
    throw new HttpError(401, 'Sesión no válida.');
  }

  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);

  // timingSafeEqual exige la misma longitud, así que se compara antes.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new HttpError(401, 'Sesión no válida.');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(401, 'Sesión no válida.');
  }

  if (!payload?.exp || payload.exp * 1000 <= Date.now()) {
    throw new HttpError(401, 'La sesión ha caducado. Vuelve a iniciar sesión.');
  }

  return String(payload.email || '').toLowerCase();
}

/**
 * Atributos comunes de la cookie. `secure` impide que viaje por HTTP, pero en
 * `astro dev` la app se sirve por http://localhost y la cookie se descartaría.
 * SameSite=Lax basta: todas las peticiones a /api salen de la propia app.
 */
function cookieOptions(url) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
  };
}

/**
 * Emite la cookie de sesión para un correo verificado.
 * @param {import('astro').APIContext} context
 * @param {string} email
 */
export function setSessionCookie({ cookies, url }, email) {
  cookies.set(SESSION_COOKIE, createSessionToken(email), {
    ...cookieOptions(url),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Borra la cookie de sesión (cerrar sesión).
 * @param {import('astro').APIContext} context
 */
export function clearSessionCookie({ cookies, url }) {
  cookies.delete(SESSION_COOKIE, cookieOptions(url));
}

// --- Google ----------------------------------------------------------------

let oauthClient = null;

/**
 * Valida el ID token que devuelve el botón de Google y comprueba la lista blanca.
 * @param {string} idToken
 * @returns {Promise<string>} El correo verificado
 */
export async function verifyGoogleIdToken(idToken) {
  if (!idToken) {
    throw new HttpError(400, 'Falta el token de Google.');
  }

  const clientId = requireEnv('GOOGLE_CLIENT_ID');
  const permitted = allowedEmails();

  oauthClient = oauthClient || new OAuth2Client(clientId);

  let payload;
  try {
    // Valida firma, emisor, caducidad y que el token sea para NUESTRO cliente:
    // sin comprobar el audience, valdría un token emitido para cualquier otra app.
    const ticket = await oauthClient.verifyIdToken({ idToken, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'El inicio de sesión de Google no es válido. Inténtalo de nuevo.');
  }

  const email = (payload?.email || '').toLowerCase();

  // Un correo sin verificar puede no pertenecer a quien dice ser
  if (!email || payload.email_verified !== true) {
    throw new HttpError(403, 'La cuenta de Google no tiene un correo verificado.');
  }

  if (!permitted.includes(email)) {
    throw new HttpError(403, 'Esta cuenta de Google no tiene acceso a BaeCount.');
  }

  return email;
}

/**
 * Comprueba que la petición trae una sesión viva de un correo autorizado.
 * @param {import('astro').APIContext} context
 * @returns {Promise<string>} El correo verificado
 */
export async function requireAllowedUser({ cookies }) {
  const cookie = cookies.get(SESSION_COOKIE)?.value;

  if (!cookie) {
    throw new HttpError(401, 'Sesión no iniciada.');
  }

  const email = verifySessionToken(cookie);

  // La lista puede haber cambiado desde que se emitió la cookie.
  if (!allowedEmails().includes(email)) {
    throw new HttpError(403, 'Esta cuenta de Google no tiene acceso a BaeCount.');
  }

  return email;
}

// --- Hoja de cálculo -------------------------------------------------------

let sheetsClient = null;

/** Cliente autenticado como la cuenta de servicio; reutiliza el token mientras sea válido. */
function getSheetsClient() {
  if (!sheetsClient) {
    sheetsClient = new JWT({
      email: requireEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
      // Vercel guarda los saltos de línea escapados, así que hay que devolverlos
      key: requireEnv('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
      scopes: [SHEETS_SCOPE],
    });
  }
  return sheetsClient;
}

/**
 * Llama a la API de Google Sheets con las credenciales de la cuenta de servicio.
 * @param {string} pathAndQuery Ruta bajo /v4/spreadsheets/{id}, ej. "/values/A1:C10"
 * @returns {Promise<Object>}
 */
export async function callSheetsApi(pathAndQuery) {
  const spreadsheetId = requireEnv('SPREADSHEET_ID');
  const { token } = await getSheetsClient().getAccessToken();

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${pathAndQuery}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const message = detail?.error?.message || `Google respondió ${response.status}.`;

    if (response.status === 403 || response.status === 404) {
      throw new HttpError(
        502,
        `No se pudo leer la hoja de cálculo (${message}). Comprueba que está compartida con la cuenta de servicio y que SPREADSHEET_ID es correcto.`
      );
    }
    throw new HttpError(502, `Error al leer la hoja de cálculo: ${message}`);
  }

  return response.json();
}
