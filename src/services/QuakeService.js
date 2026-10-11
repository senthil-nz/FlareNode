/**
 * QuakeService fetches recent New Zealand earthquakes from GeoNet.
 * Free public feed, no API key: https://api.geonet.org.nz/
 */
const REQUEST_TIMEOUT_MS = 10000;

export const QuakeService = {
  // Quakes of intensity MMI 3 ("weak", felt indoors) and above, most recent first
  API_URL: 'https://api.geonet.org.nz/quake?MMI=3',

  /** Returns a compact list of quakes, or null when the feed cannot be reached. */
  async fetchRecentQuakes() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(this.API_URL, {
        headers: { Accept: 'application/vnd.geo+json;version=2' },
        signal: controller.signal,
      });
      if (!response.ok) return null;

      const data = await response.json();
      if (!Array.isArray(data?.features)) return null;

      return data.features
        // GeoNet marks retracted detections as "deleted"
        .filter((feature) => feature.properties?.quality !== 'deleted' && feature.geometry?.coordinates)
        .map((feature) => ({
          id: feature.properties.publicID,
          longitude: feature.geometry.coordinates[0],
          latitude: feature.geometry.coordinates[1],
          magnitude: Math.round(feature.properties.magnitude * 10) / 10,
          depth: Math.round(feature.properties.depth),
          locality: feature.properties.locality,
          time: Date.parse(feature.properties.time),
        }));
    } catch (error) {
      // Expected in the field: no internet, the mesh copy is used instead
      console.log('Quake feed unavailable:', error?.message || error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};
