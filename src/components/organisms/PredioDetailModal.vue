<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import {
  Eye,
  X,
  MapPin,
  Building,
  LandPlot,
  Maximize2,
  Ruler,
  Layers,
  Copy,
  Check,
  FileText,
  ShieldCheck,
  AlertCircle,
  Compass,
  Square,
  Sparkles
} from '@lucide/vue'

const props = defineProps({
  via: { type: Object, required: true }
})
const emit = defineEmits(['close'])

const visible = ref(true)
function requestClose() { visible.value = false }
function onAfterLeave() { emit('close') }

const pdfUrl = ref(null)
function openPdf(url) { pdfUrl.value = url }
function closePdf() { pdfUrl.value = null }

const desc = computed(() => props.via.description || {})
const name = computed(() => props.via.name || 'Predio Intervenido')

// ── Identificación principal ───────────────────────────────────────────────
const proyecto = computed(() => {
  return desc.value['Proyecto'] || desc.value['proyecto'] || desc.value['NOMBRE_PROYECTO'] || 'Sin proyecto asignado'
})

const municipio = computed(() => {
  return desc.value['Municipio'] || desc.value['municipio'] || ''
})

const sectorRaw = computed(() => {
  return desc.value['sector'] || desc.value['Sector'] || ''
})

const sectorLabel = computed(() => {
  const s = String(sectorRaw.value || '').trim().toUpperCase()
  if (s === 'R') return 'Sector Rural'
  if (s === 'U') return 'Sector Urbano'
  return s ? `Sector ${s}` : null
})

const matricula = computed(() => {
  const m = desc.value['Matricula'] ?? desc.value['matricula'] ?? desc.value['Matrícula']
  if (m === null || m === undefined || m === '' || String(m).trim().toUpperCase() === 'N/A') return null
  return String(m).trim()
})

const propietario = computed(() => {
  const p = desc.value['Propietari'] ?? desc.value['propietario'] ?? desc.value['Propietario']
  if (!p || String(p).trim().toUpperCase() === 'N/A') return null
  return String(p).trim()
})

const abscisa = computed(() => {
  const a = desc.value['ABS'] ?? desc.value['abs'] ?? desc.value['Abscisa'] ?? desc.value['abscisa']
  if (!a || String(a).trim().toUpperCase() === 'N/A') return null
  return String(a).trim()
})

const terrenoCodigo = computed(() => {
  const c = desc.value['terreno_co'] ?? desc.value['terreno_codigo'] ?? desc.value['codigo_predial']
  if (!c || String(c).trim().toUpperCase() === 'N/A') return null
  return String(c).trim()
})

const permiso = computed(() => {
  const p = desc.value['Permiso_Intervencion'] ?? desc.value['permiso_intervencion'] ?? desc.value['Permiso']
  if (!p) return null
  const clean = String(p).trim().toUpperCase()
  if (clean === 'SI' || clean === 'SÍ') return { label: 'Permiso Concedido', granted: true }
  if (clean === 'NO') return { label: 'Sin Permiso de Intervención', granted: false }
  return { label: `Permiso: ${p}`, granted: null }
})

// ── Copiar al portapapeles ────────────────────────────────────────────────
const copied = ref(false)
let copyTimer = null
async function copyTerreno() {
  if (!terrenoCodigo.value) return
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(terrenoCodigo.value)
    } else {
      const el = document.createElement('textarea')
      el.value = terrenoCodigo.value
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    }
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch (err) {
    console.error('Error al copiar:', err)
  }
}

// ── Métricas de Área ───────────────────────────────────────────────────────
function parseNum(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') return Number.isFinite(val) ? val : null
  const clean = String(val).replace(/m²/gi, '').replace(/,/g, '').trim()
  const num = Number.parseFloat(clean)
  return Number.isNaN(num) ? null : num
}

function formatAreaVal(val, fallbackVal = null) {
  const num = parseNum(val)
  const fallbackNum = parseNum(fallbackVal)

  if (num != null && num > 0) {
    return {
      formatted: new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(num) + ' m²',
      ha: num >= 10000 ? (num / 10000).toFixed(2) + ' ha' : null,
      isZero: false,
      isEstimated: false
    }
  }
  if ((num === 0 || num == null) && fallbackNum != null && fallbackNum > 0) {
    return {
      formatted: new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(fallbackNum) + ' m²',
      ha: fallbackNum >= 10000 ? (fallbackNum / 10000).toFixed(2) + ' ha' : null,
      isZero: false,
      isEstimated: true
    }
  }
  if (num === 0) {
    return { formatted: '0.00 m²', ha: null, isZero: true, isEstimated: false }
  }
  return { formatted: 'N/D', ha: null, isZero: true, isEstimated: false }
}

const shapeArea = computed(() => desc.value['Shape_Area'] ?? desc.value['shape_area'])
const shapeLength = computed(() => desc.value['Shape_Leng'] ?? desc.value['shape_length'])

const metrics = computed(() => {
  const total = formatAreaVal(desc.value['Area_Total'] ?? desc.value['area_total'], shapeArea.value)
  const requerida = formatAreaVal(desc.value['Area_Req'] ?? desc.value['Area_Requerida'] ?? desc.value['area_req'])
  const remanente = formatAreaVal(desc.value['Area_Rem'] ?? desc.value['Area_Remanente'] ?? desc.value['area_rem'])
  const sobrante = formatAreaVal(desc.value['AreaSobran'] ?? desc.value['Area_Sobrante'] ?? desc.value['areasobran'])

  const perimNum = parseNum(shapeLength.value)
  const perimetro = perimNum != null && perimNum > 0
    ? new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(perimNum) + ' m'
    : null

  return { total, requerida, remanente, sobrante, perimetro }
})

// ── Campos adicionales y estado ────────────────────────────────────────────
const handledKeys = new Set([
  'proyecto', 'municipio', 'sector', 'matricula', 'propietari', 'propietario', 'abs', 'abscisa',
  'terreno_co', 'terreno_codigo', 'codigo_predial', 'permiso_intervencion', 'permiso',
  'area_total', 'area_req', 'area_requerida', 'area_rem', 'area_remanente', 'areasobran', 'area_sobrante',
  'shape_leng', 'shape_length', 'shape_area', 'no', 'etiqueta', 'puntaje_union', 'metodo_union',
  'proyecto+matricula', 'abscisa_inicial', 'objectid', 'globalid', 'fillcolor', 'outlinecolor'
])

const modalOnlyKeys = new Set([
  'estado', 'estado_proyecto', 'estado proyecto', 'observaciones', 'observacion'
])

function friendlyLabel(k) {
  const cleaned = k.replace(/_/g, ' ').trim()
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

const extraFields = computed(() => {
  const result = []
  for (const [k, v] of Object.entries(desc.value)) {
    const lower = k.toLowerCase().replace(/\s+/g, '_')
    if (!handledKeys.has(lower) && !modalOnlyKeys.has(lower) && v !== null && v !== undefined && v !== '') {
      result.push({
        key: k,
        label: friendlyLabel(k),
        value: v,
        isLink: isLink(v)
      })
    }
  }
  return result
})

const hiddenDesc = computed(() => {
  const result = {}
  for (const [k, v] of Object.entries(desc.value)) {
    const lower = k.toLowerCase()
    if ((modalOnlyKeys.has(lower) || lower.includes('estado') || lower.includes('observaci')) && v !== '' && v !== null && v !== undefined) {
      result[k] = v
    }
  }
  return result
})
const hasHiddenData = computed(() => Object.keys(hiddenDesc.value).length > 0)

const estadoModalOpen = ref(false)
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

function isLink(v) {
  return typeof v === 'string' && (v.startsWith('http') || v.toLowerCase().includes('.pdf'))
}

function getLinkHref(v) {
  if (v.startsWith('http')) return v
  if (v.startsWith('/')) return `${base}${v}`
  return `${base}/${v}`
}

const onKey = (e) => {
  if (e.key === 'Escape') {
    if (pdfUrl.value) {
      closePdf()
    } else if (estadoModalOpen.value) {
      estadoModalOpen.value = false
    } else {
      requestClose()
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKey)
  document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKey)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer-anim" @after-leave="onAfterLeave">
      <div v-if="visible" class="drawer-backdrop" @click.self="requestClose">
        <aside class="drawer-panel" role="dialog" aria-modal="true" :aria-label="name">
          <!-- ── ENCABEZADO HERO ── -->
          <header class="drawer-hero">
            <div class="hero-top">
              <div class="hero-badge">
                <LandPlot class="icon-sm" />
                <span>{{ name }}</span>
              </div>
              <button class="hero-close" @click="requestClose" aria-label="Cerrar panel">
                <X class="icon-close" />
              </button>
            </div>

            <div class="hero-content">
              <h1 class="hero-title">{{ proyecto }}</h1>

              <div class="hero-tags">
                <span v-if="municipio" class="hero-pill location">
                  <MapPin class="icon-xs" />
                  {{ municipio }}
                </span>
                <span v-if="sectorLabel" class="hero-pill sector">
                  {{ sectorLabel }}
                </span>
                <span v-if="abscisa" class="hero-pill abscisa">
                  Abscisa: {{ abscisa }}
                </span>
              </div>
            </div>
          </header>

          <!-- ── CUERPO CON INFORMACIÓN ESTRUCTURADA ── -->
          <div class="drawer-body">

            <!-- Estado / Permiso de Intervención -->
            <div v-if="permiso" class="status-banner" :class="permiso.granted ? 'status-granted' : 'status-denied'">
              <component :is="permiso.granted ? ShieldCheck : AlertCircle" class="status-icon" />
              <div class="status-info">
                <span class="status-label">{{ permiso.label }}</span>
                <span class="status-sub">
                  {{ permiso.granted ? 'Autorización predial confirmada' : 'Pendiente de trámite o regularización' }}
                </span>
              </div>
            </div>

            <!-- Cédula Catastral (terreno_co) con Copiar -->
            <section v-if="terrenoCodigo" class="cadastral-card">
              <div class="cadastral-header">
                <div class="cadastral-title-group">
                  <span class="cadastral-eyebrow">Identificación Catastral</span>
                  <span class="cadastral-label">Cédula Catastral Nacional</span>
                </div>
                <button
                  type="button"
                  class="btn-copy"
                  :class="{ 'btn-copied': copied }"
                  @click="copyTerreno"
                  title="Copiar código al portapapeles"
                >
                  <component :is="copied ? Check : Copy" class="icon-xs" />
                  <span>{{ copied ? '¡Copiado!' : 'Copiar' }}</span>
                </button>
              </div>
              <div class="cadastral-code">
                <code>{{ terrenoCodigo }}</code>
              </div>
            </section>

            <!-- Datos Legales / Titularidad (Matrícula y Propietario) -->
            <section class="legal-grid">
              <div class="legal-card">
                <span class="legal-label">Matrícula Inmobiliaria</span>
                <div class="legal-val">
                  <span v-if="matricula" class="badge-matricula">{{ matricula }}</span>
                  <span v-else class="text-muted italic">Sin matrícula registrada</span>
                </div>
              </div>

              <div class="legal-card">
                <span class="legal-label">Propietario / Titular</span>
                <div class="legal-val">
                  <span v-if="propietario" class="font-medium text-slate-800">{{ propietario }}</span>
                  <span v-else class="text-muted italic">No reportado</span>
                </div>
              </div>
            </section>

            <!-- Cuadrícula de Métricas de Área -->
            <section class="metrics-section">
              <div class="section-heading">
                <h2 class="section-title">
                  <Maximize2 class="icon-section" />
                  Métricas de Área y Geometría
                </h2>
              </div>

              <div class="metrics-grid">
                <!-- Área Total -->
                <div class="metric-card" :class="{ 'metric-highlight': !metrics.total.isZero }">
                  <div class="metric-top">
                    <span class="metric-label">Área Total</span>
                    <div class="metric-icon-wrap bg-emerald">
                      <Square class="icon-metric" />
                    </div>
                  </div>
                  <div class="metric-val">{{ metrics.total.formatted }}</div>
                  <div class="metric-footer">
                    <span v-if="metrics.total.ha" class="badge-ha">{{ metrics.total.ha }}</span>
                    <span v-else-if="metrics.total.isEstimated" class="badge-sig" title="Cálculo geográfico estimado">
                      <Sparkles class="icon-nano" /> Polígono SIG
                    </span>
                    <span v-else class="metric-hint">Superficie base</span>
                  </div>
                </div>

                <!-- Área Requerida -->
                <div class="metric-card" :class="{ 'metric-req': !metrics.requerida.isZero }">
                  <div class="metric-top">
                    <span class="metric-label">Área Requerida</span>
                    <div class="metric-icon-wrap bg-amber">
                      <Layers class="icon-metric" />
                    </div>
                  </div>
                  <div class="metric-val">{{ metrics.requerida.formatted }}</div>
                  <div class="metric-footer">
                    <span v-if="metrics.requerida.ha" class="badge-ha">{{ metrics.requerida.ha }}</span>
                    <span v-else class="metric-hint">Franja de intervención</span>
                  </div>
                </div>

                <!-- Área Remanente -->
                <div class="metric-card">
                  <div class="metric-top">
                    <span class="metric-label">Área Remanente</span>
                    <div class="metric-icon-wrap bg-slate">
                      <Ruler class="icon-metric" />
                    </div>
                  </div>
                  <div class="metric-val">{{ metrics.remanente.formatted }}</div>
                  <div class="metric-footer">
                    <span v-if="metrics.remanente.ha" class="badge-ha">{{ metrics.remanente.ha }}</span>
                    <span v-else class="metric-hint">Porción restante</span>
                  </div>
                </div>

                <!-- Área Sobrante / Perímetro -->
                <div class="metric-card">
                  <div class="metric-top">
                    <span class="metric-label">{{ metrics.perimetro ? 'Perímetro' : 'Área Sobrante' }}</span>
                    <div class="metric-icon-wrap bg-slate">
                      <Compass class="icon-metric" />
                    </div>
                  </div>
                  <div class="metric-val">
                    {{ metrics.perimetro || metrics.sobrante.formatted }}
                  </div>
                  <div class="metric-footer">
                    <span v-if="metrics.perimetro" class="metric-hint">Longitud perimetral</span>
                    <span v-else-if="metrics.sobrante.ha" class="badge-ha">{{ metrics.sobrante.ha }}</span>
                    <span v-else class="metric-hint">Excedente</span>
                  </div>
                </div>
              </div>
            </section>

            <!-- Atributos adicionales (si existen) -->
            <section v-if="extraFields.length > 0" class="extra-section">
              <div class="section-heading">
                <h2 class="section-title">
                  <FileText class="icon-section" />
                  Información Técnica Adicional
                </h2>
              </div>

              <div class="attributes-list">
                <div v-for="item in extraFields" :key="item.key" class="attr-row">
                  <span class="attr-key">{{ item.label }}</span>
                  <div class="attr-val">
                    <template v-if="item.isLink">
                      <button
                        type="button"
                        class="btn-doc-link"
                        @click="openPdf(getLinkHref(item.value))"
                      >
                        <Eye class="icon-xs" />
                        Ver Documento
                      </button>
                    </template>
                    <template v-else>
                      {{ item.value }}
                    </template>
                  </div>
                </div>
              </div>
            </section>

          </div>

          <!-- ── PIE FIJO CON ACCIONES ── -->
          <footer v-if="hasHiddenData" class="drawer-footer">
            <button
              type="button"
              class="btn-full-details"
              @click="estadoModalOpen = true"
            >
              <FileText class="icon-sm" />
              <span>Ver Detalles Completos y Estado</span>
            </button>
          </footer>
        </aside>
      </div>
    </Transition>

    <!-- ── VISOR DE PDF INTERNO ── -->
    <Transition name="fade">
      <div v-if="pdfUrl" class="pdf-backdrop" @click.self="closePdf">
        <div class="pdf-modal">
          <header class="pdf-head">
            <h3 class="pdf-title">Visor de Documento Predial</h3>
            <button class="hero-close" @click="closePdf" aria-label="Cerrar Documento">
              <X class="icon-close" />
            </button>
          </header>
          <iframe :src="pdfUrl" class="pdf-iframe" title="Visor de PDF" frameborder="0"></iframe>
        </div>
      </div>
    </Transition>

    <!-- ── MODAL DETALLES OCULTOS / ESTADO DEL PROYECTO ── -->
    <Transition name="fade">
      <div
        v-if="estadoModalOpen"
        class="pdf-backdrop"
        @click.self="estadoModalOpen = false"
      >
        <div class="modal-card">
          <header class="modal-card-head">
            <div class="flex items-center gap-2">
              <Building class="icon-sm text-emerald-700" />
              <h3 class="modal-card-title">Detalles y Estado del Proyecto</h3>
            </div>
            <button class="modal-card-close" @click="estadoModalOpen = false" aria-label="Cerrar">
              <X class="icon-close" />
            </button>
          </header>

          <div class="modal-card-body">
            <div class="detail-cards-stack">
              <div v-for="(v, k) in hiddenDesc" :key="k" class="detail-card">
                <h4 class="detail-card-key">{{ k.replace(/_/g, ' ') }}</h4>
                <p class="detail-card-val">{{ v }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── FONDOS Y BACKDROP CON GLASSMORPHISM ── */
.drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(6, 44, 34, 0.35);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: flex-end;
}

.drawer-panel {
  background: #ffffff;
  width: 100%;
  max-width: 440px;
  height: 100vh;
  box-shadow: -8px 0 35px rgba(6, 44, 34, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slide-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

/* ── ENCABEZADO HERO ── */
.drawer-hero {
  background: linear-gradient(135deg, #064e3b 0%, #065f46 55%, #047857 100%);
  color: #ffffff;
  padding: 22px 24px 20px;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 15px rgba(6, 78, 59, 0.25);
}

.drawer-hero::before {
  content: '';
  position: absolute;
  top: -40px;
  right: -40px;
  width: 140px;
  height: 140px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.12) 0%, transparent 70%);
  pointer-events: none;
}

.hero-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(8px);
  padding: 4px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: #a7f3d0;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.hero-close {
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: #ffffff;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hero-close:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: rotate(90deg) scale(1.08);
}

.hero-content {
  position: relative;
  z-index: 1;
}

.hero-title {
  font-family: 'Prompt', 'Poppins', sans-serif;
  font-size: 19px;
  font-weight: 700;
  line-height: 1.35;
  margin: 0 0 12px 0;
  color: #ffffff;
  letter-spacing: -0.01em;
}

.hero-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.hero-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.2);
  color: #f0fdf4;
}

.hero-pill.location {
  background: rgba(255, 255, 255, 0.2);
  color: #ffffff;
}

.hero-pill.sector {
  background: rgba(16, 185, 129, 0.25);
  color: #d1fae5;
  border: 1px solid rgba(16, 185, 129, 0.35);
}

.hero-pill.abscisa {
  background: rgba(251, 191, 36, 0.2);
  color: #fef3c7;
  border: 1px solid rgba(251, 191, 36, 0.3);
}

/* ── CUERPO CON SCROLL ── */
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  background: #f8fafc;
}

/* ── ESTADO DEL PERMISO ── */
.status-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 10px;
  border-left: 4px solid transparent;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.03);
}

.status-granted {
  background: #ecfdf5;
  border-left-color: #059669;
  color: #065f46;
}

.status-denied {
  background: #fef2f2;
  border-left-color: #dc2626;
  color: #991b1b;
}

.status-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.status-info {
  display: flex;
  flex-direction: column;
}

.status-label {
  font-weight: 700;
  font-size: 13px;
}

.status-sub {
  font-size: 11px;
  opacity: 0.85;
}

/* ── CADASTRAL CARD (Cédula Catastral) ── */
.cadastral-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 14px 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.cadastral-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.cadastral-title-group {
  display: flex;
  flex-direction: column;
}

.cadastral-eyebrow {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #059669;
  font-weight: 700;
}

.cadastral-label {
  font-size: 13px;
  font-weight: 600;
  color: #1e293b;
}

.btn-copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 6px;
  background: #f1f5f9;
  color: #475569;
  border: 1px solid #cbd5e1;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-copy:hover {
  background: #e2e8f0;
  color: #0f172a;
}

.btn-copy.btn-copied {
  background: #059669;
  color: #ffffff;
  border-color: #059669;
}

.cadastral-code {
  background: #f1f5f9;
  padding: 9px 12px;
  border-radius: 8px;
  overflow-x: auto;
  border: 1px dashed #cbd5e1;
}

.cadastral-code code {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12.5px;
  color: #0f172a;
  letter-spacing: 0.05em;
  word-break: break-all;
  user-select: all;
  font-weight: 600;
}

/* ── DATOS LEGALES (Matrícula y Propietario) ── */
.legal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.legal-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}

.legal-label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  font-weight: 600;
  margin-bottom: 5px;
}

.legal-val {
  font-size: 13px;
  line-height: 1.3;
}

.badge-matricula {
  display: inline-block;
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 700;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.02em;
}

/* ── SECCIÓN DE MÉTRICAS (GRID 2x2) ── */
.metrics-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
  color: #334155;
  margin: 0;
}

.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.metric-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 13px 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.03);
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}

.metric-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 5px 12px rgba(0, 0, 0, 0.06);
  border-color: #cbd5e1;
}

.metric-card.metric-highlight {
  border-color: #a7f3d0;
  background: linear-gradient(180deg, #ffffff 0%, #f0fdf4 100%);
}

.metric-card.metric-req {
  border-color: #fde68a;
  background: linear-gradient(180deg, #ffffff 0%, #fffbeb 100%);
}

.metric-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.metric-label {
  font-size: 11.5px;
  font-weight: 600;
  color: #64748b;
}

.metric-icon-wrap {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.metric-icon-wrap.bg-emerald { background: #dcfce7; color: #059669; }
.metric-icon-wrap.bg-amber { background: #fef3c7; color: #d97706; }
.metric-icon-wrap.bg-slate { background: #f1f5f9; color: #64748b; }

.metric-val {
  font-family: 'Prompt', 'Poppins', sans-serif;
  font-size: 17px;
  font-weight: 700;
  color: #0f172a;
  line-height: 1.2;
  margin-bottom: 4px;
}

.metric-footer {
  display: flex;
  align-items: center;
  gap: 6px;
}

.badge-ha {
  font-size: 11px;
  font-weight: 700;
  background: #059669;
  color: #ffffff;
  padding: 1px 7px;
  border-radius: 12px;
}

.badge-sig {
  font-size: 10.5px;
  font-weight: 600;
  background: #dbeafe;
  color: #1e40af;
  padding: 1px 6px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.metric-hint {
  font-size: 10.5px;
  color: #94a3b8;
}

/* ── ATRIBUTOS ADICIONALES ── */
.extra-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.attributes-list {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.02);
}

.attr-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 11px 16px;
  border-bottom: 1px solid #f1f5f9;
  font-size: 13px;
}

.attr-row:last-child {
  border-bottom: none;
}

.attr-key {
  color: #64748b;
  font-weight: 500;
}

.attr-val {
  color: #0f172a;
  font-weight: 600;
  text-align: right;
  word-break: break-word;
  max-width: 60%;
}

.btn-doc-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  background: #ecfdf5;
  color: #065f46;
  border: 1px solid #a7f3d0;
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-doc-link:hover {
  background: #059669;
  color: #ffffff;
  transform: translateY(-1px);
}

/* ── PIE FIJO CON ACCIONES ── */
.drawer-footer {
  padding: 16px 22px;
  background: #ffffff;
  border-top: 1px solid #e2e8f0;
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.03);
}

.btn-full-details {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: linear-gradient(135deg, #065f46 0%, #047857 100%);
  color: #ffffff;
  border: none;
  border-radius: 10px;
  padding: 13px 20px;
  font-size: 14px;
  font-weight: 600;
  font-family: 'Prompt', sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(6, 95, 70, 0.25);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.btn-full-details:hover {
  background: linear-gradient(135deg, #047857 0%, #059669 100%);
  transform: translateY(-1.5px);
  box-shadow: 0 6px 18px rgba(6, 95, 70, 0.35);
}

.btn-full-details:active {
  transform: translateY(0);
}

/* ── MODAL FLOTANTE DE DETALLES Y ESTADO ── */
.modal-card {
  max-width: 620px;
  width: 92%;
  max-height: 85vh;
  background: #ffffff;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 35px -5px rgba(0, 0, 0, 0.2), 0 10px 15px -5px rgba(0, 0, 0, 0.05);
  overflow: hidden;
  animation: pop-up 0.25s ease-out;
}

@keyframes pop-up {
  from { transform: scale(0.96); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}

.modal-card-head {
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  padding: 18px 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-card-title {
  color: #064e3b;
  font-size: 17px;
  font-weight: 700;
  margin: 0;
  font-family: 'Prompt', sans-serif;
}

.modal-card-close {
  background: #e2e8f0;
  border: none;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #475569;
  cursor: pointer;
  transition: all 0.2s;
}

.modal-card-close:hover {
  background: #cbd5e1;
  color: #0f172a;
}

.modal-card-body {
  overflow-y: auto;
  flex: 1;
  padding: 22px;
  background: #f8fafc;
}

.detail-cards-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-card {
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.detail-card-key {
  margin: 0 0 6px 0;
  font-size: 11px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 700;
}

.detail-card-val {
  margin: 0;
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.5;
  color: #1e293b;
}

/* ── MODAL PDF ── */
.pdf-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(5px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.pdf-modal {
  background: #ffffff;
  width: 100%;
  max-width: 950px;
  height: 88vh;
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.pdf-head {
  background: #0f172a;
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pdf-title {
  margin: 0;
  font-family: 'Prompt', sans-serif;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.pdf-iframe {
  flex: 1;
  width: 100%;
  height: 100%;
  background: #f1f5f9;
}

/* ── ICONOS AUXILIARES ── */
.icon-close { width: 18px; height: 18px; }
.icon-sm { width: 17px; height: 17px; }
.icon-xs { width: 14px; height: 14px; }
.icon-nano { width: 12px; height: 12px; }
.icon-section { width: 16px; height: 16px; color: #059669; }
.icon-metric { width: 15px; height: 15px; }

/* ── ANIMACIONES DE ENTRADA Y SALIDA ── */
.drawer-anim-enter-active,
.drawer-anim-leave-active {
  transition: opacity 0.3s ease;
}

.drawer-anim-enter-active .drawer-panel,
.drawer-anim-leave-active .drawer-panel {
  transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
}

.drawer-anim-enter-from,
.drawer-anim-leave-to {
  opacity: 0;
}

.drawer-anim-enter-from .drawer-panel,
.drawer-anim-leave-to .drawer-panel {
  transform: translateX(100%);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ── UTILIDADES ── */
.flex { display: flex; }
.items-center { align-items: center; }
.gap-2 { gap: 8px; }
.text-emerald-700 { color: #047857; }
.text-slate-800 { color: #1e293b; }
.text-muted { color: #94a3b8; }
.font-medium { font-weight: 500; }
.italic { font-style: italic; }
</style>
