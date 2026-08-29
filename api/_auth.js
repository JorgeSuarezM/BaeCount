/**
 * Autenticación compartida por las funciones de /api.
 *
 * Dos cosas distintas que conviene no mezclar:
 *
 *  1. Quién entra en la app. El navegador manda el ID token que emite "Iniciar sesión
 *     con Google" y aquí se comprueba su firma contra las claves públicas de Google,
 *     que va dirigido a nuestro cliente OAuth y que el correo está en ALLOWED_EMAILS.
 *
 *  2. Con qué permisos se lee la hoja. La app usa una cuenta de servicio propia, que
 *     tiene acceso de solo lectura al documento. Las credenciales viven en variables
 *     de entorno y nunca llegan al navegador.
 *
 * La lista de correos es la única barrera real: Google deja iniciar sesión a cualquier
 * cuenta aunque la app esté en modo de prueba, porque solo pedimos el perfil básico.
 */

import { OAuth2Client, JWT } from 'google-auth-library';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** Error con código HTTP, para que el handler responda con el estado adecuado. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
  return requireEnv('ALLOWED_EMAILS')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

let oauthClient = null;

/**
 * Comprueba que la petición viene de uno de los correos autorizados.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<string>} El correo verificado
 */
export async function requireAllowedUser(req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    throw new HttpError(401, 'Sesión no iniciada.');
  }

  const clientId = requireEnv('GOOGLE_CLIENT_ID');
  const permitted = allowedEmails();

  if (permitted.length === 0) {
    throw new HttpError(500, 'ALLOWED_EMAILS está vacía: no hay ningún correo autorizado.');
  }

  oauthClient = oauthClient || new OAuth2Client(clientId);

  let payload;
  try {
    // Valida firma, emisor, caducidad y que el token sea para NUESTRO cliente:
    // sin comprobar el audience, valdría un token emitido para cualquier otra app.
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'Sesión caducada o no válida. Vuelve a iniciar sesión.');
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
