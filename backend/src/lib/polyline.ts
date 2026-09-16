/**
 * Decoder for Google's Encoded Polyline Algorithm.
 *
 * The Routes API returns route geometry as an encoded string. Decoding it here keeps the
 * `{ geometry: [[lng, lat], …] }` contract the frontend already consumes, so the map layer
 * does not need Google's geometry library just to draw a line.
 *
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    // Each coordinate is a zig-zag encoded delta, five bits per character.
    let result = 0, shift = 0, byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0; shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    // Stored as [lng, lat] to match GeoJSON ordering.
    points.push([lng / 1e5, lat / 1e5]);
  }

  return points;
}
