import { ref, watch }                         from 'vue'
import maplibregl                   from 'maplibre-gl'
import { useCallouts }              from './useCallouts.js'
import { useMapLayers }             from './useMapLayers.js'
import { useMapFilters }            from './useMapFilters.js'
import { useMapInit, CENTER, ZOOM, BASEMAPS } from './useMapInit.js'
import { useMapStore }              from '../stores/useMapStore.js'
import { pctTiempoTranscurrido }    from '../utils/stats.js'

const delay = ms => new Promise(r => setTimeout(r, ms))

export function useMapOrchestrator(mapContainer, filtersGetter) {
  const store = useMapStore()
  let _map = null
  const mapBearing = ref(0)

  const { visibleCallouts, buildCallouts, updateCalloutPositions, refreshVisibleCallouts }
    = useCallouts(() => _map)

  const { loading, loadError, fromCache, hoverLabel, viaHoverLabel, selectedVia, selectedMpio, cachedMunicipios, cachedVias, cachedLocalizaciones, cachedAreaIntervenidas, cachedPrediosIntervenidos, loadSimeva }
    = useMapLayers(
        () => _map,
        {
          onOptionsLoaded: (opts)    => store.setFilterOptions(opts),
          onCatalogLoaded: (catalog) => store.setProjectCatalog(catalog),
          onStatsLoaded:   (stats)   => { store.setMapStats(stats); store.setMapLoading(false) },
        },
        { buildCallouts, updateCalloutPositions },
      )

  const { selectedSubregion, selectedMunicipio, noResults }
    = useMapFilters(() => _map, filtersGetter, {
        cachedMunicipios, cachedVias, cachedLocalizaciones, cachedAreaIntervenidas, cachedPrediosIntervenidos,
        center: CENTER, zoom: ZOOM,
        refreshVisibleCallouts,
      })

  const { activeBasemap, switcherOpen, terrainActive, switchBasemap, toggleTerrain }
    = useMapInit(mapContainer, {
        onMapCreated: (m) => {
          _map = m
          m.on('rotate', () => {
            mapBearing.value = m.getBearing()
          })
          
          watch(() => store.layerToggles, (toggles) => {
            if (!m) return
            toggles.forEach(t => {
              t.layers.forEach(lId => {
                if (m.getLayer(lId)) {
                  m.setLayoutProperty(lId, 'visibility', t.visible ? 'visible' : 'none')
                }
              })
            })
          }, { deep: true, immediate: true })

          m.on('contextmenu', async (e) => {
            const lng = e.lngLat.lng.toFixed(6)
            const lat = e.lngLat.lat.toFixed(6)
            try {
              await navigator.clipboard.writeText(`Latitud\t${lat}\nLongitud\t${lng}`)
              const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'copy-toast' })
                .setLngLat(e.lngLat)
                .setHTML(`<div style="padding: 4px 8px; font-family: 'Prompt', sans-serif; font-size: 12px; font-weight: 600; color: #0b5640; text-align: center;">¡Coordenadas copiadas!<br>${lat}, ${lng}</div>`)
                .addTo(m)
              setTimeout(() => popup.remove(), 1500)
            } catch (err) {
              console.error('No se pudo copiar:', err)
            }
          })
        },
        onLoad:       () => { store.setMapLoading(true); loadSimeva() },
      })

  function resetBearing() {
    if (!_map) return
    _map.easeTo({ bearing: 0, pitch: 0, duration: 500 })
  }

  watch(() => filtersGetter(), (newFilters) => {
    if (!newFilters) return
    const hasFilter = (newFilters.puente && newFilters.puente !== 'Todos los puentes') ||
                      (newFilters.pap && newFilters.pap !== 'Todos los PAP y otros') ||
                      (newFilters.search)
    
    if (hasFilter && activeBasemap.value === 'ninguno') {
      const sat = BASEMAPS.find(b => b.id === 'satelite')
      if (sat) switchBasemap(sat)
    } else if (!hasFilter && activeBasemap.value === 'satelite') {
      const nin = BASEMAPS.find(b => b.id === 'ninguno')
      if (nin) switchBasemap(nin)
    }
  }, { deep: true })

  function _circuitFeats(nombre, subregion = '') {
    const foundProps = cachedVias.value.features.find(f => f.properties.NOMBRE_VIA === nombre)?.properties
    const circuito = foundProps?.CIRCUITO ?? ''
    const norm = s => s?.toLowerCase().normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').trim() ?? ''
    const normSub = norm(subregion)
    const feats = cachedVias.value.features.filter(f => {
      if (f.properties.CIRCUITO !== circuito) return false
      if (subregion && norm(f.properties.SUBREGION) !== normSub) return false
      return true
    })
    return { circuito, feats }
  }

  function _fitCircuit(feats) {
    const bounds = new maplibregl.LngLatBounds()
    function walk(c) { typeof c[0] === 'number' ? bounds.extend(c) : c.forEach(walk) }
    for (const feat of feats) walk(feat.geometry.coordinates)
    if (!bounds.isEmpty()) _map.fitBounds(bounds, { padding: 80, duration: 400 })
  }

  function openVia(via) {
    if (!_map || !cachedVias.value) return
    const { circuito, feats } = _circuitFeats(via.nombre, via.subregion)
    if (!feats.length) return
    _fitCircuit(feats)
    const first = feats[0].properties
    const sentenceCase = s => s ? s.toLowerCase().replaceAll(/\b\w/g, c => c.toUpperCase()) : ''
    const municipios = [...new Set(feats.map(f => sentenceCase(f.properties.MPIO_NOMBR ?? '')).filter(Boolean))]
    const totalKm = feats.reduce((s, f) => s + (Number.parseFloat(f.properties.Long_km) || 0), 0)
    const avanceFisico = totalKm > 0
      ? feats.reduce((s, f) => {
          const rawFis = Number.parseFloat(f.properties.AV_FISICO) || 0;
          const fisDec = rawFis > 1 ? rawFis / 100 : rawFis;
          return s + fisDec * (Number.parseFloat(f.properties.Long_km) || 0);
        }, 0) / totalKm
      : 0
    selectedVia.value = {
      name: circuito || 'Circuito sin nombre',
      idCircuito:  first['id-circuito'] ?? first.CIRCUITO ?? '',
      subregion: via.subregion || first.SUBREGION || '',
      description: {
        circuitId:               first['id-circuito'] ?? first.CIRCUITO ?? '',
        Subregión:               first.SUBREGION  ?? '',
        Municipio:               municipios.join(', '),
        Circuito:                circuito,
        Contrato:                first.CTO        ?? '',
        Contratista:             first.CONTRATIST ?? '',
        Interventoría:           first.INTERV     ?? '',
        'Longitud (km)':         Math.round(totalKm * 100) / 100,
        'Avance físico':         `${Math.round(avanceFisico * 100)}%`,
        'Fecha de inicio':       first.FECHA_INI  ?? '',
        'Plazo (meses)':         first.PLAZO_MESE ?? '',
        'Duración transcurrida': first.FECHA_INI && first.PLAZO_MESE
          ? `${pctTiempoTranscurrido(first.FECHA_INI, first.PLAZO_MESE)}%` : '',
      },
    }
  }

  function flyToVia(via) {
    if (!_map || !cachedVias.value) return
    const { feats } = _circuitFeats(via.nombre, via.subregion)
    if (feats.length) _fitCircuit(feats)
  }

  let _coordMarker = null

  function flyToCoords(lat, lng) {
    if (!_map) return
    _map.flyTo({ center: [lng, lat], zoom: 15, duration: 400, essential: true })
    if (_coordMarker) _coordMarker.remove()
    _coordMarker = new maplibregl.Marker({ color: '#ef4444' })
      .setLngLat([lng, lat])
      .addTo(_map)
    setTimeout(() => { if (_coordMarker) { _coordMarker.remove(); _coordMarker = null } }, 8000)
  }

  let _devMarker = null

  function toggleDevMarker() {
    if (!_map) return
    if (_devMarker) {
      _devMarker.remove()
      _devMarker = null
      return
    }

    const center = _map.getCenter()
    
    const getPopupElement = (lngLat) => {
      const lat = lngLat.lat.toFixed(6)
      const lng = lngLat.lng.toFixed(6)
      
      const container = document.createElement('div')
      container.style.fontFamily = "'Prompt', sans-serif"
      container.style.fontSize = "11px"
      container.style.padding = "4px 6px"
      container.style.color = "#1a2e20"
      container.style.fontWeight = "600"
      container.style.minWidth = "140px"
      
      container.innerHTML = `
        <div style="color: #0b5640; font-weight: 800; font-size: 12px; margin-bottom: 2px;">Marcador de Desarrollo</div>
        <div style="margin-bottom: 2px;">Lat: <code style="font-family: monospace; font-size: 11px; background: #f3f4f6; padding: 1px 3px; border-radius: 3px;">${lat}</code></div>
        <div style="margin-bottom: 5px;">Lng: <code style="font-family: monospace; font-size: 11px; background: #f3f4f6; padding: 1px 3px; border-radius: 3px;">${lng}</code></div>
        <button class="dev-copy-coords-btn" style="
          width: 100%;
          height: 24px;
          border: 1px solid #0b5640;
          background: #0b5640;
          color: white;
          border-radius: 6px;
          font-family: 'Prompt', sans-serif;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.15s, transform 0.1s, border-color 0.15s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          outline: none;
        ">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="flex-shrink: 0;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span>Copiar coordenadas</span>
        </button>
        <div style="font-size: 9px; color: #6b7280; margin-top: 5px; font-weight: 400; border-top: 1px solid #e5e7eb; padding-top: 4px; text-align: center;">
          Arrastra para mover
        </div>
      `

      const btn = container.querySelector('.dev-copy-coords-btn')
      
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(`${lat}, ${lng}`)
          const span = btn.querySelector('span')
          const originalText = span.textContent
          span.textContent = '¡Copiado!'
          btn.style.background = '#2d8653'
          btn.style.borderColor = '#2d8653'
          await delay(1500)
          span.textContent = originalText
          btn.style.background = '#0b5640'
          btn.style.borderColor = '#0b5640'
        } catch (err) {
          console.error('No se pudo copiar al portapapeles:', err)
        }
      })

      btn.addEventListener('mouseenter', () => {
        if (btn.querySelector('span').textContent !== '¡Copiado!') {
          btn.style.background = '#0d6f53'
          btn.style.borderColor = '#0d6f53'
        }
      })
      btn.addEventListener('mouseleave', () => {
        if (btn.querySelector('span').textContent !== '¡Copiado!') {
          btn.style.background = '#0b5640'
          btn.style.borderColor = '#0b5640'
        }
      })
      btn.addEventListener('mousedown', () => {
        btn.style.transform = 'scale(0.96)'
      })
      btn.addEventListener('mouseup', () => {
        btn.style.transform = 'none'
      })

      return container
    }

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 35,
      className: 'dev-marker-popup'
    })

    _devMarker = new maplibregl.Marker({
      color: '#0b5640',
      draggable: true
    })
      .setLngLat(center)
      .setPopup(popup)
      .addTo(_map)

    popup.setDOMContent(getPopupElement(center))
    _devMarker.togglePopup()

    _devMarker.on('drag', () => {
      const lngLat = _devMarker.getLngLat()
      popup.setDOMContent(getPopupElement(lngLat))
    })
  }

  return {
    activeBasemap, switcherOpen, terrainActive, switchBasemap, toggleTerrain,
    loading, loadError, fromCache, hoverLabel, viaHoverLabel, loadSimeva,
    selectedVia, selectedMpio,
    selectedSubregion, selectedMunicipio,
    noResults,
    openVia,
    flyToVia,
    flyToCoords,
    mapBearing,
    resetBearing,
    toggleDevMarker,
  }
}
