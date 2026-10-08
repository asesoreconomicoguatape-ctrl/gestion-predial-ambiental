import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

export const useMapStore = defineStore('map', () => {
  const activeFilters = ref({
    search: '',
    fuente: 'Todas las fuentes',
    puente: 'Todos los puentes',
    pap:    'Todos los PAP y otros',
  })

  // Catálogo maestro de proyectos cargados con su fuente y tipo
  // Forma: [ { name: string, fuente: string, type: 'puente' | 'pap' }, ... ]
  const projectCatalog = ref([])

  // Lista estática fallback de opciones si aún no se ha cargado el catálogo
  const fallbackOptions = ref({
    fuentes: ['Todas las fuentes'],
    puentes: ['Todos los puentes'],
    paps:    ['Todos los PAP y otros'],
  })

  // Opciones calculadas dinámicamente de forma cascada según los filtros activos
  const filterOptions = computed(() => {
    if (!projectCatalog.value || projectCatalog.value.length === 0) {
      return fallbackOptions.value
    }

    // 1. Fuentes disponibles
    const rawFuentes = [...new Set(projectCatalog.value.map(p => p.fuente).filter(Boolean))]
    rawFuentes.sort((a, b) => a.localeCompare(b, 'es'))
    const fuentes = ['Todas las fuentes', ...rawFuentes]

    // 2. Filtrar catálogo según la fuente seleccionada
    const currentFuente = activeFilters.value.fuente
    const isFuenteFiltered = currentFuente && currentFuente !== 'Todas las fuentes'

    const availableProjects = isFuenteFiltered
      ? projectCatalog.value.filter(p => norm(p.fuente) === norm(currentFuente))
      : projectCatalog.value

    // 3. Puentes y PAPs disponibles para la fuente actual
    const rawPuentes = [...new Set(availableProjects.filter(p => p.type === 'puente').map(p => p.name))]
    rawPuentes.sort((a, b) => a.localeCompare(b, 'es'))
    const puentes = ['Todos los puentes', ...rawPuentes]

    const rawPaps = [...new Set(availableProjects.filter(p => p.type === 'pap').map(p => p.name))]
    rawPaps.sort((a, b) => a.localeCompare(b, 'es'))
    const paps = ['Todos los PAP y otros', ...rawPaps]

    return { fuentes, puentes, paps }
  })

  const mapStats = ref({
    viasIntervenidas: 0,
    longitudTotal:    0,
    municipios:       0,
    proyectos:        0,
    subregiones:      [],
    viasDetalle:      [],
  })

  const mapLoading = ref(true)
  function setMapLoading(val) { mapLoading.value = val }
  
  const layerToggles = ref([
    { id: 'gavino-localizacion', name: 'Puente Gavino - Localización', layers: ['gavino-localizacion-fill', 'gavino-localizacion-outline'], visible: true },
    { id: 'gavino-afectados', name: 'Puente Gavino - Afectados', layers: ['gavino-afectados-fill', 'gavino-afectados-outline', 'gavino-afectados-label'], visible: false },
    { id: 'micasita-afectados', name: 'Mi Casita - Afectados', layers: ['micasita-afectados-fill', 'micasita-afectados-outline'], visible: false },
    { id: 'heliconia-afectados', name: 'Heliconia - Afectados', layers: ['heliconia-afectados-fill', 'heliconia-afectados-outline'], visible: false },
    { id: 'gavino-cauce', name: 'Ocupación Cauce', layers: ['gavino-cauce-circle'], visible: false },
    { id: 'gavino-forestal', name: 'Aprovechamiento Forestal (Gavino)', layers: ['gavino-forestal-symbol'], visible: false },
    { id: 'gavino-abscisas', name: 'Abscisas', layers: ['gavino-abscisas-symbol'], visible: false },
    { id: 'area-intervenidas', name: 'Áreas Intervenidas', layers: ['area-intervenidas-fill', 'area-intervenidas-outline'], visible: true },
    { id: 'predios-intervenidos', name: 'Predios Intervenidos', layers: ['predios-intervenidos-fill', 'predios-intervenidos-outline'], visible: true },
    { id: 'arcgis-forestal', name: 'Inventario Forestal', layers: ['arcgis-forestal-symbol'], visible: true },
  ])
  
  function toggleLayer(id) {
    const layer = layerToggles.value.find(l => l.id === id)
    if (layer) layer.visible = !layer.visible
  }

  const norm = s => s?.toLowerCase().normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').trim() ?? ''

  const filteredStats = computed(() => {
    const { fuente, puente, pap, search } = activeFilters.value
    const hasFuente = fuente && fuente !== 'Todas las fuentes'
    const hasPuente = puente && puente !== 'Todos los puentes'
    const hasPap    = pap && pap !== 'Todos los PAP y otros'
    const q         = search ? norm(search) : ''

    if (!hasFuente && !hasPuente && !hasPap && !q) return mapStats.value

    const vias = mapStats.value.viasDetalle.filter(v => {
      if (hasFuente && norm(v.fuente) !== norm(fuente)) return false
      if (hasPuente && v.proyecto !== puente) return false
      if (hasPap    && v.proyecto !== pap) return false
      if (q && !norm(v.nombre).includes(q)
            && !norm(v.municipio).includes(q)
            && !norm(v.subregion).includes(q)) return false
      return true
    })

    const longitudTotal = vias.reduce((s, v) => s + (v.km || 0), 0)

    return {
      viasIntervenidas: new Set(vias.map(v => v.nombre).filter(Boolean)).size,
      longitudTotal:    Math.round(longitudTotal * 100) / 100,
      municipios:       new Set(vias.map(v => v.municipio).filter(Boolean)).size,
      proyectos:        new Set(vias.map(v => v.proyecto).filter(Boolean)).size,
      viasDetalle:      vias,
      subregiones:      mapStats.value.subregiones,
    }
  })

  function setFilter(filters) {
    const next = { ...filters }
    const prev = activeFilters.value

    // 1. Si cambió la fuente seleccionada
    if (next.fuente !== prev.fuente) {
      if (next.fuente && next.fuente !== 'Todas las fuentes') {
        // Si el puente seleccionado previamente no pertenece a esta nueva fuente, reiniciar
        const matchingPuente = projectCatalog.value.find(
          p => p.type === 'puente' && p.name === next.puente && norm(p.fuente) === norm(next.fuente)
        )
        if (!matchingPuente) {
          next.puente = 'Todos los puentes'
        }

        // Si el pap seleccionado previamente no pertenece a esta nueva fuente, reiniciar
        const matchingPap = projectCatalog.value.find(
          p => p.type === 'pap' && p.name === next.pap && norm(p.fuente) === norm(next.fuente)
        )
        if (!matchingPap) {
          next.pap = 'Todos los PAP y otros'
        }
      }
    }

    // 2. Si el usuario seleccionó un puente específico
    if (next.puente !== prev.puente && next.puente && next.puente !== 'Todos los puentes') {
      next.pap = 'Todos los PAP y otros' // Exclusividad entre puente y pap
      const found = projectCatalog.value.find(p => p.type === 'puente' && p.name === next.puente)
      if (found && found.fuente) {
        next.fuente = found.fuente
      }
    }

    // 3. Si el usuario seleccionó un PAP específico
    if (next.pap !== prev.pap && next.pap && next.pap !== 'Todos los PAP y otros') {
      next.puente = 'Todos los puentes' // Exclusividad entre puente y pap
      const found = projectCatalog.value.find(p => p.type === 'pap' && p.name === next.pap)
      if (found && found.fuente) {
        next.fuente = found.fuente
      }
    }

    activeFilters.value = next
  }

  function setProjectCatalog(catalog) {
    projectCatalog.value = catalog
  }

  function setFilterOptions(options) {
    fallbackOptions.value = options
  }

  function setMapStats(stats) {
    mapStats.value = stats
  }

  return {
    activeFilters,
    filterOptions,
    projectCatalog,
    mapStats,
    filteredStats,
    mapLoading,
    layerToggles,
    toggleLayer,
    setFilter,
    setFilterOptions,
    setProjectCatalog,
    setMapStats,
    setMapLoading,
  }
})
