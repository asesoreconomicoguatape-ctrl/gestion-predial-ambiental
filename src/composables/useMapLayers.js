import { ref, shallowRef, onUnmounted } from 'vue'
import { getLocalizaciones, getMunicipios, getPuenteGavinoLocalizacion, getPuenteGavinoPrediosAfectados, getMiCasitaPrediosAfectados, getHeliconiaPrediosAfectados, getPuenteGavinoForestal, getPuenteGavinoCauce, getPuenteGavinoAbscisas, getArcgisInventarioForestal, getAreaIntervenidasVisor, getPrediosIntervenidosVisor, getDatosPredial, parseDescription } from '../services/api.js'
import { pctTiempoTranscurrido } from '../utils/stats.js'
import { parseAvancePct } from '../utils/via.js'
import { useMapStore } from '../stores/useMapStore.js'
import hitosData from '../data/hitos.json'

const normStr = s => (s ?? '').toLowerCase().normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').trim()
const normUp  = s => (s ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toUpperCase().trim()
const _circuitosConSeguimiento = new Set(Object.keys(hitosData).map(normStr))

function sentenceCase(str) {
  if (!str) return str
  const lower = str.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

const SUBREGIONES_FIJAS = [
  'Valle de aburrá', 'Oriente', 'Occidente', 'Norte',
  'Nordeste', 'Urabá', 'Bajo cauca', 'Magdalena medio', 'Suroeste',
]
const subNorm = SUBREGIONES_FIJAS.map(normStr)

function canonicalSub(raw) {
  const idx = subNorm.indexOf(normStr(sentenceCase(raw ?? '')))
  return idx !== -1 ? SUBREGIONES_FIJAS[idx] : sentenceCase(raw ?? '')
}

function _getMunicipiosPorSubregion(geoMunicipios, geoVias) {
  if (!geoMunicipios) return {}
  const municipiosConVias = new Set(geoVias?.features.map(f => sentenceCase(f.properties.MPIO_NOMBR)).filter(Boolean) ?? [])
  const map = {}
  for (const f of geoMunicipios.features) {
    const sub = canonicalSub(f.properties.SUBREGION)
    const mpio = sentenceCase(f.properties.MPIO_NOMBR)
    if (sub && mpio && municipiosConVias.has(mpio)) {
      if (!map[sub]) map[sub] = []
      if (!map[sub].includes(mpio)) map[sub].push(mpio)
    }
  }
  for (const arr of Object.values(map)) arr.sort((a, b) => a.localeCompare(b, 'es'))
  return map
}

export function useMapLayers(getMap, { onOptionsLoaded, onCatalogLoaded, onStatsLoaded } = {}, { buildCallouts, updateCalloutPositions } = {}) {
  const store          = useMapStore()
  const loading          = ref(true)
  const loadError        = ref(false)
  const hoverLabel       = ref({ name: '', x: 0, y: 0, visible: false })
  const viaHoverLabel    = ref({ name: '', km: null, x: 0, y: 0, visible: false })
  const selectedVia      = ref(null)
  const selectedMpio     = ref(null)

  const cachedMunicipios = ref(null)
  const cachedVias       = ref(null)
  const cachedLocalizaciones = ref(null)
  const cachedAreaIntervenidas = ref(null)
  const cachedPrediosIntervenidos = ref(null)
  const fromCache        = ref(false)

  let destroyed = false

  onUnmounted(() => { destroyed = true })

  function _buildProjectCatalog(geoLoc, geoAreaIntervenidas, jsonDatosPredial) {
    const norm = s => (s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ').trim()

    const proyToFuente = {}
    if (Array.isArray(jsonDatosPredial)) {
      for (const d of jsonDatosPredial) {
        const p = d.Proyecto || d.proyecto || d.NOMBRE_PROYECTO
        const f = d.Fuente_Financiacion || d['Fuente de financiación'] || d['Fuente de Financiación'] || d.FUENTE
        if (p && f) proyToFuente[norm(p)] = String(f).trim()
      }
    }
    if (geoAreaIntervenidas?.features) {
      for (const feat of geoAreaIntervenidas.features) {
        const p = feat.properties.Proyecto || feat.properties.proyecto
        const f = feat.properties.Fuente_Financiacion || feat.properties.fuente
        if (p && f && !proyToFuente[norm(p)]) proyToFuente[norm(p)] = String(f).trim()
      }
    }

    function resolveFuente(projectName) {
      const np = norm(projectName)
      if (proyToFuente[np]) return proyToFuente[np]
      if (np.includes('granada') || np.includes('majagual') || np.includes('recursos propios')) {
        return 'Recursos Propios'
      }
      const words = np.split(' ').filter(w => w.length > 3 && !['puente', 'para', 'san', 'los', 'las', 'del'].includes(w))
      for (const [key, f] of Object.entries(proyToFuente)) {
        if (words.some(w => key.includes(w))) return f
      }
      return 'Regalías'
    }

    const projectsSet = new Set()
    if (geoLoc?.features) {
      for (const f of geoLoc.features) {
        const name = f.properties.NOMBRE_PROYECTO
        if (name) projectsSet.add(name)
      }
    }
    if (geoAreaIntervenidas?.features) {
      for (const f of geoAreaIntervenidas.features) {
        const name = f.properties.Proyecto || f.properties.proyecto
        if (name) projectsSet.add(name)
      }
    }

    const catalog = []
    for (const name of projectsSet) {
      const lower = name.toLowerCase()
      const type = (lower.startsWith('puente') || lower.includes('casita')) ? 'puente' : 'pap'
      const fuente = resolveFuente(name)
      catalog.push({ name, fuente, type })
    }

    return { catalog, resolveFuente }
  }

  function _extractFilterOptions(geoMunicipios, geoVias, geoLoc, geoAreaIntervenidas, jsonDatosPredial) {
    const { catalog } = _buildProjectCatalog(geoLoc, geoAreaIntervenidas, jsonDatosPredial)

    const fuentes = ['Todas las fuentes', ...new Set(catalog.map(c => c.fuente).filter(Boolean))].sort((a, b) => a === 'Todas las fuentes' ? -1 : b === 'Todas las fuentes' ? 1 : a.localeCompare(b, 'es'))
    const puentes = ['Todos los puentes', ...new Set(catalog.filter(c => c.type === 'puente').map(c => c.name))].sort((a, b) => a === 'Todos los puentes' ? -1 : b === 'Todos los puentes' ? 1 : a.localeCompare(b, 'es'))
    const paps    = ['Todos los PAP y otros', ...new Set(catalog.filter(c => c.type === 'pap').map(c => c.name))].sort((a, b) => a === 'Todos los PAP y otros' ? -1 : b === 'Todos los PAP y otros' ? 1 : a.localeCompare(b, 'es'))

    onCatalogLoaded?.(catalog)
    onOptionsLoaded?.({ fuentes, puentes, paps })
  }

  function _calculateViasStats(geoVias, geoLoc, geoAreaIntervenidas, resolveFuente) {
    const viasDetalle = []
    let longitudTotal = 0
    const kmPorSubregion = {}

    if (geoLoc) {
      for (const f of geoLoc.features) {
        const p = f.properties
        const nombre = p.NOMBRE_PROYECTO ?? 'Sin nombre'
        const sub = canonicalSub(p.SUBREGION) ?? 'Sin subregión'
        const fuente = p.FUENTE_FINANCIACION || p.FUENTE_FIN || p.FUENTE || p.fuente || resolveFuente?.(nombre) || ''

        viasDetalle.push({
          nombre: nombre,
          subregion: sub,
          fuente: fuente,
          municipio: '',
          proyecto: nombre,
          km: 0,
          avance: 0,
          avanceFin: 0,
          estabilizado: 0,
          contratista: '',
          contrato: '',
          interventor: '',
          plazoMeses: 0,
          plazo: '',
          circuito: '',
          fechaIni: '',
        })
      }
    }
    
    if (geoAreaIntervenidas) {
      for (const f of geoAreaIntervenidas.features) {
        const p = f.properties
        const nombre = p.Proyecto || p.proyecto || 'Área Intervenida'
        const sub = 'Sin subregión'
        const fuente = p.Fuente_Financiacion || p.FUENTE_FINANCIACION || p.FUENTE_FIN || p.FUENTE || p.fuente || resolveFuente?.(nombre) || ''

        viasDetalle.push({
          nombre: nombre,
          subregion: sub,
          fuente: fuente,
          municipio: p.Municipio || p.municipio || '',
          proyecto: nombre,
          km: 0,
          avance: 0,
          avanceFin: 0,
          estabilizado: 0,
          contratista: '',
          contrato: '',
          interventor: '',
          plazoMeses: 0,
          plazo: '',
          circuito: '',
          fechaIni: '',
        })
      }
    }

    const totalKm = longitudTotal || 1
    const subregionesStats = SUBREGIONES_FIJAS.map(name => {
      const km = kmPorSubregion[name] ?? 0
      return { name, km: Math.round(km * 100) / 100, pct: Math.round((km / totalKm) * 100) }
    })

    const uniqueVias = new Set(geoLoc?.features.map(f => f.properties.NOMBRE_PROYECTO).filter(Boolean)).size
    const uniqueMunicipios = new Set(geoVias?.features.map(f => f.properties.MPIO_NOMBR).filter(Boolean)).size

    onStatsLoaded?.({
      viasIntervenidas: uniqueVias,
      longitudTotal: 0,
      municipios: uniqueMunicipios,
      proyectos: uniqueVias,
      subregiones: subregionesStats,
      viasDetalle,
    })
  }

  function _setupMunicipiosLayer(map, geoMunicipios, geoVias) {
    try {
      const municipiosConViasNorm = new Set(
        geoVias?.features.map(f => normUp(f.properties.MPIO_NOMBR)).filter(Boolean) ?? []
      )
      const geoMunicipiosTagged = {
        ...geoMunicipios,
        features: geoMunicipios.features.map(f => {
          const mpioNormName = normUp(f.properties.MPIO_NOMBR)
          const hasVias = municipiosConViasNorm.has(mpioNormName) ? 1 : 0
          return {
            ...f,
            properties: {
              ...f.properties,
              _subregionNorm: normUp(f.properties.SUBREGION),
              _mpioNorm: mpioNormName,
              _hasVias: hasVias,
            },
          }
        }),
      }
      map.addSource('municipios', { type: 'geojson', data: geoMunicipiosTagged, generateId: true })
      const isTerrain = !!map.getTerrain()
      map.addLayer({
        id: 'municipios-fill',
        type: 'fill',
        source: 'municipios',
        paint: {
          'fill-color': isTerrain ? '#0284c7' : '#2d8653',
          'fill-opacity': isTerrain
            ? ['case', ['boolean', ['feature-state', 'hover'], false], 0.3, 0.1]
            : ['case', ['boolean', ['feature-state', 'hover'], false], 0.22, 0.07],
        },
      })
      map.addLayer({
        id: 'municipios-outline',
        type: 'line',
        source: 'municipios',
        paint: {
          'line-color': isTerrain ? '#0284c7' : '#2d8653',
          'line-width': isTerrain ? 1.2 : 0.8,
          'line-opacity': 0.5
        },
      })
      map.addLayer({
        id: 'municipios-labels',
        type: 'symbol',
        source: 'municipios',
        layout: {
          'text-field': ['get', 'MPIO_NOMBR'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 7, 9, 10, 13],
          'text-anchor': 'center',
          'text-max-width': 8,
          'text-allow-overlap': false,
          'visibility': 'none',
        },
        paint: {
          'text-color': '#0b5640',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.5,
        },
      })

      let hoveredMpio = null
      map.on('mousemove', 'municipios-fill', (e) => {
        // Ignorar el hover de municipio si hay una capa de predio/localizaciÃ³n encima
        const topFeatures = map.queryRenderedFeatures(e.point, {
          layers: ['gavino-localizacion-fill', 'gavino-afectados-fill', 'gavino-permiso-fill'].filter(l => map.getLayer(l))
        })
        if (topFeatures.length > 0) {
          if (hoveredMpio !== null) {
            map.setFeatureState({ source: 'municipios', id: hoveredMpio }, { hover: false })
            hoveredMpio = null
            hoverLabel.value = { ...hoverLabel.value, visible: false }
          }
          return
        }

        if (hoveredMpio !== null)
          map.setFeatureState({ source: 'municipios', id: hoveredMpio }, { hover: false })
        hoveredMpio = e.features[0].id
        map.setFeatureState({ source: 'municipios', id: hoveredMpio }, { hover: true })

        const p = e.features[0].properties
        hoverLabel.value = {
          name: sentenceCase(p.MPIO_NOMBR ?? ''),
          subtext: sentenceCase(p.SUBREGION ?? ''),
          x: e.point.x,
          y: e.point.y,
          visible: true
        }
      })
      map.on('mouseleave', 'municipios-fill', () => {
        if (hoveredMpio !== null)
          map.setFeatureState({ source: 'municipios', id: hoveredMpio }, { hover: false })
        hoveredMpio = null
        hoverLabel.value = { ...hoverLabel.value, visible: false }
      })

    } catch (err) {
      console.error('[SIMEVA] Error cargando municipios:', err)
    }
  }

  function _setupViasLayer(map, geoVias) {
    try {
      const geoViasTagged = {
        ...geoVias,
        features: geoVias.features.map(f => ({
          ...f,
          properties: {
            ...f.properties,
            _hasReport: _circuitosConSeguimiento.has(normStr(f.properties.CIRCUITO ?? '')) ? 1 : 0,
            _subregionNorm: normUp(f.properties.SUBREGION),
            _mpioNorm: normUp(f.properties.MPIO_NOMBR),
          },
        })),
      }
      map.addSource('vias', {
        type: 'geojson',
        data: geoViasTagged,
        generateId: true,
        tolerance: 1.25 // Tolerancia de simplificaciÃ³n (Douglas-Peucker) para enderezar tramos en zoom alejado y dar detalle al acercarse
      })

      // 1. Casing base (siempre visible)
      map.addLayer({
        id: 'vias-casing',
        type: 'line',
        source: 'vias',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.4 },
      })
      // 2. Halo negro ampliado en hover (ancho 13.6px, opacidad 0.18)
      map.addLayer({
        id: 'vias-hover-casing',
        type: 'line',
        source: 'vias',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['==', ['get', 'NOMBRE_VIA'], ''],
        paint: {
          'line-color': '#000000',
          'line-width': 13.6,
          'line-opacity': 0.18
        },
      })
      // 3. Contorno interno negro en hover (ancho 8.5px, opacidad 0.45)
      map.addLayer({
        id: 'vias-hover-inner-casing',
        type: 'line',
        source: 'vias',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        filter: ['==', ['get', 'NOMBRE_VIA'], ''],
        paint: {
          'line-color': '#000000',
          'line-width': 8.5,
          'line-opacity': 0.45
        },
      })
      // (Glow removido a peticiÃ³n del usuario para evitar efectos difuminados de tipo brillo/neon)
      // 4. LÃ­nea principal (siempre visible)
      map.addLayer({
        id: 'vias-line',
        type: 'line',
        source: 'vias',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffaa00',
          'line-width':   4.25,
          'line-opacity': 1,
        },
      })
      // (Highlight blanco superior removido a peticiÃ³n del usuario para evitar el uso del color blanco)

      // 6. Hit target (invisible but thick) to capture hover/click easily
      map.addLayer({
        id: 'vias-hit-target',
        type: 'line',
        source: 'vias',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#000000', 'line-width': 24, 'line-opacity': 0 },
      })

      const HOVER_FILTER_ON  = (circuito) => {
        const expressions = ['all', ['==', ['get', 'CIRCUITO'], circuito]]
        const sub = store.activeFilters.subregion
        const mpio = store.activeFilters.municipio
        if (sub && sub !== 'Todas las subregiones') {
          expressions.push(['==', ['get', '_subregionNorm'], normUp(sub)])
        }
        if (mpio && mpio !== 'Todos los municipios') {
          expressions.push(['==', ['get', '_mpioNorm'], normUp(mpio)])
        }
        return expressions
      }
      const HOVER_FILTER_OFF = ['==', ['get', 'CIRCUITO'], '']

      function startHover(nombreVia) {
        const f = HOVER_FILTER_ON(nombreVia)
        map.setFilter('vias-hover-casing', f)
        map.setFilter('vias-hover-inner-casing', f)
      }

      function stopHover() {
        map.setFilter('vias-hover-casing', HOVER_FILTER_OFF)
        map.setFilter('vias-hover-inner-casing', HOVER_FILTER_OFF)
      }

      // Mapa CIRCUITO + SUBREGION â†’ { km, avance } agregado para el tooltip/click
      const circuitDataMap = {}
      for (const f of geoVias.features) {
        const circ = f.properties.CIRCUITO ?? ''
        const sub  = f.properties.SUBREGION ?? ''
        const key  = circ + '||' + sub
        if (!circuitDataMap[key]) circuitDataMap[key] = { km: 0, avanceKm: 0 }
        const km = Number.parseFloat(f.properties.Long_km) || 0
        circuitDataMap[key].km      += km
        const fisDec = (Number.parseFloat(f.properties.AV_FISICO) || 0) > 1 ? (Number.parseFloat(f.properties.AV_FISICO) || 0) / 100 : (Number.parseFloat(f.properties.AV_FISICO) || 0)
        circuitDataMap[key].avanceKm += fisDec * km
      }
      for (const c of Object.values(circuitDataMap)) {
        c.avance = c.km > 0 ? Math.round((c.avanceKm / c.km) * 100) : 0
        c.km     = Math.round(c.km * 100) / 100
      }

      let hoveredVia = null

      function handleViaClick(e) {
        const p        = e.features[0].properties
        const circuito = p.CIRCUITO ?? ''
        const subregion = p.SUBREGION ?? ''
        const key      = circuito + '||' + subregion
        const circuitFeats = cachedVias.value?.features.filter(f => f.properties.CIRCUITO === circuito && f.properties.SUBREGION === subregion) ?? []
        const first    = circuitFeats[0]?.properties ?? p
        const municipios = [...new Set(circuitFeats.map(f => sentenceCase(f.properties.MPIO_NOMBR)).filter(Boolean))]
        const data     = circuitDataMap[key] ?? {}

        selectedMpio.value = null
        selectedVia.value = {
          name: circuito || 'Circuito sin nombre',
          idCircuito:  first['id-circuito'] ?? first.CIRCUITO ?? '',
          subregion: subregion,
          description: {
            circuitId:               first['id-circuito'] ?? first.CIRCUITO ?? '',
            'Subregión':             canonicalSub(first.SUBREGION),
            'Municipio':             municipios.join(', '),
            'Circuito':              circuito,
            'Contrato':              first.CTO        ?? '',
            'Contratista':           first.CONTRATIST ?? '',
            'Interventoría':         first.INTERV     ?? '',
            'Longitud (km)':         data.km ?? '',
            'Avance físico':         `${data.avance ?? 0}%`,
            'Fecha de inicio':       first.FECHA_INI  ?? '',
            'Plazo (meses)':         first.PLAZO_MESE ?? '',
            'Duración transcurrida': first.FECHA_INI && first.PLAZO_MESE
              ? `${pctTiempoTranscurrido(first.FECHA_INI, first.PLAZO_MESE)}%` : '',
          },
        }
      }

      function handleViaMouseMove(e) {
        map.getCanvas().style.cursor = 'pointer'
        const p = e.features[0].properties
        const circuito = p.CIRCUITO ?? ''
        const subregion = p.SUBREGION ?? ''
        const key = circuito + '||' + subregion
        if (circuito !== hoveredVia) {
          startHover(circuito)
          hoveredVia = circuito
        }
        const data = circuitDataMap[key] ?? {}
        viaHoverLabel.value = { name: circuito, km: data.km ?? null, avance: data.avance ?? null, x: e.point.x, y: e.point.y, visible: true }
      }

      function handleViaMouseLeave() {
        map.getCanvas().style.cursor = ''
        stopHover()
        hoveredVia = null
        viaHoverLabel.value = { ...viaHoverLabel.value, visible: false }
      }

      map.on('click', 'vias-hit-target', handleViaClick)
      map.on('mousemove', 'vias-hit-target', handleViaMouseMove)
      map.on('mouseleave', 'vias-hit-target', handleViaMouseLeave)

      buildCallouts?.(geoVias.features)
      map.on('move',   updateCalloutPositions)
      map.on('resize', updateCalloutPositions)
    } catch (err) {
      console.error('[SIMEVA] Error cargando vÃ­as:', err)
    }
  }

  function _setupGenericPolygonLayer(map, id, geoData, fillColor, outlineColor) {
    try {
      const toggleState = store.layerToggles.find(t => t.id === id)
      const visibility = toggleState && !toggleState.visible ? 'none' : 'visible'
      
      map.addSource(id, {
        type: 'geojson',
        data: geoData,
        generateId: true,
        tolerance: 0
      })
      map.addLayer({
        id: `${id}-fill`,
        type: 'fill',
        source: id,
        filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false],
        layout: { visibility },
        paint: {
          'fill-color': ['coalesce', ['get', 'fillColor'], fillColor],
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.7,
            0.4
          ]
        }
      })
      map.addLayer({
        id: `${id}-outline`,
        type: 'line',
        source: id,
        layout: { visibility },
        paint: {
          'line-color': ['coalesce', ['get', 'outlineColor'], outlineColor],
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            4,
            2
          ]
        }
      })
      
      if (id.includes('afectados')) {
        map.addLayer({
          id: `${id}-label`,
          type: 'symbol',
          source: id,
          layout: {
            visibility,
            'text-field': ['get', 'LABEL_ID'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': 12,
            'text-anchor': 'center'
          },
          paint: {
            'text-color': '#000000',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
          }
        })
      }
      
      let hoveredPolygon = null
      map.on('mousemove', `${id}-fill`, (e) => {
        if (e.features.length > 0) {
          if (hoveredPolygon !== null) {
            map.setFeatureState({ source: id, id: hoveredPolygon }, { hover: false })
          }
          hoveredPolygon = e.features[0].id
          map.setFeatureState({ source: id, id: hoveredPolygon }, { hover: true })
        }
      })
      map.on('mouseleave', `${id}-fill`, () => {
        if (hoveredPolygon !== null) {
          map.setFeatureState({ source: id, id: hoveredPolygon }, { hover: false })
        }
        hoveredPolygon = null
      })

    } catch (err) {
      console.error(`[SIMEVA] Error cargando ${id}:`, err)
    }
  }

  function _setupGenericPointLayer(map, id, geoData, color) {
    if (!geoData) return
    try {
      const toggleState = store.layerToggles.find(t => t.id === id)
      const visibility = toggleState && !toggleState.visible ? 'none' : 'visible'
      
      map.addSource(id, {
        type: 'geojson',
        data: geoData,
        generateId: true
      })
      map.addLayer({
        id: `${id}-circle`,
        type: 'circle',
        source: id,
        layout: { visibility },
        paint: {
          'circle-radius': 8,
          'circle-color': color,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      })
      
      let hoveredPoint = null
      map.on('mousemove', `${id}-circle`, (e) => {
        if (e.features.length > 0) {
          map.getCanvas().style.cursor = 'pointer'
        }
      })
      map.on('mouseleave', `${id}-circle`, () => {
        map.getCanvas().style.cursor = ''
      })
    } catch (err) {
      console.error(`[SIMEVA] Error cargando point layer ${id}:`, err)
    }
  }

  function _setupArcgisTreeLayer(map, id, geoData) {
    if (!geoData) return
    try {
      const toggleState = store.layerToggles.find(t => t.id === id)
      const visibility = toggleState && !toggleState.visible ? 'none' : 'visible'
      
      map.addSource(id, {
        type: 'geojson',
        data: geoData,
        generateId: true
      })
      const iconId = 'tree-icon';
      if (!map.hasImage(iconId)) {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#10b981" stroke="#064e3b" stroke-width="1.5"><path d="m17 14 3 3.3a1 1 0 0 1-.7 1.7H4.7a1 1 0 0 1-.7-1.7L7 14h-.3a1 1 0 0 1-.7-1.7L9 9h-.2A1 1 0 0 1 8 7.3L12 3l4 4.3a1 1 0 0 1-.8 1.7H15l3 3.3a1 1 0 0 1-.7 1.7H17Z"/><path d="M12 22v-3" stroke="#451a03" stroke-width="3"/></svg>';
        const img = new Image(24, 24);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        img.onload = () => { if (!map.hasImage(iconId)) map.addImage(iconId, img); };
      }

      map.addLayer({
        id: `${id}-symbol`,
        type: 'symbol',
        source: id,
        layout: {
          visibility,
          'icon-image': iconId,
          'icon-size': [
            'interpolate', ['linear'], ['zoom'],
            12, 0.6,
            16, 1.0,
            20, 1.6
          ],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      })
      
      let hoveredPoint = null
      map.on('mousemove', `${id}-symbol`, (e) => {
        if (e.features.length > 0) {
          map.getCanvas().style.cursor = 'pointer'
        }
      })
      map.on('mouseleave', `${id}-symbol`, () => {
        map.getCanvas().style.cursor = ''
      })
    } catch (err) {
      console.error(`[SIMEVA] Error cargando tree layer ${id}:`, err)
    }
  }

  function _getCentroid(coords) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const process = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else {
        c.forEach(process);
      }
    };
    process(coords);
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  function _setupProyectoPoint(map, geoLoc) {
    if (!geoLoc || !geoLoc.features || !geoLoc.features.length) return;
    
    const pointFeatures = geoLoc.features.map(f => {
      const centroid = _getCentroid(f.geometry.coordinates);
      const desc = parseDescription(f.properties.description);
      const pct = parseAvancePct(desc);
      const nombre = f.properties.NOMBRE_PROYECTO || 'Proyecto';
      let enEjecucion = pct > 0 && pct < 100;
      if (nombre.includes('El Tres San Pedro')) {
        enEjecucion = true;
      }
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: centroid },
        properties: { 
          nombre,
          enEjecucion
        }
      }
    });

    try {
      map.addSource('proyecto-point', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: pointFeatures
        }
      })

      map.addLayer({
        id: 'proyecto-point-pulse',
        type: 'circle',
        source: 'proyecto-point',
        filter: ['==', ['get', 'enEjecucion'], true],
        maxzoom: 13,
        paint: {
          'circle-radius': 7,
          'circle-color': '#22c55e',
          'circle-opacity': 0.8,
          'circle-stroke-width': 0
        }
      })

      map.addLayer({
        id: 'proyecto-point-circle',
        type: 'circle',
        source: 'proyecto-point',
        maxzoom: 13,
        paint: {
          'circle-radius': 7,
          'circle-color': '#22c55e',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff'
        }
      })

      map.addLayer({
        id: 'proyecto-point-label',
        type: 'symbol',
        source: 'proyecto-point',
        maxzoom: 13,
        layout: {
          'text-field': ['get', 'nombre'],
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-size': 12,
          'text-font': ['Prompt Bold', 'Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0b5640',
          'text-halo-width': 2
        }
      })

      let hovered = null
      const pointLayers = ['proyecto-point-pulse', 'proyecto-point-circle', 'proyecto-point-label']
      
      map.on('mousemove', pointLayers, () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', pointLayers, () => { map.getCanvas().style.cursor = '' })
      
      map.on('click', pointLayers, (e) => {
        if (!e.features || !e.features.length) return
        const coords = e.features[0].geometry.coordinates
        map.flyTo({
          center: coords,
          zoom: 16,
          duration: 400,
          essential: true
        })
      })

      function animateMarker(timestamp) {
        if (destroyed || !map.getLayer('proyecto-point-pulse')) return;
        const duration = 2000;
        const t = (timestamp % duration) / duration;
        
        const radius = 7 + (15 * t);
        const opacity = Math.max(0, 0.8 - (0.8 * t));
        
        map.setPaintProperty('proyecto-point-pulse', 'circle-radius', radius);
        map.setPaintProperty('proyecto-point-pulse', 'circle-opacity', opacity);
        
        requestAnimationFrame(animateMarker);
      }
      requestAnimationFrame(animateMarker);

    } catch (err) {
      console.error('[SIMEVA] Error cargando proyecto point:', err)
    }
  }

  async function loadSimeva() {
    const map = getMap()
    if (!map || destroyed) return
    loading.value   = true
    loadError.value = false

    const [resMunicipios, resVias, resLoc, resAfectados, resMiCasita, resHeliconia, resForestal, resCauce, resAbscisas, resArcgisForestal, resAreaIntervenidas, resPrediosIntervenidos, resDatosPredial] = await Promise.allSettled([
      getMunicipios(), 
      getLocalizaciones(), 
      getPuenteGavinoLocalizacion(),
      getPuenteGavinoPrediosAfectados(),
      getMiCasitaPrediosAfectados(),
      getHeliconiaPrediosAfectados(),
      getPuenteGavinoForestal(),
      getPuenteGavinoCauce(),
      getPuenteGavinoAbscisas(),
      getArcgisInventarioForestal(),
      getAreaIntervenidasVisor(),
      getPrediosIntervenidosVisor(),
      getDatosPredial()
    ])

    if (destroyed) return

    const munResult = resMunicipios.status === 'fulfilled' ? resMunicipios.value : null
    const viaResult = resVias.status       === 'fulfilled' ? resVias.value       : null
    const locResult = resLoc.status === 'fulfilled' ? resLoc.value : null
    const afecResult = resAfectados.status === 'fulfilled' ? resAfectados.value : null
    const micasitaResult = resMiCasita.status === 'fulfilled' ? resMiCasita.value : null
    const heliconiaResult = resHeliconia.status === 'fulfilled' ? resHeliconia.value : null
    const forResult = resForestal.status === 'fulfilled' ? resForestal.value : null
    const cauResult = resCauce.status === 'fulfilled' ? resCauce.value : null
    const absResult = resAbscisas.status === 'fulfilled' ? resAbscisas.value : null
    const arcgisForestalResult = resArcgisForestal.status === 'fulfilled' ? resArcgisForestal.value : null
    const areaIntervenidasResult = resAreaIntervenidas.status === 'fulfilled' ? resAreaIntervenidas.value : null
    const prediosIntervenidosResult = resPrediosIntervenidos.status === 'fulfilled' ? resPrediosIntervenidos.value : null
    const datosPredialResult = resDatosPredial.status === 'fulfilled' ? resDatosPredial.value : null
    const jsonDatosPredial = datosPredialResult?.data ?? null

    cachedMunicipios.value = munResult?.data ?? null
    cachedVias.value       = viaResult?.data ?? null
    cachedLocalizaciones.value = locResult?.data ?? null
    cachedAreaIntervenidas.value = areaIntervenidasResult?.data ?? null
    cachedPrediosIntervenidos.value = prediosIntervenidosResult?.data ?? null
    fromCache.value        = !!(munResult?.fromCache || viaResult?.fromCache)

    const geoMunicipios = cachedMunicipios.value
    const geoVias       = cachedVias.value
    const geoLoc = cachedLocalizaciones.value
    const geoAfectados = afecResult?.data ?? null
    const geoMiCasita = micasitaResult?.data ?? null
    const geoHeliconia = heliconiaResult?.data ?? null
    const geoForestal = forResult?.data ?? null
    const geoCauce = cauResult?.data ?? null
    const geoAbscisas = absResult?.data ?? null
    const geoArcgisForestal = arcgisForestalResult?.data ?? null
    const geoAreaIntervenidas = areaIntervenidasResult?.data ?? null
    const geoPrediosIntervenidos = prediosIntervenidosResult?.data ?? null

    if (resMunicipios.status === 'rejected') console.warn('[SIMEVA] Municipios:', resMunicipios.reason)
    if (resVias.status       === 'rejected') console.warn('[SIMEVA] Vías:', resVias.reason)

    if (!geoMunicipios && !geoVias && !geoLoc && !geoAfectados && !geoPermiso) {
      loadError.value = true
      loading.value   = false
      return
    }

    // Normaliza texto para comparar sin acentos ni mayúsculas
    const { resolveFuente } = _buildProjectCatalog(geoLoc, geoAreaIntervenidas, jsonDatosPredial)
    _extractFilterOptions(geoMunicipios, geoVias, geoLoc, geoAreaIntervenidas, jsonDatosPredial)

    // ── Estadísticas desde propiedades directas del GeoJSON ──────────────────
    _calculateViasStats(geoVias, geoLoc, geoAreaIntervenidas, resolveFuente)

    if (destroyed) return

    // â”€â”€ Capa municipios â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (geoMunicipios) {
      _setupMunicipiosLayer(map, geoMunicipios, geoVias)
    }

    // â”€â”€ Capas Puente Gavino â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (geoLoc) {
      _setupGenericPolygonLayer(map, 'gavino-localizacion', geoLoc, '#3b82f6', '#2563eb')
      
      map.on('click', 'gavino-localizacion-fill', (e) => {
        const p = e.features[0].properties
        const projName = (p.NOMBRE_PROYECTO || '').toLowerCase()
        
        const desc = {
          'Proyecto': p.NOMBRE_PROYECTO || 'N/A',
          'SubregiÃ³n': p.SUBREGION || 'N/A'
        }
        
        if (projName.includes('casita')) {
          desc['Permiso de ocupaciÃ³n de cauce'] = 'data/01 Puente gavino/Res otorgamiento POC Mi Casita.pdf'
        } else if (projName.includes('gavi') || projName.includes('gabi')) {
          desc['Permiso de ocupaciÃ³n de cauce'] = 'data/01 Puente gavino/Resolucion otorgamiento POC Gavino.pdf'
        } else if (projName.includes('el tres') || projName.includes('san pedro de uraba')) {
          desc['Estado'] = 'Finalizo la ejecucion - El Muro ya esta construido.'
          desc['Estado Predial'] = '1. El Predio 034-13299 fue expropiado esta a nombre de la GobernaciÃ²n 2. 034-3534 En expropiacion se tiene acta de entrega anticipada por parte del juzgado'
        } else if (projName.includes('majagual')) {
          desc['Permiso de aprovechamiento forestal'] = 'data/01 Puente gavino/Permiso de aprovechamiento forestal Majagual.pdf'
        } else if (projName.includes('san antonio')) {
          desc['Aprovechamiento forestal'] = 'No requiere'
          desc['Permiso de intervenciÃ³n de cauce'] = 'No requiere'
        }
        
        selectedVia.value = {
          name: 'InformaciÃ³n del Proyecto',
          description: desc
        }
      })
      
      map.on('mouseenter', 'gavino-localizacion-fill', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'gavino-localizacion-fill', () => {
        map.getCanvas().style.cursor = ''
      })
    }

    if (geoAfectados) {
      geoAfectados.features.forEach(f => {
        if (f.properties.fuente === 'AFECTACION_2.shp') {
          f.properties.fillColor = '#22c55e';
          f.properties.outlineColor = '#16a34a';
        }
      });
      _setupGenericPolygonLayer(map, 'gavino-afectados', geoAfectados, '#ef4444', '#dc2626')
      
      map.on('click', 'gavino-afectados-fill', (e) => {
        if (!e.features || e.features.length === 0) return
        const p = e.features[0].properties
        
        if (p.fuente === 'AFECTACION_2.shp') {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '026-23008',
              'Propietario': 'MICHELLE MARIA NAVARRO',
              'Permiso de Intervension': 'Si',
              'Area': '3509.55 mÂ²'
            }
          }
        } else if (p.fuente === '1_AFECTACION.shp') {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '025-26288',
              'Propietario': 'MARIA EUGENIA MARTINEZ',
              'Permiso de Intervension': 'No',
              'Area': '3184.90 mÂ²'
            }
          }
        } else {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Ãrea': p.SHAPE_AREA ? Number(p.SHAPE_AREA).toFixed(2) + ' mÂ²' : 'N/A',
              'Departamento': p.DPTO || 'N/A',
              'Municipio': p.MPIO || 'N/A',
              'Propietario': p.PROP || 'N/A',
              'CÃ³digo Catastral': p.CODCATAS || 'N/A',
              'MatrÃ­cula Inmob.': p.MATRICULA || 'N/A',
              'Fuente': p.fuente || 'N/A'
            }
          }
        }
      })
      map.on('mouseenter', 'gavino-afectados-fill', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'gavino-afectados-fill', () => {
        map.getCanvas().style.cursor = ''
      })
    }

    if (geoMiCasita) {
      geoMiCasita.features = geoMiCasita.features.filter(f => {
        const id = f.properties.LOCAL_ID || f.properties.local_id || '';
        return id !== '6902004000000100063' && id !== '6862004000000200028';
      });

      geoMiCasita.features.forEach(f => {
        const localId = f.properties.LOCAL_ID || f.properties.local_id || '';
        if (localId === '8610001000000010094' || localId === '8610001000000010066') {
          f.properties.fillColor = '#22c55e';
          f.properties.outlineColor = '#16a34a';
        }
        
        // Jardin Rio Sucio (Municipio 364) - Predios que deben estar en verde
        if (f.properties.MUNICIPIO === '364' || f.properties.municipio === '364') {
          const redIds = ['3642001000000100151', '3642001000000100101', '3642001000000100018'];
          if (!redIds.includes(localId)) {
            f.properties.fillColor = '#22c55e';
            f.properties.outlineColor = '#16a34a';
          }
        }
      });
      _setupGenericPolygonLayer(map, 'micasita-afectados', geoMiCasita, '#ef4444', '#dc2626')
      
      map.on('click', 'micasita-afectados-fill', (e) => {
        if (!e.features || e.features.length === 0) return
        const p = e.features[0].properties
        
        let area = 0;
        if (e.features[0].geometry && e.features[0].geometry.coordinates) {
          const coords = e.features[0].geometry.coordinates;
          if (coords.length > 0 && coords[0].length > 0) {
            let pts = coords[0];
            if (e.features[0].geometry.type === 'MultiPolygon') {
              pts = coords[0][0];
            }
            if (pts) {
              const R = 6378137;
              let tempArea = 0;
              for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i];
                const p2 = pts[i + 1];
                tempArea += (p2[0] - p1[0]) * (p2[1] + p1[1]) * (Math.PI / 180) * R * (Math.PI / 180) * R * Math.cos(p1[1] * Math.PI / 180);
              }
              area = Math.abs(tempArea) / 2;
            }
          }
        }
        
        const areaStr = area > 0 ? area.toFixed(2) + ' mÂ²' : 'N/A';
        const localId = p.LOCAL_ID || p.local_id || '';
        
        const isHugoEcheverri = localId === '8610001000000010066';
        const isMiguelZapata = localId === '8610001000000010094';
        const isRamonAgudelo = localId === '8610002000000020261';
        const isLibardoVelasquez = localId === '8610001000000010084';

        if (isLibardoVelasquez) {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '010-12231',
              'Propietario': 'LIBARDO ERNESTO VELASQUEZ ZAPATA',
              'Permiso de Intervension': 'No',
              'Area': areaStr
            }
          }
        } else if (isRamonAgudelo) {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '010-15312',
              'Propietario': 'Ramon Alberto Agudelo Vergara',
              'Permiso de Intervension': 'No',
              'Area': areaStr
            }
          }
        } else if (isHugoEcheverri) {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '010-14909',
              'Propietario': 'Hugo Echeverri Gutierrez (50%) - Blanca Paulina Diaz de Echeverri (50%)',
              'Permiso de Intervension': 'Si',
              'Area': areaStr
            }
          }
        } else if (isMiguelZapata) {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Matricula': '010-2244',
              'Propietario': 'Miguel Zapata Correa',
              'Permiso de Intervension': 'Si',
              'Area': '373.28 mÂ²'
            }
          }
        } else {
          selectedVia.value = {
            name: 'Predio Afectado',
            description: {
              'Local ID': localId || 'N/A',
              'CÃ­rculo y MatrÃ­cula': p.CIRCULO_MA || 'N/A',
              'CÃ³digo de Terreno': p.TERRENO_CO || p.terreno_co || 'N/A',
              'Area': areaStr
            }
          }
        }
      })
      map.on('mouseenter', 'micasita-afectados-fill', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'micasita-afectados-fill', () => {
        map.getCanvas().style.cursor = ''
      })
    }

    if (geoHeliconia) {
      geoHeliconia.features.forEach(f => {
        f.properties.fillColor = '#22c55e';
        f.properties.outlineColor = '#16a34a';
      });
      _setupGenericPolygonLayer(map, 'heliconia-afectados', geoHeliconia, '#22c55e', '#16a34a')
      
      map.on('click', 'heliconia-afectados-fill', (e) => {
        if (!e.features || e.features.length === 0) return
        
        let area = 0;
        if (e.features[0].geometry && e.features[0].geometry.coordinates) {
          const coords = e.features[0].geometry.coordinates;
          if (coords.length > 0 && coords[0].length > 0) {
            let pts = coords[0];
            if (e.features[0].geometry.type === 'MultiPolygon') {
              pts = coords[0][0];
            }
            if (pts) {
              const R = 6378137;
              let tempArea = 0;
              for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i];
                const p2 = pts[i + 1];
                tempArea += (p2[0] - p1[0]) * (p2[1] + p1[1]) * (Math.PI / 180) * R * (Math.PI / 180) * R * Math.cos(p1[1] * Math.PI / 180);
              }
              area = Math.abs(tempArea) / 2;
            }
          }
        }
        
        const areaStr = area > 0 ? area.toFixed(2) + ' mÂ²' : 'N/A';
        
        const featureProps = e.features[0].properties || {};
        const localId = featureProps.LOCAL_ID;
        
        let matricula = 'xxx-xxxxx';
        let propietario = 'xxx';
        
        if (localId === '3471001001001400001') {
          matricula = '001-742696';
          propietario = 'MUNICIPIO DE HELICONIA';
        } else if (localId === '3471001001001400002') {
          matricula = '001-542540';
          propietario = 'MARIA GABRIELA HERRERA GIL';
        }
        
        selectedVia.value = {
          name: 'Predio Afectado (Heliconia)',
          description: {
            'Matricula': matricula,
            'Propietario': propietario,
            'Permiso de Intervension': 'Si',
            'Area': areaStr
          }
        }
      })
      map.on('mouseenter', 'heliconia-afectados-fill', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'heliconia-afectados-fill', () => {
        map.getCanvas().style.cursor = ''
      })
    }
    if (geoForestal) {
      _setupArcgisTreeLayer(map, 'gavino-forestal', geoForestal)
      
      map.on('click', 'gavino-forestal-symbol', (e) => {
        const p = e.features[0].properties
        selectedVia.value = {
          name: 'Aprovechamiento Forestal',
          description: { ...p }
        }
      })
    }
    if (geoCauce) {
      _setupGenericPointLayer(map, 'gavino-cauce', geoCauce, '#0ea5e9')
      
      map.on('click', 'gavino-cauce-circle', (e) => {
        const p = e.features[0].properties
        selectedVia.value = {
          name: 'OcupaciÃ³n de Cauce',
          description: { ...p }
        }
      })
    }
    // abscisas layer moved to the end to ensure it renders on top
    if (geoArcgisForestal) {
      _setupArcgisTreeLayer(map, 'arcgis-forestal', geoArcgisForestal)
      
      map.on('click', 'arcgis-forestal-symbol', (e) => {
        const p = e.features[0].properties
        selectedVia.value = {
          name: 'Inventario Forestal (ArcGIS)',
          description: {
            'Especie': p.Especie || 'N/A',
            'Nombre ComÃºn': p.NombreComun || 'N/A',
            'DAP (m)': p.DAP || 'N/A',
            'Altura (m)': p.AlturaTotal || 'N/A',
            'Estado': p.EstadoFitosanitario || 'N/A',
            ...p
          }
        }
      })
    }

    function _setupArcGISRedVial(map) {
      const baseUrl = 'https://services5.arcgis.com/K90UQIB09TmTjUL8/arcgis/rest/services/R10/FeatureServer'
      const layersConfig = [
        { id: '1', name: 'red-vial-primaria', color: '#ef4444', baseWidth: 1.5, maxWidth: 4, opacity: 0.4, visibility: 'visible' },
        { id: '2', name: 'red-vial-secundaria', color: '#f97316', baseWidth: 0.8, maxWidth: 2.5, opacity: 0.35, visibility: 'visible' },
        { id: '3', name: 'red-vial-terciaria', color: '#fbbf24', baseWidth: 0.5, maxWidth: 1.5, opacity: 0.3, visibility: 'none' }
      ]

      layersConfig.forEach(config => {
        const sourceId = `arcgis-${config.name}-source`
        if (!map.getSource(sourceId)) {
          map.addSource(sourceId, {
            type: 'geojson',
            data: `${baseUrl}/${config.id}/query?where=1%3D1&outFields=*&f=geojson`
          })
        }
        
        if (!map.getLayer(config.name)) {
          map.addLayer({
            id: config.name,
            type: 'line',
            source: sourceId,
            layout: {
              'line-join': 'round',
              'line-cap': 'round',
              'visibility': config.visibility
            },
            paint: {
              'line-color': config.color,
              'line-width': [
                'interpolate', ['linear'], ['zoom'],
                6, config.baseWidth,
                15, config.maxWidth
              ],
              'line-opacity': config.opacity
            }
          }, 'proyecto-point-pulse') // Insertamos la capa de vÃ­as DEBAJO de los puntos (proyecto-point-pulse) para que no los tapen

          map.on('click', config.name, (e) => {
            const p = e.features[0].properties
            selectedVia.value = {
              name: 'Detalle de la capa',
              description: {
                'Nombre': p.NOMBRE_VIA || 'VÃ­a sin nombre',
                'CÃ³digo de VÃ­a': p.CODIGO_VIA || 'N/A'
              }
            }
          })
          map.on('mouseenter', config.name, () => {
            map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', config.name, () => {
            map.getCanvas().style.cursor = ''
          })
        }
      })
    }

    function _setupCustomMarkers(map) {
      if (!map.getSource('custom-markers')) {
        map.addSource('custom-markers', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [-75.732871, 6.205071] },
                properties: { label: 'Final \n k55+190', rotation: 0 }
              },
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [-75.733166, 6.205705] },
                properties: { label: 'inicio k55+112', rotation: 0 }
              }
            ]
          }
        })
        map.addLayer({
          id: 'custom-markers-label',
          type: 'symbol',
          source: 'custom-markers',
          layout: {
            'symbol-placement': 'point',
            'text-field': ['get', 'label'],
            'text-rotate': ['get', 'rotation'],
            'text-offset': [0, -1.2],
            'text-anchor': 'bottom',
            'text-size': 18,
            'text-font': ['Prompt Bold', 'Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true,
            'text-ignore-placement': true
          },
          paint: {
            'text-color': '#000000',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
          }
        })
      }
    }

    _setupProyectoPoint(map, geoLoc)
    _setupArcGISRedVial(map)
    // _setupCustomMarkers(map)


    if (geoAbscisas) {
      const pinId = 'green-pin';
      if (!map.hasImage(pinId)) {
        const svg = '<svg viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg"><path d="M12 0C6.48 0 2 4.48 2 10c0 7.5 10 22 10 22s10-14.5 10-22c0-5.52-4.48-10-10-10z" fill="#22c55e"/><circle cx="12" cy="10" r="4.5" fill="#ffffff"/></svg>';
        const img = new Image(24, 32);
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        img.onload = () => { if (!map.hasImage(pinId)) map.addImage(pinId, img); };
      }

      if (!map.getSource('gavino-abscisas')) {
        map.addSource('gavino-abscisas', {
          type: 'geojson',
          data: geoAbscisas,
          generateId: true
        });
      }

      const toggleState = store.layerToggles.find(t => t.id === 'gavino-abscisas')
      const visibility = toggleState && !toggleState.visible ? 'none' : 'visible'

      if (!map.getLayer('gavino-abscisas-symbol')) {
        map.addLayer({
          id: 'gavino-abscisas-symbol',
          type: 'symbol',
          source: 'gavino-abscisas',
          minzoom: 12,
          layout: {
            visibility,
            'icon-image': pinId,
            'icon-size': 1,
            'icon-anchor': 'bottom',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'text-field': ['get', 'label'],
            'text-anchor': 'top',
            'text-offset': [0, 0.2],
            'text-size': 14,
            'text-font': ['Prompt Bold', 'Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': true
          },
          paint: {
            'text-color': '#0b5640',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2
          }
        });

        map.on('click', 'gavino-abscisas-symbol', (e) => {
          const p = e.features[0].properties;
          selectedVia.value = {
            name: p.NOMBRE_PROYECTO || 'Marca de PosiciÃ³n',
            description: {
              'Tipo': p.TIPO || 'N/A',
              'DescripciÃ³n': p.DESCRIPCION || 'N/A'
            }
          };
        });

        map.on('mousemove', 'gavino-abscisas-symbol', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'gavino-abscisas-symbol', () => {
          map.getCanvas().style.cursor = '';
        });
      }
    }

    if (geoPrediosIntervenidos) {
      _setupGenericPolygonLayer(map, 'predios-intervenidos', geoPrediosIntervenidos, '#eab308', '#ca8a04')

      map.on('click', 'predios-intervenidos-fill', (e) => {
        if (!e.features || e.features.length === 0) return
        const p = e.features[0].properties
        selectedVia.value = {
          name: 'Predio Intervenido',
          description: { ...p }
        }
      })
      map.on('mouseenter', 'predios-intervenidos-fill', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'predios-intervenidos-fill', () => { map.getCanvas().style.cursor = '' })
    }

    if (geoAreaIntervenidas) {
      geoAreaIntervenidas.features.forEach(f => {
        const permiso = f.properties.Permiso_Intervencion || f.properties.permiso_intervencion || f.properties.Permiso || '';
        if (permiso.trim().toUpperCase() === 'SI') {
          f.properties.fillColor = '#22c55e';
          f.properties.outlineColor = '#16a34a';
        } else {
          f.properties.fillColor = '#ef4444';
          f.properties.outlineColor = '#dc2626';
        }
      });
      _setupGenericPolygonLayer(map, 'area-intervenidas', geoAreaIntervenidas, '#9333ea', '#7e22ce')
      
      map.on('click', 'area-intervenidas-fill', (e) => {
          if (!e.features || e.features.length === 0) return
          const p = { ...e.features[0].properties }
          delete p.fillColor
          delete p.outlineColor
          
          let descData = { ...p };
          const matricula = p.Matricula || p.matricula || '';
          if (jsonDatosPredial && Array.isArray(jsonDatosPredial)) {
              const matchedRows = jsonDatosPredial.filter(row => {
                  const key = Object.keys(row).find(k => k.includes('Matr'));
                  return String(row[key] || '').trim() === String(matricula).trim();
              });
              if (matchedRows.length > 0) {
                  const abscisa = p.ABS || '';
                  let exactMatch = matchedRows.find(row => String(row['Abscisa inicial'] || '').trim() === String(abscisa).trim());
                  let finalMatch = exactMatch || matchedRows[0];
                  descData = { ...descData, ...finalMatch };
              }
          }
          
          const calcAreaHelper = (feature) => {
            if (!feature || !feature.geometry || !feature.geometry.coordinates) return 0;
            const coords = feature.geometry.coordinates;
            if (coords.length === 0 || coords[0].length === 0) return 0;
            let totalArea = 0;
            const polys = feature.geometry.type === 'MultiPolygon' ? coords : [coords];
            const R = 6378137;
            for (const poly of polys) {
              const pts = poly[0];
              if (!pts) continue;
              let tempArea = 0;
              for (let i = 0; i < pts.length - 1; i++) {
                const p1 = pts[i];
                const p2 = pts[i + 1];
                tempArea += (p2[0] - p1[0]) * (p2[1] + p1[1]) * (Math.PI / 180) * R * (Math.PI / 180) * R * Math.cos(p1[1] * Math.PI / 180);
              }
              totalArea += Math.abs(tempArea) / 2;
            }
            return totalArea;
          };

          const areaRequerida = calcAreaHelper(e.features[0]);
          descData['Area_Requerida'] = areaRequerida > 0 ? areaRequerida.toFixed(2) + ' m²' : 'N/A';
          
          let areaTotal = 0;
          if (geoPrediosIntervenidos && geoPrediosIntervenidos.features) {
            const matchingPredio = geoPrediosIntervenidos.features.find(f => {
              const m = f.properties.Matricula || f.properties.matricula || '';
              return m && String(m).trim() === String(matricula).trim();
            });
            if (matchingPredio) {
              areaTotal = calcAreaHelper(matchingPredio);
            }
          }
          
          if (areaTotal > 0) {
            descData['Area_Total'] = areaTotal.toFixed(2) + ' m²';
            const areaSobrante = areaTotal - areaRequerida;
            descData['Area_Sobrante'] = areaSobrante.toFixed(2) + ' m²';
          } else {
             // Fallback if no predio found but we want to show the fields
             descData['Area_Total'] = 'N/A';
             descData['Area_Sobrante'] = 'N/A';
          }
          
          selectedVia.value = {
            name: 'Área Intervenida',
            description: descData
          }
        })
      map.on('mouseenter', 'area-intervenidas-fill', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'area-intervenidas-fill', () => { map.getCanvas().style.cursor = '' })
    }

    loading.value = false
  }

  return { loading, loadError, fromCache, hoverLabel, viaHoverLabel, selectedVia, selectedMpio, cachedMunicipios, cachedVias, cachedLocalizaciones, cachedAreaIntervenidas, cachedPrediosIntervenidos, loadSimeva }
}


