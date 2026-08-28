import Chart from 'chart.js/auto';

let activeChartInstance = null;

/**
 * Renderiza o actualiza el gráfico de tendencias de los últimos 3 meses.
 * @param {string} canvasId ID del elemento canvas
 * @param {Object[]} historicalData Array de datos mensuales en orden cronológico
 */
export function renderTrendsChart(canvasId, historicalData) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  // Destruir gráfico activo si ya existe para evitar fugas de memoria o solapamiento
  if (activeChartInstance) {
    activeChartInstance.destroy();
    activeChartInstance = null; // Si no, la siguiente llamada destruye un gráfico ya destruido
  }

  // Si no hay datos históricos suficientes, ocultar o mostrar vacío
  if (!historicalData || historicalData.length === 0) {
    console.warn('No hay datos históricos para graficar.');
    return;
  }

  // Invertir si viene en orden descendente para mostrar cronología de izquierda a derecha
  const data = [...historicalData].slice(-3); // Máximo 3 meses

  // Extraer etiquetas y series
  const labels = data.map(d => {
    // Formatear mes (ej. Sep26 -> Sep 26)
    const match = d.month.match(/^([A-Za-z]{3,4})(\d{2})$/);
    return match ? `${match[1]} ${match[2]}` : d.month;
  });

  const realExpenses = data.map(d => d.totals.expenseReal || 0);
  const expectedExpenses = data.map(d => d.totals.expenseExpected || 0);
  
  const realSavings = data.map(d => {
    const income = d.totals.incomeReal || 0;
    const expense = d.totals.expenseReal || 0;
    return income - expense;
  });

  const ctx = canvas.getContext('2d');
  
  // Crear degradados premium para las barras y líneas
  const expenseRealGlow = ctx.createLinearGradient(0, 0, 0, 200);
  expenseRealGlow.addColorStop(0, 'rgba(139, 92, 246, 0.7)');
  expenseRealGlow.addColorStop(1, 'rgba(139, 92, 246, 0.05)');

  activeChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Gasto Real (€)',
          type: 'bar',
          data: realExpenses,
          backgroundColor: expenseRealGlow,
          borderColor: '#8b5cf6',
          borderWidth: 2,
          borderRadius: 6,
          order: 2,
          barPercentage: 0.55,
        },
        {
          label: 'Gasto Previsto (€)',
          type: 'bar',
          data: expectedExpenses,
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          borderColor: 'rgba(216, 180, 254, 0.3)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          borderRadius: 6,
          order: 3,
          barPercentage: 0.55,
        },
        {
          label: 'Ahorro Real (€)',
          type: 'line',
          data: realSavings,
          borderColor: '#10b981',
          borderWidth: 3,
          pointBackgroundColor: '#10b981',
          pointBorderColor: '#ffffff',
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          fill: false,
          tension: 0.3,
          order: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#d8b4fe',
            font: {
              family: 'Outfit',
              size: 11,
              weight: '500'
            },
            padding: 12,
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(18, 9, 31, 0.95)',
          titleColor: '#ffffff',
          titleFont: {
            family: 'Outfit',
            size: 13,
            weight: '600'
          },
          bodyColor: '#d8b4fe',
          bodyFont: {
            family: 'Inter',
            size: 12
          },
          borderColor: 'rgba(139, 92, 246, 0.3)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 10,
          displayColors: true,
          callbacks: {
            label: function(context) {
              // Quitar solo el sufijo " (€)": partir por espacios dejaba "Gasto"
              // como etiqueta tanto del gasto real como del previsto.
              const name = context.dataset.label.replace(/\s*\(€\)$/, '');
              return ` ${name}: ${context.raw.toLocaleString('es-ES', { minimumFractionDigits: 2 })} €`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: 'rgba(216, 180, 254, 0.6)',
            font: {
              family: 'Outfit',
              size: 11
            }
          }
        },
        y: {
          grid: {
            color: 'rgba(139, 92, 246, 0.08)',
            drawTicks: false
          },
          border: {
            dash: [4, 4]
          },
          ticks: {
            color: 'rgba(216, 180, 254, 0.6)',
            font: {
              family: 'Outfit',
              size: 11
            },
            callback: function(value) {
              return value + ' €';
            }
          }
        }
      }
    }
  });
}
