import { ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { useMapStore } from '../stores/useMapStore.js'

const normUp = s => (s ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').toUpperCase()
const normLow = s => (s ?? '').toLowerCase().normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').trim()

const PROJECT_ALIASES = {
  'Concordia Majagual': ['Variante Majagual'],
  'Variante Majagual': ['Concordia Majagual'],
  'Puente El Verdun Jardin': ['Puente El Verdún', 'Puente El Verdun - Jardín'],
  'Puente El Verdún': ['Puente El Verdun Jardin', 'Puente El Verdun - Jardín'],
  'Puente San Fermín - Briceño': ['Puente Briceño', 'Puente San Fermin - Briceño'],
  'Puente Briceño': ['Puente San Fermín - Briceño'],
  'PAP El Tres - San Pedro': ['PAP El Tres San Pedro de Uraba', 'PAP El Tres - San Pedro de Urabá'],
  'PAP El Tres San Pedro de Uraba': ['PAP El Tres - San Pedro'],
  'San Antonio de Prado': ['PAP San Antonio de Prado', 'P.A.P San Antonio de Prado'],
  'PAP San Antonio de Prado': ['San Antonio de Prado', 'P.A.P San Antonio de Prado'],
  'Puente La Loma Urrao': ['Puente La Loma'],
  'Puente La Loma': ['Puente La Loma Urrao'],
  'Puente El Volcan': ['Puente El Vólcan'],
  'Puente El Vólcan': ['Puente El Volcan'],
  'Puente Churimbo': ['Puente El Churimbo'],
  'Puente El Churimbo': ['Puente Churimbo'],
  'Puente Gabino': ['Puente Gavino'],
  'Puente Gavino': ['Puente Gabino'],
  'Granada 0+900': ['0 + 900 Variante El Santuario'],
  '0 + 900 Variante El Santuario': ['Granada 0+900']
}

function getProjectWithAliases(projectName) {
  if (!projectName) return []
  const list = [projectName]
  const aliases = PROJECT_ALIASES[projectName] || []
  return [...new Set([...list, ...aliases])]
}

function _getMpioFillColor(isTerrain) {
  if (isTerrain) {
    return ['literal', '#0284c7']
  }
  return ['literal', '#2d8653']
}

function _getMpioFillOpacity(isTerrain) {
  if (isTerrain) return ['case', ['boolean', ['feature-state', 'hover'], false], 0.3, 0.1]
  return ['case', ['boolean', ['feature-state', 'hover'], false], 0.22, 0.07]
}

function _applyMpioStyle(map) {
  if (!map.getLayer('municipios-fill')) return
  const f = null
  map.setFilter('municipios-fill', f)
  map.setFilter('municipios-outline', f)
  if (map.getLayer('municipios-labels')) {
    map.setFilter('municipios-labels', f)
    map.setLayoutProperty('municipios-labels', 'visibility', 'none')
  }

  const isTerrain = !!map.getTerrain()
  map.setPaintProperty('municipios-fill', 'fill-color', _getMpioFillColor(isTerrain))
  map.setPaintProperty('municipios-fill', 'fill-opacity', _getMpioFillOpacity(isTerrain))
}

export function useMapFilters(getMap, filtersRef, { cachedMunicipios, cachedVias, cachedLocalizaciones, cachedAreaIntervenidas, cachedPrediosIntervenidos, center, zoom, refreshVisibleCallouts } = {}) {
  const store = useMapStore()
  const selectedSubregion = ref('')
  const selectedMunicipio = ref('')
  const noResults         = ref(false)

  function coordsBounds(coords, bounds) {
    if (typeof coords[0] === 'number') { bounds.extend(coords) }
    else coords.forEach(c => coordsBounds(c, bounds))
  }

  function flyToGeometries(geometries, opts = {}) {
    const map = getMap()
    if (!map) return
    const bounds = new maplibregl.LngLatBounds()
    geometries.forEach(g => coordsBounds(g.coordinates, bounds))
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        ...opts,
        duration: 2500,
        essential: true
      })
    }
  }

  function _applyViasStyle(map, { hasAny, hasFuente, fuente, targetProjects, names }) {
    // ── 1. Filtrar Vías ──
    if (map.getLayer('vias-line')) {
      let viasFilter = null
      if (hasAny) {
        if (names && names.length) {
          viasFilter = ['in', ['get', 'NOMBRE_VIA'], ['literal', names]]
        } else {
          viasFilter = ['==', ['literal', false], ['literal', true]]
        }
      }
      map.setFilter('vias-line', viasFilter)
      map.setFilter('vias-casing', viasFilter)
      if (map.getLayer('vias-hit-target')) {
        map.setFilter('vias-hit-target', viasFilter)
      }
    }

    // ── 2. Filtrar Polígonos de Proyectos (gavino-localizacion) ──
    if (map.getLayer('gavino-localizacion-fill')) {
      if (targetProjects && targetProjects.length > 0) {
        const locFilter = ['in', ['get', 'NOMBRE_PROYECTO'], ['literal', targetProjects]]
        map.setFilter('gavino-localizacion-fill', locFilter)
        if (map.getLayer('gavino-localizacion-outline')) {
          map.setFilter('gavino-localizacion-outline', locFilter)
        }
      } else {
        map.setFilter('gavino-localizacion-fill', null)
        if (map.getLayer('gavino-localizacion-outline')) {
          map.setFilter('gavino-localizacion-outline', null)
        }
      }
    }

    // ── 3. Filtrar Puntos de Proyectos (proyecto-point-*) ──
    if (map.getLayer('proyecto-point-circle')) {
      if (targetProjects && targetProjects.length > 0) {
        const ptFilter = ['in', ['get', 'nombre'], ['literal', targetProjects]]
        map.setFilter('proyecto-point-circle', ptFilter)
        if (map.getLayer('proyecto-point-label')) map.setFilter('proyecto-point-label', ptFilter)
        if (map.getLayer('proyecto-point-pulse')) {
          map.setFilter('proyecto-point-pulse', ['all', ptFilter, ['==', ['get', 'enEjecucion'], true]])
        }
      } else {
        map.setFilter('proyecto-point-circle', null)
        if (map.getLayer('proyecto-point-label')) map.setFilter('proyecto-point-label', null)
        if (map.getLayer('proyecto-point-pulse')) {
          map.setFilter('proyecto-point-pulse', ['==', ['get', 'enEjecucion'], true])
        }
      }
    }

    // ── 4. Filtrar Capa de Áreas Intervenidas (area-intervenidas) ──
    if (map.getLayer('area-intervenidas-fill')) {
      if (targetProjects && targetProjects.length > 0) {
        const expressions = [['in', ['get', 'Proyecto'], ['literal', targetProjects]]]
        if (hasFuente) {
          expressions.push(['==', ['get', 'Fuente_Financiacion'], fuente])
        }
        const areaFilter = expressions.length > 1 ? ['any', ...expressions] : expressions[0]
        map.setFilter('area-intervenidas-fill', areaFilter)
        if (map.getLayer('area-intervenidas-outline')) {
          map.setFilter('area-intervenidas-outline', areaFilter)
        }
      } else {
        map.setFilter('area-intervenidas-fill', null)
        if (map.getLayer('area-intervenidas-outline')) {
          map.setFilter('area-intervenidas-outline', null)
        }
      }
    }

    // ── 5. Filtrar Capa de Predios Intervenidos (predios-intervenidos) ──
    if (map.getLayer('predios-intervenidos-fill')) {
      if (targetProjects && targetProjects.length > 0) {
        const predioFilter = ['in', ['get', 'Proyecto'], ['literal', targetProjects]]
        map.setFilter('predios-intervenidos-fill', predioFilter)
        if (map.getLayer('predios-intervenidos-outline')) {
          map.setFilter('predios-intervenidos-outline', predioFilter)
        }
      } else {
        map.setFilter('predios-intervenidos-fill', null)
        if (map.getLayer('predios-intervenidos-outline')) {
          map.setFilter('predios-intervenidos-outline', null)
        }
      }
    }
  }

  function _resetFlight(map, filters) {
    refreshVisibleCallouts?.(filters)
    if (cachedMunicipios?.value) {
      flyToGeometries(cachedMunicipios.value.features.map(f => f.geometry), { padding: 40 })
    } else {
      map.flyTo({ center, zoom, duration: 400 })
    }
  }

  function _handleFlightAndLabels(map, filters, { hasAny, hasCir, targetProjects, search }) {
    if (!hasAny) return _resetFlight(map, filters)
    if (!cachedMunicipios.value) return

    if (targetProjects && targetProjects.length > 0) {
      const targetSet = new Set(targetProjects)
      let featsToFly = []

      if (cachedLocalizaciones?.value?.features) {
        const feats = cachedLocalizaciones.value.features.filter(f => targetSet.has(f.properties.NOMBRE_PROYECTO))
        featsToFly = featsToFly.concat(feats)
      }
      if (cachedAreaIntervenidas?.value?.features) {
        const feats = cachedAreaIntervenidas.value.features.filter(f => targetSet.has(f.properties.Proyecto))
        featsToFly = featsToFly.concat(feats)
      }
      if (cachedPrediosIntervenidos?.value?.features && featsToFly.length === 0) {
        const feats = cachedPrediosIntervenidos.value.features.filter(f => targetSet.has(f.properties.Proyecto))
        featsToFly = featsToFly.concat(feats)
      }
      if (cachedVias?.value?.features && featsToFly.length === 0) {
        const searchNames = new Set(store.filteredStats.viasDetalle.map(v => v.nombre))
        const vias = cachedVias.value.features.filter(f => searchNames.has(f.properties.NOMBRE_VIA))
        featsToFly = featsToFly.concat(vias)
      }

      if (featsToFly.length) {
        const allPoints = featsToFly.every(f => f.geometry.type === 'Point')
        if (allPoints) {
          const coords = featsToFly[0].geometry.coordinates
          map.flyTo({ center: [coords[0], coords[1]], zoom: 14, duration: 1500, essential: true })
        } else {
          flyToGeometries(featsToFly.map(f => f.geometry), { padding: hasCir ? 90 : 50 })
        }
      }
      map.once('moveend', () => refreshVisibleCallouts?.(filters))
    } else if (search && cachedVias.value) {
      const searchNames = new Set(store.filteredStats.viasDetalle.map(v => v.nombre))
      const vias = cachedVias.value.features.filter(f => searchNames.has(f.properties.NOMBRE_VIA))
      if (vias.length) flyToGeometries(vias.map(f => f.geometry), { padding: 100 })
      map.once('moveend', () => refreshVisibleCallouts?.(filters))
    }
  }

  function _updateNoResults({ search, targetProjects }) {
    if (!cachedVias.value) {
      noResults.value = false
      return
    }
    const hasFilter = !!(search || (targetProjects && targetProjects.length))
    noResults.value = hasFilter && store.filteredStats.viasDetalle.length === 0
  }

  function applyFilters(filters) {
    const map = getMap()
    if (!map) return

    const fuente = filters.fuente ?? 'Todas las fuentes'
    const puente = filters.puente ?? 'Todos los puentes'
    const pap    = filters.pap ?? 'Todos los PAP y otros'
    const search = (filters.search ?? '').toLowerCase().trim()

    const hasFuente = fuente && fuente !== 'Todas las fuentes'
    const hasPuente = puente && puente !== 'Todos los puentes'
    const hasPap    = pap && pap !== 'Todos los PAP y otros'
    const selectedProyecto = hasPuente ? puente : hasPap ? pap : ''
    const hasCir = !!selectedProyecto

    let targetProjects = null

    if (hasCir) {
      targetProjects = getProjectWithAliases(selectedProyecto)
    } else if (hasFuente) {
      const catalogMatches = store.projectCatalog.filter(p => normLow(p.fuente) === normLow(fuente))
      const baseNames = catalogMatches.map(p => p.name)
      const allNames = []
      baseNames.forEach(n => allNames.push(...getProjectWithAliases(n)))
      targetProjects = [...new Set(allNames)]
    }

    const names = store.filteredStats.viasDetalle.map(v => v.nombre)
    const hasAny = hasCir || hasFuente || !!search

    const state = {
      proyecto: selectedProyecto,
      fuente,
      hasFuente,
      hasCir,
      hasAny,
      targetProjects,
      names,
      search,
    }

    _applyMpioStyle(map)
    _applyViasStyle(map, state)
    _handleFlightAndLabels(map, filters, state)
    _updateNoResults(state)
  }

  watch(
    [filtersRef, cachedMunicipios],
    ([filters, mun]) => {
      if (mun) {
        applyFilters(filters)
      }
    },
    { deep: true, immediate: true }
  )

  return { selectedSubregion, selectedMunicipio, noResults }
}
