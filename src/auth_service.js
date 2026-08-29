/**
 * Inicio de sesión con Google en el navegador.
 *
 * Usa Google Identity Services: el botón devuelve un ID token (un JWT firmado por
 * Google) que se guarda solo en memoria y se manda en cada petición a /api. Quién
 * puede entrar de verdad lo decide el servidor comparando el correo del token con
 * la lista blanca; aquí no se toma ninguna decisión de seguridad.
 *
 * El token dura una hora. Cuando caduca, el servidor responde 401 y la app vuelve a
 * pedir el inicio de sesión.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';

let idToken = null;
let currentEmail = null;
let onSessionLost = null;
let initialized = false;
// Resolver de la espera de login en curso: el callback de Google es único para toda
// la página, así que se guarda aquí a quién hay que avisar cuando llegue el token.
let pendingResolve = null;

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

/** Lee el payload de un JWT sin verificarlo: solo para mostrar el correo en la interfaz. */
function readTokenPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
        .join('')
    );
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** ID token actual, o null si no hay sesión. */
export function getIdToken() {
  return idToken;
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

/** Descarta la sesión en curso y avisa a la app. */
export function clearSession(reason) {
  idToken = null;
  currentEmail = null;
  window.google?.accounts?.id?.disableAutoSelect();
  if (onSessionLost) onSessionLost(reason);
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

  return new Promise((resolve) => {
    pendingResolve = resolve;

    // initialize() solo debe llamarse una vez por página; en los reintentos basta
    // con volver a dibujar el botón.
    if (!initialized) {
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: (credentialResponse) => {
          idToken = credentialResponse.credential;
          currentEmail = readTokenPayload(idToken).email || null;

          const resolveNow = pendingResolve;
          pendingResolve = null;
          if (resolveNow) resolveNow(currentEmail);
        },
        // Reentrada automática: el gesto de tirar para actualizar recarga la página
        // entera, y sin esto habría que pulsar el botón de Google en cada refresco.
        // Al cerrar sesión se desactiva (disableAutoSelect), así que sigue siendo
        // posible entrar con otra cuenta.
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
