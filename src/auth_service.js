/**
 * Inicio de sesión con Google en el navegador.
 *
 * Usa Google Identity Services: el botón devuelve un ID token (un JWT firmado por
 * Google) que se manda una sola vez a /api/session. El servidor lo valida, comprueba
 * la lista blanca de correos y responde con una cookie de sesión HttpOnly que dura 24
 * horas. A partir de ahí el navegador la reenvía sola en cada petición a /api, así que
 * la app no guarda ningún token: cerrar la pestaña o la PWA ya no pierde la sesión.
 *
 * Quién puede entrar de verdad lo decide el servidor; aquí no se toma ninguna decisión
 * de seguridad.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const SESSION_URL = '/api/session';

let currentEmail = null;
let onSessionLost = null;
let initialized = false;
// Resolvers de la espera de login en curso: el callback de Google es único para toda
// la página, así que se guarda aquí a quién hay que avisar cuando llegue el token.
let pending = null;

/** Carga el script de Google una sola vez. */
function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('No se pudo cargar el inicio de sesión de Google.')));
      return;
    }

    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('No se pudo cargar el inicio de sesión de Google.'));
    document.head.appendChild(script);
  });
}

/** Correo con el que se ha iniciado sesión, para mostrarlo en la interfaz. */
export function getCurrentEmail() {
  return currentEmail;
}

/**
 * Registra qué hacer cuando el servidor rechaza la sesión (401/403), para que la app
 * pueda volver a la pantalla de login.
 * @param {(reason?: string) => void} handler
 */
export function setSessionLostHandler(handler) {
  onSessionLost = handler;
}

/**
 * Recupera la sesión guardada en la cookie, si sigue viva.
 * @returns {Promise<string|null>} El correo, o null si hay que iniciar sesión
 */
export async function restoreSession() {
  try {
    const response = await fetch(SESSION_URL, { method: 'GET', cache: 'no-store' });
    if (!response.ok) return null;

    const { email } = await response.json();
    currentEmail = email || null;
    return currentEmail;
  } catch {
    // Sin red no se puede confirmar la sesión: se pasa por el login como siempre.
    return null;
  }
}

/** Descarta la sesión en curso y avisa a la app. */
export function clearSession(reason) {
  currentEmail = null;

  // Que el servidor borre la cookie. No merece la pena esperar: la app ya vuelve al
  // login, y si la petición falla la cookie caduca sola.
  fetch(SESSION_URL, { method: 'DELETE', cache: 'no-store' }).catch(() => {});

  // Sin esto, el reingreso automático de Google volvería a entrar solo.
  window.google?.accounts?.id?.disableAutoSelect();

  if (onSessionLost) onSessionLost(reason);
}

/** Cambia el ID token de Google por la cookie de sesión del servidor. */
async function openSession(credential) {
  const response = await fetch(SESSION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ credential }),
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || 'No se pudo abrir la sesión.');
  }

  const { email } = await response.json();
  return email || null;
}

/**
 * Pinta el botón de Google y espera a que el usuario inicie sesión.
 * @param {HTMLElement} buttonContainer Dónde dibujar el botón
 * @returns {Promise<string>} El correo con el que se ha entrado
 */
export async function signIn(buttonContainer) {
  const response = await fetch('/api/config');
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || 'No se pudo obtener la configuración de inicio de sesión.');
  }
  const { clientId } = await response.json();

  await loadGoogleScript();

  return new Promise((resolve, reject) => {
    pending = { resolve, reject };

    // initialize() solo debe llamarse una vez por página; en los reintentos basta
    // con volver a dibujar el botón.
    if (!initialized) {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async (credentialResponse) => {
          const waiting = pending;
          pending = null;
          if (!waiting) return;

          try {
            currentEmail = await openSession(credentialResponse.credential);
            waiting.resolve(currentEmail);
          } catch (error) {
            waiting.reject(error);
          }
        },
        // Reentrada automática: si la cookie ha caducado (24 h) y la sesión de Google
        // sigue viva, se vuelve a entrar sin tocar nada. Al cerrar sesión se desactiva
        // (disableAutoSelect), así que sigue siendo posible entrar con otra cuenta.
        auto_select: true,
        cancel_on_tap_outside: true,
      });
      initialized = true;
    }

    buttonContainer.innerHTML = '';
    window.google.accounts.id.renderButton(buttonContainer, {
      type: 'standard',
      theme: 'filled_black',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      logo_alignment: 'left',
      locale: 'es',
    });

    // Intenta reanudar la sesión sin intervención. Si no hay ninguna que reanudar,
    // no ocurre nada y el usuario usa el botón que acabamos de dibujar.
    window.google.accounts.id.prompt();
  });
}
