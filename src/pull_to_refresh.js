/**
 * Tirar para actualizar, el gesto de siempre en móvil: se arrastra hacia abajo desde
 * el principio de la lista, aparece una flecha, y al soltar se recargan los datos.
 * Si se vuelve hacia arriba antes de soltar, el gesto se cancela sin recargar.
 *
 * Solo se activa en pantallas táctiles y cuando el contenido ya está arriba del todo:
 * si no, se está haciendo scroll normal y no hay que estorbar.
 */

// A partir de aquí, soltar recarga
const THRESHOLD = 72;

// Tope al que satura el arrastre por mucho que se estire
const MAX_PULL = 112;

/**
 * Convierte el recorrido real del dedo en el que se muestra. La curva satura en
 * MAX_PULL, así que al principio el indicador sigue al dedo y luego se va frenando:
 * sin esto, el gesto se siente flojo y se pasa de largo sin querer.
 * @param {number} distance
 * @returns {number}
 */
function damp(distance) {
  return MAX_PULL * (1 - Math.exp(-distance / MAX_PULL));
}

/**
 * @param {Object} options
 * @param {HTMLElement} options.container Elemento con scroll
 * @param {HTMLElement} options.indicator Elemento que se desplaza y gira
 * @param {() => Promise<void>} options.onRefresh Qué hacer al soltar pasado el umbral
 * @param {() => boolean} [options.enabled] Si devuelve false, el gesto se ignora
 */
export function enablePullToRefresh({ container, indicator, onRefresh, enabled }) {
  if (!container || !indicator) return;

  // En un ratón no hay gesto que capturar
  if (!('ontouchstart' in window)) return;

  // En el layout de escritorio quien se desplaza es el documento, no este contenedor,
  // así que su scrollTop sería siempre 0 y el gesto saltaría en cualquier toque. Los
  // portátiles con pantalla táctil entran por aquí.
  const isDesktopLayout = window.matchMedia('(min-width: 1024px)');

  const arrow = indicator.querySelector('.ptr-arrow');

  let startY = 0;
  let pull = 0;          // recorrido ya amortiguado
  let tracking = false;  // el dedo está en un gesto candidato
  let active = false;    // el gesto es ya un tirón, no un scroll
  let refreshing = false;
  let passedThreshold = false;

  const isEnabled = () => !isDesktopLayout.matches && (enabled ? enabled() : true);

  function paint(distance, animated) {
    indicator.style.transition = animated
      ? 'transform .28s cubic-bezier(.22,.61,.36,1), opacity .28s ease'
      : 'none';
    indicator.style.transform = `translate(-50%, ${distance}px)`;

    const progress = Math.min(1, distance / THRESHOLD);
    indicator.style.opacity = String(Math.min(1, progress * 1.3));

    if (arrow) {
      arrow.style.transition = animated ? 'transform .2s ease' : 'none';
      // La flecha acompaña al gesto y completa media vuelta justo al llegar al umbral
      arrow.style.transform = `rotate(${progress * 180}deg) scale(${0.7 + progress * 0.3})`;
    }
  }

  function reset(animated = true) {
    pull = 0;
    active = false;
    passedThreshold = false;
    indicator.classList.remove('is-ready', 'is-refreshing');
    paint(0, animated);
  }

  container.addEventListener('touchstart', (event) => {
    if (refreshing || !isEnabled() || event.touches.length !== 1) return;
    // Solo cuenta si ya estamos arriba del todo; si no, es scroll normal
    if (container.scrollTop > 0) return;

    startY = event.touches[0].clientY;
    tracking = true;
    active = false;
  }, { passive: true });

  container.addEventListener('touchmove', (event) => {
    if (!tracking || refreshing) return;

    const delta = event.touches[0].clientY - startY;

    // Hacia arriba: es scroll, o el usuario está deshaciendo el gesto
    if (delta <= 0) {
      if (active) {
        pull = 0;
        paint(0, false);
        indicator.classList.remove('is-ready');
        passedThreshold = false;
      }
      // Si el contenido ya no está arriba, el gesto deja de ser candidato
      if (container.scrollTop > 0) tracking = false;
      return;
    }

    // Si mientras tanto se ha desplazado el contenido, no es un tirón
    if (container.scrollTop > 0) {
      tracking = false;
      if (active) reset();
      return;
    }

    active = true;
    pull = damp(delta);

    // Cancela el rebote y el tirar-para-actualizar propio del navegador
    if (event.cancelable) event.preventDefault();

    paint(pull, false);

    const ready = pull >= THRESHOLD;
    if (ready !== passedThreshold) {
      passedThreshold = ready;
      indicator.classList.toggle('is-ready', ready);
      // Un toque de vibración al cruzar el umbral, como en las apps del sistema
      if (ready && navigator.vibrate) navigator.vibrate(8);
    }
  }, { passive: false });

  async function release() {
    if (!tracking) return;
    tracking = false;

    if (!active) return;

    if (pull < THRESHOLD) {
      reset();
      return;
    }

    refreshing = true;
    indicator.classList.remove('is-ready');
    indicator.classList.add('is-refreshing');
    paint(THRESHOLD, true);

    try {
      await onRefresh();
    } finally {
      refreshing = false;
      reset();
    }
  }

  container.addEventListener('touchend', release, { passive: true });
  container.addEventListener('touchcancel', () => {
    tracking = false;
    if (active && !refreshing) reset();
  }, { passive: true });
}
