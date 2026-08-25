import './style.css';
import { fetchAvailableMonths, fetchMonthData } from './sheet_service.js';
import { renderTrendsChart } from './chart_service.js';
import { exportMonthsToPDF } from './pdf_service.js';

// --- CONFIGURACIÓN Y ESTADO DE LA APP ---
let availableMonths = []; // Array de {name, gid}
let activeMonthName = '';
let activeDesgloseTab = 'expenses'; // 'expenses' | 'incomes'
let historicalMonthsCache = {}; // Cache: { 'Sep26': monthData }

// Fallback por defecto indicado por el usuario
const DEFAULT_FALLBACK_MONTH = 'Sep26';

// --- ELEMENTOS DEL DOM ---
const monthSelect = document.getElementById('month-select');
const statusDot = document.getElementById('status-indicator-dot');
const statusText = document.getElementById('status-text');

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
  if (isLoading) {
    resumenSkeleton.classList.remove('hidden');
    resumenContent.classList.add('hidden');
    statusDot.className = 'status-dot syncing';
    statusText.textContent = 'Descargando datos...';
  } else {
    resumenSkeleton.classList.add('hidden');
    resumenContent.classList.remove('hidden');
    statusDot.className = 'status-dot online';
    statusText.textContent = 'Sincronizado con Google Sheets';
  }
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
    const li = document.createElement('li');
    li.className = 'item-row';
    
    const isPending = item.real === null;
    const realValText = isPending ? 'Pendiente' : formatCurrency(item.real);
    const realValClass = isPending ? 'item-real empty' : 'item-real filled';

    li.innerHTML = `
      <span class="item-name">${item.name}</span>
      <span class="item-expected">${formatCurrency(item.expected)}</span>
      <span class="${realValClass}">${realValText}</span>
    `;
    itemsList.appendChild(li);
  });

  // Renderizar fila de total inferior
  const totalLi = document.createElement('li');
  totalLi.className = 'item-row total-row';
  totalLi.innerHTML = `
    <span class="item-name">${totalLabel}</span>
    <span class="item-expected">${formatCurrency(totalExpected)}</span>
    <span class="item-real filled">${formatCurrency(totalReal)}</span>
  `;
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

  const historicalData = [];

  for (let monthObj of trendMonthsRange) {
    try {
      if (historicalMonthsCache[monthObj.name]) {
        historicalData.push(historicalMonthsCache[monthObj.name]);
      } else {
        // Cargar en segundo plano
        const monthData = await fetchMonthData(monthObj.gid, monthObj.name);
        historicalMonthsCache[monthObj.name] = monthData;
        historicalData.push(monthData);
      }
    } catch (e) {
      console.warn(`No se pudieron cargar tendencias para el mes ${monthObj.name}:`, e);
    }
  }

  renderTrendsChart('trends-chart', historicalData);
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

  toggleLoading(true);
  try {
    let monthData;
    if (historicalMonthsCache[monthName]) {
      monthData = historicalMonthsCache[monthName];
    } else {
      monthData = await fetchMonthData(selectedSheet.gid, selectedSheet.name);
      historicalMonthsCache[monthName] = monthData;
    }
    
    activeMonthData = monthData;
    activeMonthName = monthName;

    // Poblar paneles e interfaz
    populateSummaryPanel();
    
    // Cargar gráficos de tendencia
    await loadAndRenderTrends();
  } catch (error) {
    console.error('Error al cargar la información financiera:', error);
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Error de conexión. Inténtalo de nuevo.';
    alert('No se pudieron descargar los datos de Google Sheets. Por favor, comprueba tu conexión.');
  } finally {
    toggleLoading(false);
  }
}

// --- EVENT LISTENERS DE CONTROLES ---

// Selector de mes en cabecera
monthSelect.addEventListener('change', (e) => {
  const selectedMonth = e.target.value;
  loadFinancialData(selectedMonth);
});

// Toggles de desglose (Gastos / Ingresos)
toggleExpensesBtn.addEventListener('click', () => {
  if (activeDesgloseTab === 'expenses') return;
  activeDesgloseTab = 'expenses';
  toggleExpensesBtn.classList.add('active');
  toggleIncomesBtn.classList.remove('active');
  renderDetailsList();
});

toggleIncomesBtn.addEventListener('click', () => {
  if (activeDesgloseTab === 'incomes') return;
  activeDesgloseTab = 'incomes';
  toggleIncomesBtn.classList.add('active');
  toggleExpensesBtn.classList.remove('active');
  renderDetailsList();
});

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
    const rangeData = [];

    // Recuperar datos de todos los meses en el rango
    for (let sheetObj of rangeSheets) {
      if (historicalMonthsCache[sheetObj.name]) {
        rangeData.push(historicalMonthsCache[sheetObj.name]);
      } else {
        const data = await fetchMonthData(sheetObj.gid, sheetObj.name);
        historicalMonthsCache[sheetObj.name] = data;
        rangeData.push(data);
      }
    }

    // Disparar exportación
    exportMonthsToPDF(rangeData, fromVal, toVal);
  } catch (error) {
    console.error('Error al generar el extracto PDF:', error);
    alert('Ocurrió un error al descargar los datos del rango seleccionado.');
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
      throw new Error('No se encontraron pestañas válidas de meses en el Google Sheet.');
    }

    // Ordenar cronológicamente (esperando que Google Sheets las devuelva en orden, pero podemos validar)
    // Google Sheets pubhtml suele listar en el orden en que están colocadas las pestañas.
    // Llenar selectores del DOM
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

    // 2. Determinar mes actual
    const currentCode = getCurrentMonthCode();
    const hasCurrentMonth = availableMonths.some(m => m.name === currentCode);
    
    // Por directiva del usuario, si el mes actual no está disponible, abrir Sep26
    if (hasCurrentMonth) {
      activeMonthName = currentCode;
    } else {
      const hasSep26 = availableMonths.some(m => m.name === DEFAULT_FALLBACK_MONTH);
      activeMonthName = hasSep26 ? DEFAULT_FALLBACK_MONTH : availableMonths[0].name;
    }

    // Configurar selectores
    monthSelect.value = activeMonthName;
    pdfFromSelect.value = activeMonthName;
    pdfToSelect.value = activeMonthName;

    // 3. Cargar datos del mes predeterminado
    await loadFinancialData(activeMonthName);

  } catch (error) {
    console.error('Fallo en la inicialización:', error);
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'Error al conectar con la hoja de cálculo.';
    alert('Error al inicializar BaeCount. Asegúrate de que el documento Google Sheets está publicado correctamente.');
  } finally {
    toggleLoading(false);
  }
}

// Ejecutar init al cargar la página
window.addEventListener('DOMContentLoaded', init);
