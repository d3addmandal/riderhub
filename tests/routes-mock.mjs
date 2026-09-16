// Mocks Google Routes v2: echoes the travel mode and modifiers so the profile plumbing
// can be asserted, and returns two ways round when alternatives are asked for.
import { createServer } from 'node:http';
createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const p = JSON.parse(body || '{}');
    const hops = 1 + (p.intermediates ?? []).length;
    const mk = (secs, dist, desc, poly) => ({
      duration: `${secs}s`, distanceMeters: dist,
      description: desc, routeLabels: ['DEFAULT_ROUTE'],
      polyline: { encodedPolyline: poly },
      // One leg per hop, the way the real API splits a route with stops.
      legs: Array.from({ length: hops }, () => ({
        distanceMeters: Math.round(dist / hops), duration: `${Math.round(secs / hops)}s`,
        polyline: { encodedPolyline: poly },
        steps: [{
          navigationInstruction: { instructions: 'Head north on <b>NH48</b>', maneuver: 'DEPART' },
          distanceMeters: 100, staticDuration: '20s',
          endLocation: { latLng: { latitude: 18.58, longitude: 73.80 } },
        }],
      })),
    });
    // Two polylines, both decodable.
    const A = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const routes = [mk(3600, 65000, 'NH 48', A)];
    if (p.computeAlternativeRoutes) {
      // Deliberately out of order, so the server's "fastest first" sort is proven.
      routes.unshift(mk(4500, 58000, 'Old Mumbai Highway', A));
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Echo-TravelMode': p.travelMode ?? '',
      'X-Echo-Alternatives': String(Boolean(p.computeAlternativeRoutes)),
      'X-Echo-AvoidTolls': String(Boolean(p.routeModifiers?.avoidTolls)),
      'X-Echo-Intermediates': String((p.intermediates ?? []).length),
    });
    res.end(JSON.stringify({ routes }));
  });
}).listen(8897, () => console.log('routes mock :8897'));
