import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import {
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  Rectangle,
  ScaleControl,
  TileLayer,
  useMap,
  ZoomControl,
} from 'react-leaflet'
import L from 'leaflet'
import shp from 'shpjs'
import * as toGeoJSON from '@tmcw/togeojson'
import 'leaflet/dist/leaflet.css'
import './App.css'

const INITIAL_CENTER = [33.35, 78.28]
const INITIAL_ZOOM = 7
const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN

const basemaps = [
  {
    id: 'arcgis-imagery',
    label: 'ArcGIS Imagery',
    type: 'generic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    thumbnail: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/7/10',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  },
  {
    id: 'arcgis-topographic',
    label: 'ArcGIS Topographic',
    type: 'generic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    thumbnail: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/4/7/10',
    attribution: '&copy; Esri',
  },
  {
    id: 'openstreetmap',
    label: 'OpenStreetMap',
    type: 'generic',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    thumbnail: 'https://tile.openstreetmap.org/4/10/7.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  {
    id: 'google-hybrid',
    label: 'Google Hybrid',
    type: 'generic',
    url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    thumbnail: 'https://mt1.google.com/vt/lyrs=y&x=10&y=7&z=4',
    attribution: '&copy; Google',
  },
]

const projectPolygons = []

const layerCatalog = [
  { id: 'gpsTracks', label: 'GPS tracks', enabled: true, color: '#af52de' },
  { id: 'birds', label: 'Bird observations', enabled: true, color: '#007aff' },
  { id: 'mammals', label: 'Mammal observations', enabled: true, color: '#f59e0b' },
  { id: 'plants', label: 'Plant observations', enabled: true, color: '#34c759' },
]

const trackColors = ['#007aff', '#ff375f', '#34c759', '#ff9f0a', '#af52de', '#5ac8fa']
const uploadColorPalette = ['#5ac8fa', '#ff2d55', '#5856d6', '#ff9500', '#30d158', '#64d2ff', '#ff6482', '#8e8e93']
const WEATHER_API_BASE = 'https://api.open-meteo.com/v1/forecast'
const WEATHER_ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive'

const weatherCodeLabels = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
}

 let geoPackageModulePromise
 async function loadGeoPackage() {
   geoPackageModulePromise ??= Promise.all([
     import('@ngageoint/geopackage'),
     import('@ngageoint/geopackage/dist/sql-wasm.wasm?url'),
   ]).then(([module, wasm]) => {
     module.setSqljsWasmLocateFile(() => wasm.default)
     return module
   })

   return geoPackageModulePromise
 }

const getLayerUrl = (basemap) => {
  if (basemap.type === 'mapbox' && mapboxToken) {
    return `https://api.mapbox.com/styles/v1/${basemap.styleId}/tiles/256/{z}/{x}/{y}?access_token=${mapboxToken}`
  }

  return basemap.url || basemap.fallback
}

const getMarkerIcon = (color) =>
  L.divIcon({
    className: 'custom-marker',
    html: `<span class="marker-dot" style="background: ${color};"></span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })

function getDateInputValue(date) {
  return date.toISOString().slice(0, 10)
}

function getDateOffset(date, days) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

function formatWeatherDate(value, options = { month: 'short', day: 'numeric' }) {
  if (!value) return 'Unavailable'
  return new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, options)
}

function getWeatherLabel(code) {
  return weatherCodeLabels[code] || 'Unknown conditions'
}

function formatWeatherValue(value, suffix = '') {
  return typeof value === 'number' ? `${Math.round(value * 10) / 10}${suffix}` : '—'
}

function parseCoordinatePairs(coordinates) {
  if (!Array.isArray(coordinates)) return []

  return coordinates.map(([lng, lat]) => [lat, lng])
}

function extractMovementTrack(geojson) {
  const positions = []
  const timestamps = []

  for (const feature of geojson?.features || []) {
    const geometry = feature.geometry
    if (!geometry) continue

    const featureLines = geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : []
    const featureTimes = feature.properties?.coordinateProperties?.times || []
    const flattenedTimes = featureTimes.flat?.() || featureTimes

    featureLines.forEach((line, lineIndex) => {
      positions.push(...parseCoordinatePairs(line))
      const lineTimes = Array.isArray(featureTimes[0]) ? featureTimes[lineIndex] || [] : flattenedTimes
      timestamps.push(...line.map((_, pointIndex) => lineTimes[pointIndex] || null))
    })
  }

  return { positions, timestamps }
}

function formatTrackTime(value) {
  if (!value) return 'Time unavailable'

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function parseCsvValue(value) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const unquoted = trimmed.replace(/^"|"$/g, '').replace(/""/g, '"')
  const number = Number(unquoted)
  return Number.isNaN(number) ? unquoted : number
}

function parseCsv(text) {
  const rows = []
  let row = []
  let value = ''
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    const nextCharacter = text[index + 1]

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"'
      index += 1
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(value)
      value = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1
      row.push(value)
      if (row.some((item) => item.trim())) rows.push(row)
      row = []
      value = ''
    } else {
      value += character
    }
  }

  row.push(value)
  if (row.some((item) => item.trim())) rows.push(row)
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one row')

  const headers = rows[0].map((header) => parseCsvValue(header.replace(/^\uFEFF/, '')))
  const coordinateNames = headers.map((header) => String(header).trim().toLowerCase().replace(/\s+/g, '_'))
  const longitudeIndex = coordinateNames.findIndex((name) => [
    'longitude', 'lon', 'lng', 'x', 'private_longitude', 'obscured_longitude',
  ].includes(name))
  const latitudeIndex = coordinateNames.findIndex((name) => [
    'latitude', 'lat', 'y', 'private_latitude', 'obscured_latitude',
  ].includes(name))

  if (longitudeIndex < 0 || latitudeIndex < 0) {
    throw new Error('CSV must include longitude/lon/lng/x and latitude/lat/y columns')
  }

  return {
    type: 'FeatureCollection',
    features: rows.slice(1).map((cells) => {
      const properties = Object.fromEntries(headers.map((header, index) => [header, parseCsvValue(cells[index] || '')]))
      return {
        type: 'Feature',
        properties,
        geometry: {
          type: 'Point',
          coordinates: [properties[headers[longitudeIndex]], properties[headers[latitudeIndex]]],
        },
      }
    }).filter((feature) => feature.geometry.coordinates.every((coordinate) => typeof coordinate === 'number')),
  }
}

function getUploadLayer(name, geojson, color = '#7dd3fc') {
  return {
    id: `upload-${Date.now()}-${Math.random()}`,
    name: name.replace(/\.[^.]+$/, ''),
    type: 'geojson',
    enabled: true,
    color,
    geojson,
  }
}

function assignUniqueUploadColors(layers, existingLayers) {
  const reservedColors = new Set(layerCatalog.map((layer) => layer.color))
  const usedColors = new Set(existingLayers.map((layer) => layer.color).filter(Boolean))

  return layers.map((layer) => {
    if (layer.isBirdLayer || layer.isMammalLayer || layer.isPlantLayer) return layer

    const color = uploadColorPalette.find((candidate) => !reservedColors.has(candidate) && !usedColors.has(candidate))
      || `hsl(${(usedColors.size * 137.5) % 360} 70% 50%)`
    usedColors.add(color)
    return { ...layer, color }
  })
}

function getFeatureLabel(feature, fallback) {
  const properties = feature?.properties || {}
  return properties.common_name
    || properties.species_guess
    || properties.scientific_name
    || properties.taxon_name
    || properties.name
    || fallback
}

function getBirdImageUrl(feature) {
  const properties = feature?.properties || {}
  const directUrl = properties.image_url
    || properties.imageUrl
    || properties.photo_url
    || properties.default_photo_url
    || properties.default_photo?.medium_url
    || properties.default_photo?.url

  if (typeof directUrl === 'string' && directUrl.startsWith('http')) return directUrl

  const imageProperty = Object.entries(properties).find(([key, value]) =>
    /(image|photo|picture).*url/i.test(key) && typeof value === 'string' && value.startsWith('http'),
  )
  return imageProperty?.[1] || null
}

function LayerSwitch({ label, enabled, color, onChange }) {
  return (
    <label className="layer-switch">
      <input type="checkbox" checked={enabled} onChange={onChange} />
      <span className="layer-switch-track" style={{ '--layer-color': color }} aria-hidden="true">
        <span className="layer-switch-thumb" />
      </span>
      <span className="layer-switch-label">{label}</span>
    </label>
  )
}

function SpeciesFilter({ layer, selectedSpecies, onToggle, label }) {
  const species = [...new Set(layer.geojson.features.map((feature) => getFeatureLabel(feature, 'Unknown species')))].sort()

  return (
    <details className="species-filter">
      <summary>
        {selectedSpecies.length ? `${selectedSpecies.length} ${label.toLowerCase()} species selected` : `All ${label.toLowerCase()} species`}
      </summary>
      <div className="species-options">
        {species.map((name) => (
          <label key={name}>
            <input
              type="checkbox"
              checked={selectedSpecies.includes(name)}
              onChange={() => onToggle(name)}
            />
            <span>{name}</span>
          </label>
        ))}
      </div>
    </details>
  )
}

function BirdPopup({ feature, fallback }) {
  const properties = feature?.properties || {}
  const imageUrl = getBirdImageUrl(feature)
  const observationUrl = properties.uri || properties.observation_url || properties.url

  return (
    <div className="bird-popup">
      {imageUrl && <img src={imageUrl} alt={getFeatureLabel(feature, fallback)} loading="lazy" />}
      <strong>{getFeatureLabel(feature, fallback)}</strong>
      {properties.scientific_name && properties.scientific_name !== getFeatureLabel(feature, fallback) && (
        <em>{properties.scientific_name}</em>
      )}
      {typeof observationUrl === 'string' && observationUrl.startsWith('http') && (
        <a href={observationUrl} target="_blank" rel="noreferrer">View observation</a>
      )}
    </div>
  )
}

function renderFeatureGeometry(feature, layerName, color, isBird = false) {
  const geometry = feature?.geometry

  if (!geometry) return null

  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates
    return (
      <Marker key={`${layerName}-${Math.random()}`} position={[lat, lng]} icon={getMarkerIcon(color)}>
        <Popup>{isBird ? <BirdPopup feature={feature} fallback={layerName} /> : getFeatureLabel(feature, layerName)}</Popup>
      </Marker>
    )
  }

  if (geometry.type === 'MultiPoint') {
    return geometry.coordinates.map((point, index) => {
      const [lng, lat] = point
      return (
        <Marker key={`${layerName}-point-${index}`} position={[lat, lng]} icon={getMarkerIcon(color)}>
          <Popup>
            {isBird
              ? <BirdPopup feature={feature} fallback={`${layerName} point ${index + 1}`} />
              : getFeatureLabel(feature, `${layerName} point ${index + 1}`)}
          </Popup>
        </Marker>
      )
    })
  }

  if (geometry.type === 'LineString') {
    return (
      <Polyline
        key={`${layerName}-line-${Math.random()}`}
        positions={parseCoordinatePairs(geometry.coordinates)}
        pathOptions={{ color, weight: 3, opacity: 0.9 }}
      />
    )
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map((line, index) => (
      <Polyline
        key={`${layerName}-multiline-${index}`}
        positions={parseCoordinatePairs(line)}
        pathOptions={{ color, weight: 3, opacity: 0.9 }}
      />
    ))
  }

  if (geometry.type === 'Polygon') {
    return (
      <Polygon
        key={`${layerName}-polygon-${Math.random()}`}
        positions={geometry.coordinates.map(parseCoordinatePairs)}
        pathOptions={{ color, fillColor: color, fillOpacity: 0.25, weight: 2 }}
      >
        <Popup>{getFeatureLabel(feature, layerName)}</Popup>
      </Polygon>
    )
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((polygon, index) => (
      <Polygon
        key={`${layerName}-multipolygon-${index}`}
        positions={polygon.map(parseCoordinatePairs)}
        pathOptions={{ color, fillColor: color, fillOpacity: 0.25, weight: 2 }}
      >
        <Popup>{getFeatureLabel(feature, `${layerName} polygon ${index + 1}`)}</Popup>
      </Polygon>
    ))
  }

  return null
}

function FitUploadedLayers({ uploadedLayers }) {
  const map = useMap()

  useEffect(() => {
    const bounds = L.latLngBounds([])

    uploadedLayers
      .filter((layer) => layer.enabled && layer.geojson?.features?.length)
      .forEach((layer) => {
        const layerBounds = L.geoJSON(layer.geojson).getBounds()
        if (layerBounds.isValid()) bounds.extend(layerBounds)
      })

    if (bounds.isValid()) map.fitBounds(bounds.pad(0.08), { maxZoom: 12 })
  }, [map, uploadedLayers])

  return null
}

function SyncMapSize({ sidebarCollapsed }) {
  const map = useMap()

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      map.invalidateSize({ pan: false })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [map, sidebarCollapsed])

  return null
}

function MapPanel({ basemapId, layerState, resetKey, sidebarCollapsed, uploadedLayers, birdLayer, selectedBirdSpecies, mammalLayer, selectedMammalSpecies, plantLayer, selectedPlantSpecies, movementTracks, trackProgress }) {
  const selectedBasemap = basemaps.find((item) => item.id === basemapId) ?? basemaps[0]
  const visibleUploadedLayers = useMemo(() => [
    ...uploadedLayers,
    birdLayer ? { ...birdLayer, enabled: layerState.birds } : null,
    mammalLayer ? { ...mammalLayer, enabled: layerState.mammals } : null,
    plantLayer ? { ...plantLayer, enabled: layerState.plants } : null,
  ].filter(Boolean), [uploadedLayers, birdLayer, layerState.birds, mammalLayer, layerState.mammals, plantLayer, layerState.plants])

  return (
    <MapContainer
      key={resetKey}
      className="map-surface"
      center={INITIAL_CENTER}
      zoom={INITIAL_ZOOM}
      scrollWheelZoom
      zoomControl={false}
      preferCanvas
    >
      <ZoomControl position="topright" />
      <ScaleControl position="bottomleft" />
      <SyncMapSize sidebarCollapsed={sidebarCollapsed} />
      <FitUploadedLayers uploadedLayers={visibleUploadedLayers} />
      <TileLayer
        url={getLayerUrl(selectedBasemap)}
        attribution={
          selectedBasemap.attribution
        }
      />
      {visibleUploadedLayers
        .filter((layer) => layer.enabled)
        .map((layer) => {
          if (layer.movementTrack) return null

          if (layer.type === 'raster' && layer.metadata?.bbox) {
            const [minX, minY, maxX, maxY] = layer.metadata.bbox
            return (
              <Rectangle
                key={layer.id}
                bounds={[
                  [minY, minX],
                  [maxY, maxX],
                ]}
                pathOptions={{
                  color: '#7dd3fc',
                  fillColor: '#7dd3fc',
                  fillOpacity: 0.08,
                  weight: 2,
                  dashArray: '8 6',
                }}
              >
                <Popup>{layer.name}</Popup>
              </Rectangle>
            )
          }

          if (!layer.geojson?.features) return null

          const features = layer.isBirdLayer
            ? layer.geojson.features.filter((feature) => {
              const species = getFeatureLabel(feature, '')
              return selectedBirdSpecies.length === 0 || selectedBirdSpecies.includes(species)
            })
            : layer.isMammalLayer
              ? layer.geojson.features.filter((feature) => {
                const species = getFeatureLabel(feature, '')
                return selectedMammalSpecies.length === 0 || selectedMammalSpecies.includes(species)
              })
              : layer.isPlantLayer
                ? layer.geojson.features.filter((feature) => {
                  const species = getFeatureLabel(feature, '')
                  return selectedPlantSpecies.length === 0 || selectedPlantSpecies.includes(species)
                })
            : layer.geojson.features

          return features.map((feature, index) =>
            renderFeatureGeometry(
              feature,
              `${layer.name}-${index}`,
              layer.color || '#7dd3fc',
              layer.isBirdLayer || layer.isMammalLayer || layer.isPlantLayer,
            ),
          )
        })}

      {layerState.gpsTracks && movementTracks.map((trackLayer) => {
        const track = trackLayer.movementTrack
        const pointIndex = Math.floor(trackProgress * (track.positions.length - 1))
        const visibleTrack = track.positions.slice(0, pointIndex + 1)
        const activePoint = track.positions[pointIndex]

        return (
          <Fragment key={trackLayer.id}>
            {visibleTrack.length > 1 && (
              <Polyline
                positions={visibleTrack}
                pathOptions={{ color: trackLayer.color, weight: 2, opacity: 0.95 }}
              />
            )}
            {activePoint && (
              <Marker position={activePoint} icon={getMarkerIcon(trackLayer.color)}>
                <Popup>
                  <strong>{trackLayer.name}</strong>
                  <br />
                  {formatTrackTime(track.timestamps[pointIndex])}
                </Popup>
              </Marker>
            )}
          </Fragment>
        )
      })}

      {layerState.projects &&
        projectPolygons.map((project) => (
          <Rectangle
            key={project.id}
            bounds={project.bounds}
            pathOptions={{
              color: project.color,
              fillColor: project.color,
              fillOpacity: 0.24,
              weight: 2,
            }}
          >
            <Popup>{project.name}</Popup>
          </Rectangle>
        ))}

    </MapContainer>
  )
}

function App() {
  const [basemapId, setBasemapId] = useState('arcgis-imagery')
  const [isDarkMode, setIsDarkMode] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [layers, setLayers] = useState(() => Object.fromEntries(layerCatalog.map((layer) => [layer.id, layer.enabled])))
  const [uploadedLayers, setUploadedLayers] = useState([])
  const [birdLayer, setBirdLayer] = useState(null)
  const [selectedBirdSpecies, setSelectedBirdSpecies] = useState([])
  const [mammalLayer, setMammalLayer] = useState(null)
  const [selectedMammalSpecies, setSelectedMammalSpecies] = useState([])
  const [plantLayer, setPlantLayer] = useState(null)
  const [selectedPlantSpecies, setSelectedPlantSpecies] = useState([])
  const yesterday = getDateInputValue(getDateOffset(new Date(), -1))
  const [historicalStart, setHistoricalStart] = useState(getDateInputValue(getDateOffset(new Date(), -7)))
  const [historicalEnd, setHistoricalEnd] = useState(yesterday)
  const [weatherForecast, setWeatherForecast] = useState(null)
  const [weatherHistory, setWeatherHistory] = useState(null)
  const [weatherLoading, setWeatherLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [weatherError, setWeatherError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [trackProgress, setTrackProgress] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [resetKey, setResetKey] = useState(0)
  const [uploadNotice, setUploadNotice] = useState('')
  const inputRef = useRef(null)

  const movementTracks = uploadedLayers.filter(
    (layer) => layer.enabled && layer.movementTrack?.positions.length > 0,
  )

  useEffect(() => {
    if (!isPlaying || movementTracks.length === 0) return undefined

    const timer = window.setInterval(() => {
      setTrackProgress((current) => (current >= 1 ? 0 : Math.min(1, current + 0.01)))
    }, Math.max(50, 900 / playbackSpeed))

    return () => window.clearInterval(timer)
  }, [isPlaying, movementTracks.length, playbackSpeed])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({
      latitude: String(INITIAL_CENTER[0]),
      longitude: String(INITIAL_CENTER[1]),
      current: 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
      forecast_days: '7',
      timezone: 'auto',
    })

    setWeatherLoading(true)
    setWeatherError('')
    fetch(`${WEATHER_API_BASE}?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Forecast request failed')
        return response.json()
      })
      .then((data) => setWeatherForecast(data))
      .catch((error) => {
        if (error.name !== 'AbortError') setWeatherError('Current weather is unavailable.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setWeatherLoading(false)
      })

    return () => controller.abort()
  }, [])

  useEffect(() => {
    const start = new Date(`${historicalStart}T00:00:00Z`)
    const end = new Date(`${historicalEnd}T00:00:00Z`)
    const rangeIsValid = historicalStart && historicalEnd && historicalStart <= historicalEnd && historicalEnd <= yesterday

    if (!rangeIsValid || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setHistoryError(historicalEnd > yesterday ? 'Historical weather is only available through yesterday.' : 'Choose a valid historical date range.')
      setHistoryLoading(false)
      setWeatherHistory(null)
      return undefined
    }

    const controller = new AbortController()
    const params = new URLSearchParams({
      latitude: String(INITIAL_CENTER[0]),
      longitude: String(INITIAL_CENTER[1]),
      start_date: historicalStart,
      end_date: historicalEnd,
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max',
      timezone: 'auto',
    })

    setHistoryLoading(true)
    setHistoryError('')
    fetch(`${WEATHER_ARCHIVE_API}?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Historical request failed')
        return response.json()
      })
      .then((data) => setWeatherHistory(data))
      .catch((error) => {
        if (error.name !== 'AbortError') setHistoryError('Historical weather is unavailable for this range.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false)
      })

    return () => controller.abort()
  }, [historicalStart, historicalEnd, yesterday])

  const toggleLayer = (layerId) => {
    setLayers((current) => ({
      ...current,
      [layerId]: !current[layerId],
    }))
  }

  const toggleUploadedLayer = (layerId) => {
    setUploadedLayers((current) =>
      current.map((layer) => (layer.id === layerId ? { ...layer, enabled: !layer.enabled } : layer)),
    )
  }

  const handleFeatureUpload = async (event) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    const newLayers = []
    const shapefileGroups = new Map()

    files.forEach((file) => {
      const fileName = file.name.toLowerCase()
      const extension = fileName.slice(fileName.lastIndexOf('.'))
      if (!['.shp', '.shx', '.dbf', '.prj'].includes(extension)) return
      const baseName = fileName.slice(0, fileName.lastIndexOf('.'))
      const group = shapefileGroups.get(baseName) || {}
      group[extension.slice(1)] = file
      shapefileGroups.set(baseName, group)
    })

    for (const file of files) {
      const fileName = file.name.toLowerCase()

      try {
        if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
          const geojson = JSON.parse(await file.text())
          newLayers.push({
            id: `upload-${Date.now()}-${Math.random()}`,
            name: file.name.replace(/\.[^.]+$/, ''),
            type: 'geojson',
            enabled: true,
            color: '#7dd3fc',
            geojson,
          })
          continue
        }

        if (fileName.endsWith('.gpx') || fileName.endsWith('.kml')) {
          const xml = await file.text()
          const document = new DOMParser().parseFromString(xml, 'application/xml')
          const geojson = toGeoJSON[fileName.endsWith('.gpx') ? 'gpx' : 'kml'](document)
          const parsedMovementTrack = fileName.endsWith('.gpx') ? extractMovementTrack(geojson) : null
          const movementTrack = parsedMovementTrack?.positions.length ? parsedMovementTrack : null
          const trackColorIndex = movementTracks.length + newLayers.filter((layer) => layer.movementTrack).length
          newLayers.push({
            id: `upload-${Date.now()}-${Math.random()}`,
            name: file.name.replace(/\.[^.]+$/, ''),
            type: 'geojson',
            enabled: true,
            color: trackColors[trackColorIndex % trackColors.length],
            geojson,
            movementTrack,
          })
          continue
        }

        if (fileName.endsWith('.kmz')) {
          const archive = await JSZip.loadAsync(await file.arrayBuffer())
          const kmlEntry = Object.values(archive.files).find((entry) => entry.name.toLowerCase().endsWith('.kml'))
          if (!kmlEntry) throw new Error('KMZ archive does not contain a KML file')
          const document = new DOMParser().parseFromString(await kmlEntry.async('text'), 'application/xml')
          newLayers.push(getUploadLayer(file.name, toGeoJSON.kml(document), '#34c759'))
          continue
        }

        if (fileName.endsWith('.zip')) {
          const parsed = await shp(await file.arrayBuffer())
          const geojson = Array.isArray(parsed)
            ? { type: 'FeatureCollection', features: parsed.flatMap((item) => item.features || []) }
            : parsed
          newLayers.push(getUploadLayer(file.name, geojson, '#f59e0b'))
          continue
        }

        if (fileName.endsWith('.shp')) {
          const baseName = fileName.slice(0, fileName.lastIndexOf('.'))
          const group = shapefileGroups.get(baseName)
          const parsed = await shp({
            shp: await group.shp.arrayBuffer(),
            ...(group.shx ? { shx: await group.shx.arrayBuffer() } : {}),
            ...(group.dbf ? { dbf: await group.dbf.arrayBuffer() } : {}),
            ...(group.prj ? { prj: await group.prj.arrayBuffer() } : {}),
          })
          const geojson = Array.isArray(parsed)
            ? { type: 'FeatureCollection', features: parsed.flatMap((item) => item.features || []) }
            : parsed
          newLayers.push(getUploadLayer(file.name, geojson, '#f59e0b'))
          continue
        }

        if (fileName.endsWith('.csv')) {
          const csvData = parseCsv(await file.text())
          const firstProperties = csvData.features[0]?.properties || {}
          const taxonClass = String(
            firstProperties.iconic_taxon_name
              || firstProperties.taxon_class_name
              || firstProperties.taxon_class
              || '',
          ).toLowerCase()
          const isPlantCsv = fileName.includes('plant') || taxonClass.includes('plantae')
          const isMammalCsv = !isPlantCsv && (fileName.includes('mammal') || taxonClass.includes('mammalia'))
          const isBirdCsv = !isPlantCsv && !isMammalCsv && (
            fileName.startsWith('observations-')
              || taxonClass.includes('aves')
              || ['common_name', 'scientific_name', 'taxon_name', 'species_guess'].some((key) => key in firstProperties)
          )
          const layer = getUploadLayer(
            file.name,
            csvData,
            isBirdCsv ? '#007aff' : isMammalCsv ? '#f59e0b' : isPlantCsv ? '#34c759' : '#ff9f0a',
          )
          if (isBirdCsv) {
            layer.name = 'iNaturalist bird observations'
            layer.isBirdLayer = true
          }
          if (isMammalCsv) {
            layer.name = 'iNaturalist mammal observations'
            layer.isMammalLayer = true
          }
          if (isPlantCsv) {
            layer.name = 'iNaturalist plant observations'
            layer.isPlantLayer = true
          }
          newLayers.push(layer)
          continue
        }

        if (fileName.endsWith('.gpkg')) {
          const { GeoPackageAPI } = await loadGeoPackage()
          const geoPackage = await GeoPackageAPI.open(new Uint8Array(await file.arrayBuffer()))
          const features = geoPackage.getFeatureTables().flatMap((tableName) =>
            geoPackage.queryForGeoJSONFeaturesInTable(tableName),
          )
          geoPackage.close()
          newLayers.push(getUploadLayer(file.name, { type: 'FeatureCollection', features }, '#af52de'))
          continue
        }

        if (fileName.endsWith('.tif') || fileName.endsWith('.tiff')) {
          const { fromArrayBuffer } = await import('geotiff')
          const tiff = await fromArrayBuffer(await file.arrayBuffer())
          const image = await tiff.getImage()
          const bbox = image.getBoundingBox()
          newLayers.push({
            id: `upload-${Date.now()}-${Math.random()}`,
            name: file.name.replace(/\.[^.]+$/, ''),
            type: 'raster',
            enabled: true,
            metadata: {
              bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
              width: image.getWidth(),
              height: image.getHeight(),
              samples: image.getSamplesPerPixel(),
            },
          })
        }
      } catch (error) {
        console.error(`Failed to parse ${file.name}`, error)
        setUploadNotice(`Could not read ${file.name}. Please check the file type or format.`)
      }
    }

    if (newLayers.length > 0) {
      const colorizedLayers = assignUniqueUploadColors(newLayers, uploadedLayers)
      const newBirdLayer = colorizedLayers.find((layer) => layer.isBirdLayer)
      const newMammalLayer = colorizedLayers.find((layer) => layer.isMammalLayer)
      const newPlantLayer = colorizedLayers.find((layer) => layer.isPlantLayer)
      const newUploadedLayers = colorizedLayers.filter((layer) => !layer.isBirdLayer && !layer.isMammalLayer && !layer.isPlantLayer)
      if (newBirdLayer) {
        setBirdLayer(newBirdLayer)
        setSelectedBirdSpecies([])
      }
      if (newMammalLayer) {
        setMammalLayer(newMammalLayer)
        setSelectedMammalSpecies([])
      }
      if (newPlantLayer) {
        setPlantLayer(newPlantLayer)
        setSelectedPlantSpecies([])
      }
      if (newUploadedLayers.length > 0) {
        setUploadedLayers((current) => [...current, ...newUploadedLayers])
      }
      const observationCount = newBirdLayer?.geojson.features.length
        || newMammalLayer?.geojson.features.length
        || newPlantLayer?.geojson.features.length
      const observationType = newPlantLayer ? 'plant' : newMammalLayer ? 'mammal' : 'bird'
      setUploadNotice(observationCount
        ? `Loaded ${observationCount} ${observationType} observation${observationCount > 1 ? 's' : ''}.`
        : `Loaded ${newLayers.length} GIS layer${newLayers.length > 1 ? 's' : ''}.`)
    }

    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  return (
    <div className={['app-shell', isDarkMode ? 'dark-mode' : '', isSidebarCollapsed ? 'sidebar-collapsed' : ''].filter(Boolean).join(' ')}>
      <aside className={isSidebarCollapsed ? 'sidebar sidebar-collapsed' : 'sidebar'}>
        <button
          type="button"
          className="sidebar-collapse-button"
          aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isSidebarCollapsed}
          onClick={() => setIsSidebarCollapsed((value) => !value)}
        >
          {isSidebarCollapsed ? '›' : '‹'}
        </button>
        <div className="brand-section">
          <h1>Changthang GIS</h1>
        </div>

        <div className="sidebar-actions">
          <button
            type="button"
            className="theme-button"
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={isDarkMode}
            onClick={() => setIsDarkMode((value) => !value)}
          >
            {isDarkMode ? '☀' : '☾'}
          </button>

          <button
            type="button"
            className="reset-button sidebar-reset-button"
            aria-label="Reset map view"
            title="Reset map view"
            onClick={() => setResetKey((value) => value + 1)}
          >
            ↺
          </button>
        </div>

        <div className="panel-block upload-panel">
          <h2>Upload GIS data</h2>
          <label className="upload-button" htmlFor="gis-upload">
            Upload files
          </label>
          <p className="supported-formats">
            Supported: GeoJSON, GPX, KML/KMZ, Shapefile parts, GeoTIFF, GeoPackage, CSV
          </p>
          <input
            id="gis-upload"
            ref={inputRef}
            type="file"
            multiple
            accept=".geojson,.json,.gpx,.kml,.kmz,.zip,.shp,.shx,.dbf,.prj,.tif,.tiff,.gpkg,.csv"
            onChange={handleFeatureUpload}
          />
          {uploadNotice && <p className="upload-notice">{uploadNotice}</p>}
        </div>

        <div className="panel-block">
          <h2>Basemaps</h2>
          <div className="button-grid">
            {basemaps.map((basemap) => (
              <button
                key={basemap.id}
                type="button"
                className={basemapId === basemap.id ? 'option-button active' : 'option-button'}
                title={basemap.label}
                aria-label={`Use ${basemap.label} basemap`}
                onClick={() => setBasemapId(basemap.id)}
              >
                <span
                  className="basemap-thumbnail"
                  style={{ backgroundImage: `url(${basemap.thumbnail})` }}
                  aria-hidden="true"
                />
                <span className="sr-only">{basemap.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="panel-block">
          <h2>Layer visibility</h2>
          <ul className="layer-list">
            {layerCatalog.map((layer) => (
              <li key={layer.id}>
                <LayerSwitch
                  label={layer.label}
                  enabled={layers[layer.id]}
                  color={layer.color}
                  onChange={() => toggleLayer(layer.id)}
                />
                {layer.id === 'birds' && birdLayer && (
                  <SpeciesFilter
                    layer={birdLayer}
                    selectedSpecies={selectedBirdSpecies}
                    label="Bird"
                    onToggle={(name) => setSelectedBirdSpecies((current) => current.includes(name)
                      ? current.filter((selected) => selected !== name)
                      : [...current, name])}
                  />
                )}
                {layer.id === 'mammals' && mammalLayer && (
                  <SpeciesFilter
                    layer={mammalLayer}
                    selectedSpecies={selectedMammalSpecies}
                    label="Mammal"
                    onToggle={(name) => setSelectedMammalSpecies((current) => current.includes(name)
                      ? current.filter((selected) => selected !== name)
                      : [...current, name])}
                  />
                )}
                {layer.id === 'plants' && plantLayer && (
                  <SpeciesFilter
                    layer={plantLayer}
                    selectedSpecies={selectedPlantSpecies}
                    label="Plant"
                    onToggle={(name) => setSelectedPlantSpecies((current) => current.includes(name)
                      ? current.filter((selected) => selected !== name)
                      : [...current, name])}
                  />
                )}
              </li>
            ))}
              {uploadedLayers.map((layer) => (
                <li key={layer.id}>
                  <LayerSwitch
                    label={layer.name}
                    enabled={layer.enabled}
                    color={layer.color}
                    onChange={() => toggleUploadedLayer(layer.id)}
                  />
                </li>
              ))}
            </ul>
          </div>

        <div className="panel-block weather-panel">
          <div className="weather-heading">
            <div>
              <div className="section-kicker">Changthang · 33.35°N, 78.28°E</div>
              <h2>Weather</h2>
            </div>
            {weatherForecast?.current?.time && (
              <span className="weather-updated">{formatWeatherDate(weatherForecast.current.time.slice(0, 10))}</span>
            )}
          </div>

          {weatherLoading && <p className="weather-status">Loading current weather...</p>}
          {weatherError && <p className="weather-status weather-error">{weatherError}</p>}
          {weatherForecast?.current && (
            <div className="weather-current">
              <div className="weather-current-main">
                <strong>{formatWeatherValue(weatherForecast.current.temperature_2m, '°')}</strong>
                <span>{getWeatherLabel(weatherForecast.current.weather_code)}</span>
              </div>
              <div className="weather-metrics">
                <span>Feels {formatWeatherValue(weatherForecast.current.apparent_temperature, '°')}</span>
                <span>Wind {formatWeatherValue(weatherForecast.current.wind_speed_10m, ' km/h')}</span>
                <span>Rain {formatWeatherValue(weatherForecast.current.precipitation, ' mm')}</span>
              </div>
            </div>
          )}

          <h3 className="weather-section-title">7-day forecast</h3>
          {weatherForecast?.daily && (
            <div className="weather-days">
              {weatherForecast.daily.time.map((date, index) => (
                <div className="weather-day" key={date}>
                  <strong>{index === 0 ? 'Today' : formatWeatherDate(date, { weekday: 'short' })}</strong>
                  <span>{getWeatherLabel(weatherForecast.daily.weather_code[index])}</span>
                  <b>
                    {formatWeatherValue(weatherForecast.daily.temperature_2m_max[index], '°')}
                    {' / '}
                    {formatWeatherValue(weatherForecast.daily.temperature_2m_min[index], '°')}
                  </b>
                  <small>{formatWeatherValue(weatherForecast.daily.precipitation_sum[index], ' mm')}</small>
                </div>
              ))}
            </div>
          )}

          <h3 className="weather-section-title">Historical weather</h3>
          <div className="weather-date-controls">
            <label>
              From
              <input
                type="date"
                value={historicalStart}
                max={historicalEnd || yesterday}
                onChange={(event) => setHistoricalStart(event.target.value)}
              />
            </label>
            <label>
              To
              <input
                type="date"
                value={historicalEnd}
                max={yesterday}
                onChange={(event) => setHistoricalEnd(event.target.value)}
              />
            </label>
          </div>
          {historyLoading && <p className="weather-status">Loading historical weather...</p>}
          {historyError && <p className="weather-status weather-error">{historyError}</p>}
          {weatherHistory?.daily && (
            <div className="weather-history">
              {weatherHistory.daily.time.map((date, index) => (
                <div className="weather-history-row" key={date}>
                  <strong>{formatWeatherDate(date)}</strong>
                  <span>{getWeatherLabel(weatherHistory.daily.weather_code[index])}</span>
                  <b>{formatWeatherValue(weatherHistory.daily.temperature_2m_mean[index], '°')}</b>
                  <small>{formatWeatherValue(weatherHistory.daily.precipitation_sum[index], ' mm')}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="timeline-panel sidebar-timeline">
          <div className="timeline-header">
            <div>
              <div className="section-kicker">Temporal view</div>
              <h3>Movement timeline</h3>
            </div>
            <div className="timeline-controls">
              <button
                type="button"
                disabled={movementTracks.length === 0}
                onClick={() => setIsPlaying((value) => !value)}
              >
                {isPlaying ? 'Pause' : 'Play'}
              </button>
            </div>
          </div>

          <div className="timeline-options">
            <span className="track-count">{movementTracks.length ? `${movementTracks.length} GPX tracks` : 'Upload GPX files'}</span>
            <label htmlFor="playback-speed">Speed</label>
            <select
              id="playback-speed"
              value={playbackSpeed}
              onChange={(event) => setPlaybackSpeed(Number(event.target.value))}
            >
              <option value="0.1">0.1x</option>
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1">1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
              <option value="8">8x</option>
            </select>
          </div>

          <div className="range-block">
            <label htmlFor="track-range">Timeline scrubber</label>
            <input
              id="track-range"
              type="range"
              min="0"
              max="100"
              value={Math.round(trackProgress * 100)}
              onChange={(event) => {
                setTrackProgress(Number(event.target.value) / 100)
                setIsPlaying(false)
              }}
              disabled={movementTracks.length === 0}
            />
          </div>

          <div className="timeline-labels">
            <span>{movementTracks.length ? 'Start' : 'Awaiting'}</span>
            <strong>{movementTracks.length ? 'All tracks' : 'Upload GPX tracks'}</strong>
            <span>{movementTracks.length ? 'End' : 'upload'}</span>
          </div>

          <div className="track-legend" aria-label="GPS track legend">
            {movementTracks.length === 0 && (
              <span className="track-legend-empty">No GPS tracks loaded</span>
            )}
            {movementTracks.map((layer) => {
              const pointIndex = Math.floor(
                trackProgress * (layer.movementTrack.positions.length - 1),
              )

              return (
                <div className="track-legend-row" key={layer.id}>
                  <span
                    className="track-legend-swatch"
                    style={{ backgroundColor: layer.color }}
                    aria-hidden="true"
                  />
                  <span className="track-legend-name">{layer.name}</span>
                  <time className="track-legend-time">
                    {formatTrackTime(layer.movementTrack.timestamps[pointIndex])}
                  </time>
                </div>
              )
            })}
          </div>
        </div>

      </aside>

      <main className="map-panel">
        <div className="map-wrap">
          {isSidebarCollapsed && (
            <button
              type="button"
              className="map-sidebar-toggle"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              aria-expanded="false"
              onClick={() => setIsSidebarCollapsed(false)}
            >
              ☰
            </button>
          )}
          <MapPanel
            basemapId={basemapId}
            layerState={layers}
            resetKey={resetKey}
            sidebarCollapsed={isSidebarCollapsed}
            uploadedLayers={uploadedLayers}
            birdLayer={birdLayer}
            selectedBirdSpecies={selectedBirdSpecies}
            mammalLayer={mammalLayer}
            selectedMammalSpecies={selectedMammalSpecies}
            plantLayer={plantLayer}
            selectedPlantSpecies={selectedPlantSpecies}
            movementTracks={movementTracks}
            trackProgress={trackProgress}
          />
        </div>
      </main>
    </div>
  )
}

export default App
