import './style.css';
import { fetchAvailableMonths, fetchMonthData } from './sheet_service.js';
import { renderTrendsChart } from './chart_service.js';
import { exportMonthsToPDF } from './pdf_service.js';
import { signIn, clearSession, setSessionLostHandler, getCurrentEmail } from './auth_service.js';

// --- CONFIGURACIÓN Y ESTADO DE LA APP ---
let availableMonths = []; // Array de {name}
let activeMonthData = null; // Datos ya parseados del mes en pantalla
let activeMonthName = '';
let activeDesgloseTab = 'expenses'; // 'expenses' | 'incomes'
let isRefreshing = false; // Evita recargas solapadas si se pulsa el botón varias veces
let loadToken = 0; // Identifica la carga en curso para descartar respuestas obsoletas
let historicalMonthsCache = {}; // Cache: { 'Sep26': monthData }

// Fallback por defecto indicado por el usuario
const DEFAULT_FALLBACK_MONTH = 'Sep26';

// --- ELEMENTOS DEL DOM ---
const monthSelect = document.getElementById('month-select');
const statusDot = document.getElementById('status-indicator-dot');
const statusText = document.getElementById('status-text');
const refreshBtn = document.getElementById('refresh-btn');
const signoutBtn = document.getElementById('signout-btn');

const appContainer = document.getElementById('app');
const loginScreen = document.getElementById('login-screen');
const googleButton = document.getElementById('google-button');
const loginError = document.getElementById('login-error');

const resumenView = document.getElementById('resumen-view');
const resumenSkeleton = document.getElementById('resumen-skeleton');
const resumenContent = document.getElementById('resumen-content');

const balanceIncomesReal = document.getElementById('balance-incomes-real');
const balanceIncomesExpected = document.getElementById('balance-incomes-expected');
const balanceExpensesReal = document.getElementById('balance-expenses-real');
const balanceExpensesExpected = document.getElementById('balance-expenses-expected');

const expensesProgressBar = document.getElementById('expenses-progress-bar');
const progressPercentageLabel = document.getElementById('progress-percentage-label');
const savingsRealVal = document.getElementById('savings-real-val');
const savingsExpectedVal = document.getElementById('savings-expected-val');

const jorgeContribReal = document.getElementById('jorge-contrib-real');
const jorgeContribExpected = document.getElementById('jorge-contrib-expected');
const joseContribReal = document.getElementById('jose-contrib-real');
const joseContribExpected = document.getElementById('jose-contrib-expected');

const toggleExpensesBtn = document.getElementById('toggle-expenses-btn');
const toggleIncomesBtn = document.getElementById('toggle-incomes-btn');
const itemsList = document.getElementById('items-list');

const pdfView = document.getElementById('pdf-view');
const pdfFromSelect = document.getElementById('pdf-from-select');
const pdfToSelect = document.getElementById('pdf-to-select');
const downloadPdfBtn = document.getElementById('download-pdf-btn');
const btnText = document.getElementById('btn-text');
const btnLoader = document.getElementById('btn-loader');

const tabResumen = document.getElementById('tab-resumen');
const tabPdf = document.getElementById('tab-pdf');

// --- REGISTRO DEL SERVICE WORKER (PWA) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('Service Worker registrado con éxito:', reg.scope))
      .catch(err => console.error('Fallo al registrar el Service Worker:', err));
  });
}

// --- LOGICA DE FECHAS ---
/**
 * Genera el código de mes correspondiente a la fecha actual.
 * Ejemplo: Agosto 2026 -> Ago26.
 * @returns {string}
 */
function getCurrentMonthCode() {
  const date = new Date();
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  const m = months[date.getMonth()];
  const y = String(date.getFullYear()).slice(-2);
  return `${m}${y}`;
}

// --- UTILERÍAS DE FORMATO DE MONEDA ---
function formatCurrency(value) {
  if (value === null || value === undefined) return '-';
  return value.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

// --- NAVEGACIÓN ---
function switchView(targetView) {
  if (targetView === 'resumen') {
    resumenView.classList.add('active');
    pdfView.classList.remove('active');
    
    tabResumen.classList.add('active');
    tabResumen.setAttribute('aria-selected', 'true');
    tabPdf.classList.remove('active');
    tabPdf.setAttribute('aria-selected', 'false');
  } else if (targetView === 'pdf') {
    resumenView.classList.remove('active');
    pdfView.classList.add('active');
    
    tabResumen.classList.remove('active');
    tabResumen.setAttribute('aria-selected', 'false');
    tabPdf.classList.add('active');
    tabPdf.setAttribute('aria-selected', 'true');
  }
}

// --- EVENT LISTENERS NAVEGACIÓN ---
tabResumen.addEventListener('click', () => switchView('resumen'));
tabPdf.addEventListener('click', () => switchView('pdf'));

// --- RENDERIZADO DE LA INTERFAZ ---

/**
 * Muestra u oculta la pantalla de carga (skeleton screen).
 * @param {boolean} isLoading 
 */
function toggleLoading(isLoading) {
  resumenSkeleton.classList.toggle('hidden', !isLoading);
  resumenContent.classList.toggle('hidden', isLoading);
  if (isLoading) setStatus('syncing', 'Descargando datos...');
}

/**
 * Actualiza el indicador de conexión. Va aparte del skeleton: antes se restablecía
 * a "Sincronizado" desde el finally de la carga, así que un fallo acababa mostrando
 * el punto verde y un mensaje de éxito sobre una pantalla sin datos.
 * @param {'online'|'syncing'|'offline'} state
 * @param {string} text
 */
function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

/** Hora a la que se descargaron por última vez los datos, para el indicador. */
function syncedAtLabel() {
  const time = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return `Actualizado a las ${time}`;
}

/**
 * Construye una fila del desglose. Los textos se asignan con textContent y no con
 * innerHTML: los conceptos vienen de la hoja de cálculo y un "&" o un "<" en un
 * concepto rompería el marcado.
 * @returns {HTMLLIElement}
 */
function buildItemRow(name, expectedText, realText, realClass) {
  const li = document.createElement('li');
  li.className = 'item-row';

  const cells = [
    ['item-name', name],
    ['item-expected', expectedText],
    [realClass, realText],
  ];

  cells.forEach(([className, text]) => {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    li.appendChild(span);
  });

  return li;
}

/**
 * Renderiza la lista detallada de gastos o ingresos según el toggle activo.
 */
function renderDetailsList() {
  if (!activeMonthData) return;
  
  itemsList.innerHTML = '';
  const items = activeDesgloseTab === 'expenses' 
    ? activeMonthData.expenses 
    : activeMonthData.incomes;
  
  const totalLabel = activeDesgloseTab === 'expenses' ? 'TOTAL GASTOS' : 'TOTAL INGRESOS';
  const totalExpected = activeDesgloseTab === 'expenses' 
    ? activeMonthData.totals.expenseExpected 
    : activeMonthData.totals.incomeExpected;
  const totalReal = activeDesgloseTab === 'expenses' 
    ? activeMonthData.totals.expenseReal 
    : activeMonthData.totals.incomeReal;

  // Renderizar filas de ítems
  items.forEach(item => {
    const isPending = item.real === null;
    itemsList.appendChild(buildItemRow(
      item.name,
      formatCurrency(item.expected),
      isPending ? 'Pendiente' : formatCurrency(item.real),
      isPending ? 'item-real empty' : 'item-real filled'
    ));
  });

  // Renderizar fila de total inferior
  const totalLi = buildItemRow(totalLabel, formatCurrency(totalExpected), formatCurrency(totalReal), 'item-real filled');
  totalLi.classList.add('total-row');
  itemsList.appendChild(totalLi);
}

/**
 * Rellena los datos financieros en el panel de resumen.
 */
function populateSummaryPanel() {
  if (!activeMonthData) return;

  const data = activeMonthData;

  // Totales
  balanceIncomesReal.textContent = formatCurrency(data.totals.incomeReal);
  balanceIncomesExpected.textContent = `Previsto: ${formatCurrency(data.totals.incomeExpected)}`;
  balanceExpensesReal.textContent = formatCurrency(data.totals.expenseReal);
  balanceExpensesExpected.textContent = `Previsto: ${formatCurrency(data.totals.expenseExpected)}`;

  // Ahorro/Balance mensual
  const savingsReal = data.totals.incomeReal - data.totals.expenseReal;
  const savingsExpected = data.totals.incomeExpected - data.totals.expenseExpected;
  
  savingsRealVal.textContent = formatCurrency(savingsReal);
  savingsExpectedVal.textContent = formatCurrency(savingsExpected);
  
  if (savingsReal >= 0) {
    savingsRealVal.className = 'income-color';
  } else {
    savingsRealVal.className = 'expense-color';
  }

  // Barra de progreso de gastos vs ingresos reales
  let percentage = 0;
  if (data.totals.incomeReal > 0) {
    percentage = Math.round((data.totals.expenseReal / data.totals.incomeReal) * 100);
  } else if (data.totals.expenseReal > 0) {
    percentage = 100; // Si hay gastos pero no ingresos
  }
  
  expensesProgressBar.style.width = `${Math.min(percentage, 100)}%`;
  progressPercentageLabel.textContent = `${percentage}%`;

  // Cambiar color de la barra si se excede el 100% (déficit)
  if (percentage > 100) {
    expensesProgressBar.style.background = 'var(--expense-red)';
    progressPercentageLabel.className = 'progress-percentage expense-color';
  } else {
    expensesProgressBar.style.background = 'linear-gradient(90deg, var(--accent-violet) 0%, var(--accent-violet-light) 100%)';
    progressPercentageLabel.className = 'progress-percentage';
  }

  // Aportaciones de Jorge & José
  jorgeContribReal.textContent = formatCurrency(data.contributions.jorgeReal);
  jorgeContribExpected.textContent = `Previsto: ${formatCurrency(data.contributions.jorgeExpected)}`;
  
  joseContribReal.textContent = formatCurrency(data.contributions.joseReal);
  joseContribExpected.textContent = `Previsto: ${formatCurrency(data.contributions.joseExpected)}`;

  // Renderizar la lista
  renderDetailsList();
}

/**
 * Carga y dibuja los gráficos de tendencias incluyendo los meses anteriores disponibles.
 */
async function loadAndRenderTrends() {
  if (!activeMonthName) return;

  const activeIdx = availableMonths.findIndex(m => m.name === activeMonthName);
  if (activeIdx === -1) return;

  // Obtener hasta 3 meses de histórico (el seleccionado y hasta 2 anteriores)
  const startIndex = Math.max(0, activeIdx - 2);
  const trendMonthsRange = availableMonths.slice(startIndex, activeIdx + 1);

  // En paralelo: son meses independientes y en serie se sumaban las tres esperas.
  const results = await Promise.all(trendMonthsRange.map(async (monthObj) => {
    if (historicalMonthsCache[monthObj.name]) {
      return historicalMonthsCache[monthObj.name];
    }
    try {
      const monthData = await fetchMonthData(monthObj.name);
      historicalMonthsCache[monthObj.name] = monthData;
      return monthData;
    } catch (e) {
      console.warn(`No se pudieron cargar tendencias para el mes ${monthObj.name}:`, e);
      return null;
    }
  }));

  renderTrendsChart('trends-chart', results.filter(Boolean));
}

/**
 * Carga completa de la información de un mes.
 * @param {string} monthName Nombre de la pestaña
 */
async function loadFinancialData(monthName) {
  const selectedSheet = availableMonths.find(m => m.name === monthName);
  if (!selectedSheet) {
    console.error(`Pestaña no encontrada para el mes: ${monthName}`);
    return;
  }

  // Si se cambia de mes dos veces seguidas, la respuesta más lenta podía llegar la
  // última y pintar el mes equivocado. Solo el token más reciente puede escribir.
  loadToken += 1;
  const token = loadToken;
  const previousMonthName = activeMonthName;

  toggleLoading(true);
  try {
    let monthData;
    if (historicalMonthsCache[monthName]) {
      monthData = historicalMonthsCache[monthName];
    } else {
      monthData = await fetchMonthData(selectedSheet.name);
      historicalMonthsCache[monthName] = monthData;
    }

    if (token !== loadToken) return; // Otra carga posterior manda

    activeMonthData = monthData;
    activeMonthName = monthName;

    // Poblar paneles e interfaz
    populateSummaryPanel();

    // Cargar gráficos de tendencia
    await loadAndRenderTrends();

    if (token !== loadToken) return;
    setStatus('online', syncedAtLabel());
  } catch (error) {
    if (token !== loadToken) return;

    console.error('Error al cargar la información financiera:', error);
    setStatus('offline', 'Error de conexión. Inténtalo de nuevo.');

    // Dejar el selector sobre el mes que sigue en pantalla: si no, el desplegable
    // muestra un mes y las cifras son las del anterior.
    if (previousMonthName && previousMonthName !== monthName) {
      monthSelect.value = previousMonthName;
    }

    if (!error.sessionLost) {
      alert(`No se pudieron descargar los datos de ${monthName}: ${error.message}`);
    }
  } finally {
    if (token === loadToken) toggleLoading(false);
  }
}

/**
 * Rellena los tres selectores de mes a partir de `availableMonths`,
 * conservando la selección previa cuando el mes sigue existiendo.
 */
function populateMonthSelectors() {
  const previous = {
    month: monthSelect.value,
    from: pdfFromSelect.value,
    to: pdfToSelect.value,
  };

  monthSelect.innerHTML = '';
  pdfFromSelect.innerHTML = '';
  pdfToSelect.innerHTML = '';

  availableMonths.forEach(m => {
    // Reemplazar etiqueta visual por una más amigable (ej. Sep26 -> Sep 26)
    const match = m.name.match(/^([A-Za-z]{3,4})(\d{2})$/);
    const label = match ? `${match[1]} ${match[2]}` : m.name;

    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = label;

    monthSelect.appendChild(opt.cloneNode(true));
    pdfFromSelect.appendChild(opt.cloneNode(true));
    pdfToSelect.appendChild(opt.cloneNode(true));
  });

  const exists = (name) => availableMonths.some(m => m.name === name);
  if (exists(previous.month)) monthSelect.value = previous.month;
  if (exists(previous.from)) pdfFromSelect.value = previous.from;
  if (exists(previous.to)) pdfToSelect.value = previous.to;
}

/**
 * Vuelve a descargar todo desde Google Sheets, descartando lo ya cargado.
 * Relee también la lista de pestañas, así que un mes nuevo creado en el documento
 * aparece en el selector sin tener que tocar código ni volver a desplegar.
 */
async function refreshData() {
  if (isRefreshing) return;

  isRefreshing = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('is-refreshing');

  try {
    // Descartar lo cacheado en memoria para forzar la descarga de todos los meses
    historicalMonthsCache = {};

    // Releer las pestañas. Si falla, seguimos con las que ya conocíamos:
    // es preferible refrescar solo las cifras a dejar la pantalla sin datos.
    try {
      const months = await fetchAvailableMonths();
      if (months.length > 0) {
        availableMonths = months;
        populateMonthSelectors();

        if (!availableMonths.some(m => m.name === activeMonthName)) {
          activeMonthName = availableMonths[availableMonths.length - 1].name;
          monthSelect.value = activeMonthName;
        }
      }
    } catch (error) {
      console.warn('No se pudo releer la lista de pestañas, se mantiene la anterior:', error);
    }

    await loadFinancialData(activeMonthName);
  } finally {
    isRefreshing = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('is-refreshing');
  }
}

// --- EVENT LISTENERS DE CONTROLES ---

// Botón de actualización manual
refreshBtn.addEventListener('click', refreshData);

// Selector de mes en cabecera
monthSelect.addEventListener('change', (e) => {
  const selectedMonth = e.target.value;
  loadFinancialData(selectedMonth);
});

// Toggles de desglose (Gastos / Ingresos)
function setDesgloseTab(tab) {
  if (activeDesgloseTab === tab) return;
  activeDesgloseTab = tab;

  const showingExpenses = tab === 'expenses';
  toggleExpensesBtn.classList.toggle('active', showingExpenses);
  toggleIncomesBtn.classList.toggle('active', !showingExpenses);
  toggleExpensesBtn.setAttribute('aria-pressed', String(showingExpenses));
  toggleIncomesBtn.setAttribute('aria-pressed', String(!showingExpenses));

  renderDetailsList();
}

toggleExpensesBtn.addEventListener('click', () => setDesgloseTab('expenses'));
toggleIncomesBtn.addEventListener('click', () => setDesgloseTab('incomes'));

// Exportación a PDF
downloadPdfBtn.addEventListener('click', async () => {
  const fromVal = pdfFromSelect.value;
  const toVal = pdfToSelect.value;

  const fromIdx = availableMonths.findIndex(m => m.name === fromVal);
  const toIdx = availableMonths.findIndex(m => m.name === toVal);

  if (fromIdx === -1 || toIdx === -1) {
    alert('Selecciona un periodo válido.');
    return;
  }

  if (fromIdx > toIdx) {
    alert('El mes de inicio ("Desde") no puede ser posterior al mes de fin ("Hasta").');
    return;
  }

  // Activar estado de carga en el botón
  downloadPdfBtn.disabled = true;
  btnText.textContent = 'Generando...';
  btnLoader.classList.remove('hidden');

  try {
    const rangeSheets = availableMonths.slice(fromIdx, toIdx + 1);

    // En paralelo: en serie, un rango de doce meses encadenaba doce esperas seguidas.
    const rangeData = await Promise.all(rangeSheets.map(async (sheetObj) => {
      if (historicalMonthsCache[sheetObj.name]) {
        return historicalMonthsCache[sheetObj.name];
      }
      const data = await fetchMonthData(sheetObj.name);
      historicalMonthsCache[sheetObj.name] = data;
      return data;
    }));

    // Disparar exportación
    exportMonthsToPDF(rangeData, fromVal, toVal);
  } catch (error) {
    console.error('Error al generar el extracto PDF:', error);
    if (!error.sessionLost) {
      alert(`No se pudo generar el extracto: ${error.message}`);
    }
  } finally {
    // Restaurar estado del botón
    downloadPdfBtn.disabled = false;
    btnText.textContent = 'Descargar PDF';
    btnLoader.classList.add('hidden');
  }
});

// --- INICIALIZACIÓN ---
async function init() {
  toggleLoading(true);
  try {
    // 1. Fetch de pestañas
    availableMonths = await fetchAvailableMonths();
    
    if (availableMonths.length === 0) {
      throw new Error(
        'No se encontró ninguna pestaña con formato de mes (ej. Sep26) en el Google Sheet.'
      );
    }

    // fetchAvailableMonths ya las devuelve ordenadas cronológicamente.
    populateMonthSelectors();

    // 2. Determinar mes actual
    const currentCode = getCurrentMonthCode();
    const hasCurrentMonth = availableMonths.some(m => m.name === currentCode);
    
    // Si el mes actual no tiene pestaña, abrir Sep26; y si tampoco existe, el más reciente.
    if (hasCurrentMonth) {
      activeMonthName = currentCode;
    } else if (availableMonths.some(m => m.name === DEFAULT_FALLBACK_MONTH)) {
      activeMonthName = DEFAULT_FALLBACK_MONTH;
    } else {
      activeMonthName = availableMonths[availableMonths.length - 1].name;
    }

    // Configurar selectores
    monthSelect.value = activeMonthName;
    pdfFromSelect.value = activeMonthName;
    pdfToSelect.value = activeMonthName;

    // 3. Cargar datos del mes predeterminado
    await loadFinancialData(activeMonthName);

  } catch (error) {
    console.error('Fallo en la inicialización:', error);
    setStatus('offline', 'Error al conectar con la hoja de cálculo.');
    toggleLoading(false);

    // Si el problema es la sesión, ya se ha vuelto al login con el motivo
    if (!error.sessionLost) {
      alert(`Error al inicializar BaeCount: ${error.message}`);
    }
  }
}

// --- CONTROL DE ACCESO ---

/** Muestra la pantalla de acceso y oculta la app. */
function showLogin(message) {
  loginScreen.classList.remove('hidden');
  appContainer.classList.add('hidden');

  if (message) {
    loginError.textContent = message;
    loginError.classList.remove('hidden');
  } else {
    loginError.classList.add('hidden');
  }
}

/** Oculta la pantalla de acceso y muestra la app. */
function showApp() {
  loginScreen.classList.add('hidden');
  appContainer.classList.remove('hidden');
  loginError.classList.add('hidden');
}

/**
 * Espera a que el usuario inicie sesión y arranca la app.
 * Si el servidor rechaza la cuenta, se vuelve aquí con el motivo.
 */
async function startSession(message) {
  showLogin(message);

  try {
    await signIn(googleButton);
  } catch (error) {
    console.error('Fallo al iniciar sesión:', error);
    showLogin(error.message);
    return;
  }

  showApp();

  const email = getCurrentEmail();
  if (email) signoutBtn.title = `Cerrar sesión (${email})`;

  await init();
}

// El servidor manda: si rechaza el token o el correo, se vuelve al login.
setSessionLostHandler((reason) => {
  startSession(reason);
});

signoutBtn.addEventListener('click', () => {
  clearSession();
});

// Ejecutar al cargar la página
window.addEventListener('DOMContentLoaded', () => startSession());

// Al volver atrás/adelante (o al reabrir la PWA) el navegador puede restaurar la página
// desde la bfcache sin lanzar DOMContentLoaded. En ese caso los datos en pantalla son
// los de la última visita, así que los volvemos a descargar.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && availableMonths.length > 0 && !appContainer.classList.contains('hidden')) {
    refreshData();
  }
});
