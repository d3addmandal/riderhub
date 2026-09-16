// Mocks Google Places (New): autocomplete, details (essentials), nearby, and the rich
// detail + photo media used by the place card.
import { createServer } from 'node:http';
createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const mask = req.headers['x-goog-fieldmask'] ?? '';

    if (url.pathname.endsWith('/places:autocomplete')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ suggestions: [{ placePrediction: {
        placeId: 'ChIJ_lonavala', text: { text: 'Lonavala' },
        structuredFormat: { mainText: { text: 'Lonavala' }, secondaryText: { text: 'MH, India' } } } }] }));
    }

    if (url.pathname.endsWith('/places:searchNearby')) {
      const p = JSON.parse(body || '{}');
      const c = p.locationRestriction?.circle?.center ?? { latitude: 0, longitude: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ places: [{
        id: 'place_pump', displayName: { text: 'HP Petrol Pump' },
        formattedAddress: 'NH48, Maharashtra',
        location: { latitude: c.latitude + 0.002, longitude: c.longitude + 0.002 },
        rating: 4.2, currentOpeningHours: { openNow: true },
      }] }));
    }

    // Photo media — return a tiny PNG so the proxy path can be exercised.
    if (url.pathname.endsWith('/media')) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }

    // Place details. The rich card asks for reviews/photos; the cheap one does not.
    if (url.pathname.startsWith('/v1/places/')) {
      const rich = String(mask).includes('reviews');
      const base = {
        id: 'place_pump', displayName: { text: 'HP Petrol Pump' },
        formattedAddress: 'NH48, Lonavala, Maharashtra 410401, India',
        location: { latitude: 18.7546, longitude: 73.4062 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo-FieldMask': String(mask) });
      if (!rich) return res.end(JSON.stringify(base));
      return res.end(JSON.stringify({
        ...base,
        types: ['gas_station'],
        rating: 4.3, userRatingCount: 1287, priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
        currentOpeningHours: { openNow: true, weekdayDescriptions: [
          'Monday: Open 24 hours', 'Tuesday: Open 24 hours', 'Wednesday: Open 24 hours',
          'Thursday: Open 24 hours', 'Friday: Open 24 hours', 'Saturday: Open 24 hours',
          'Sunday: Open 24 hours'] },
        nationalPhoneNumber: '020 1234 5678',
        websiteUri: 'https://www.hindustanpetroleum.com/outlet',
        googleMapsUri: 'https://maps.google.com/?cid=1234567890',
        editorialSummary: { text: 'Fuel stop with air and a small shop.' },
        photos: [{ name: 'places/place_pump/photos/AbCdEf123' }, { name: 'places/place_pump/photos/XyZ789' }],
        reviews: [
          { authorAttribution: { displayName: 'Amit K', photoUri: 'https://x/p.jpg' },
            rating: 5, text: { text: 'Clean toilets and air is free.' },
            relativePublishTimeDescription: '2 weeks ago' },
          { authorAttribution: { displayName: 'Priya S' }, rating: 3,
            originalText: { text: 'Queue on weekends.' }, relativePublishTimeDescription: 'a month ago' },
          { authorAttribution: { displayName: 'Empty' }, rating: 4, text: { text: '' } },
        ],
      }));
    }
    res.writeHead(404).end('{}');
  });
}).listen(8898, () => console.log('places mock :8898'));
