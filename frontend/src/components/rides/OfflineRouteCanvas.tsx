import { useEffect, useRef } from 'react';
import { RouteResult } from '../../lib/routeTypes';
import { RideStop, Poi } from '../../types';
import { stopMeta } from '../../lib/stopKinds';

/**
 * The route, drawn from cached data, when there is no network for map tiles.
 *
 * Google's terms do not permit downloading or storing their tile imagery, so an offline
 * street map is off the table. What this draws instead is everything we are allowed to
 * keep: the road's own shape, the stops, the pumps found earlier, and — the part that
 * matters — where the rider is on it right now, straight from GPS. It is a moving-map
 * display rather than a street map, and it keeps working with the phone in flight mode.
 */
export default function OfflineRouteCanvas({
  route, stops, pois, pos, heading, followZoom = 1,
}: {
  route: RouteResult | null;
  stops: RideStop[];
  pois?: Poi[];
  pos: { lat: number; lng: number } | null;
  heading?: number | null;
  /** 1 = whole route framed; higher zooms in around the rider. */
  followZoom?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Match the backing store to the device so the line is not soft on a phone.
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const line = route?.geometry ?? [];
    const marks: { lat: number; lng: number }[] = [
      ...line.map(([lng, lat]) => ({ lat, lng })),
      ...stops.filter(s => s.lat != null).map(s => ({ lat: s.lat!, lng: s.lng! })),
      ...(pos ? [pos] : []),
    ];

    if (!marks.length) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No cached route to show', w / 2, h / 2);
      return;
    }

    // Frame everything, then optionally tighten around the rider.
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const m of marks) {
      minLat = Math.min(minLat, m.lat); maxLat = Math.max(maxLat, m.lat);
      minLng = Math.min(minLng, m.lng); maxLng = Math.max(maxLng, m.lng);
    }

    if (followZoom >1 && pos) {
      const spanLat = (maxLat - minLat) / followZoom;
      const spanLng = (maxLng - minLng) / followZoom;
      minLat = pos.lat - spanLat / 2; maxLat = pos.lat + spanLat / 2;
      minLng = pos.lng - spanLng / 2; maxLng = pos.lng + spanLng / 2;
    }

    // Keep the aspect honest so the road does not look stretched. Longitude degrees are
    // shorter than latitude ones away from the equator, hence the cosine.
    const midLat = (minLat + maxLat) / 2;
    const lngScale = Math.cos(midLat * Math.PI / 180) || 1;
    let spanLat = Math.max(maxLat - minLat, 1e-4);
    let spanLng = Math.max((maxLng - minLng) * lngScale, 1e-4);

    const pad = 28;
    const scale = Math.min((w - pad * 2) / spanLng, (h - pad * 2) / spanLat);
    const cx = (minLng + maxLng) / 2, cy = (minLat + maxLat) / 2;

    const project = (lat: number, lng: number) => ({
      x: w / 2 + (lng - cx) * lngScale * scale,
      y: h / 2 - (lat - cy) * scale,
    });

    // Route: a dark casing under a bright core, the way a real map draws a highway.
    if (line.length >1) {
      const draw = (width: number, colour: string) => {
        ctx.beginPath();
        line.forEach(([lng, lat], i) => {
          const p = project(lat, lng);
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
        });
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      };
      draw(9, '#0b0d12');
      draw(5, '#f97316');
    }

    // Pumps and the like, small and unobtrusive.
    for (const p of pois ?? []) {
      const pt = project(p.lat, p.lng);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
    }

    // Stops, numbered exactly as they are on the live map and in the list.
    stops.forEach((s, i) => {
      if (s.lat == null || s.lng == null) return;
      const pt = project(s.lat, s.lng);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = s.reached_at ? '#22c55e' : '#1a1d27';
      ctx.fill();
      ctx.strokeStyle = s.reached_at ? '#22c55e' : '#f97316';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.reached_at ? '' : String(i + 1), pt.x, pt.y);

      const label = `${stopMeta(s.kind).icon} ${s.name}`;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(pt.x - tw / 2 - 3, pt.y + 13, tw + 6, 14);
      ctx.fillStyle = '#e5e7eb';
      ctx.fillText(label, pt.x, pt.y + 15);
    });

    // The rider: a heading arrow when we have one, a dot when we do not.
    if (pos) {
      const pt = project(pos.lat, pos.lng);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      if (heading != null) {
        ctx.rotate((heading * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(0, -11);
        ctx.lineTo(7.5, 9);
        ctx.lineTo(0, 4.5);
        ctx.lineTo(-7.5, 9);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, 7, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#f97316';
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }
  }, [route, stops, pois, pos?.lat, pos?.lng, heading, followZoom]);

  return (
    <div className="absolute inset-0 bg-[#0b0d12]">
      <canvas ref={canvasRef} className="w-full h-full" />
      <div className="absolute top-1/2 left-0 right-0 -translate-y-1/2 pointer-events-none flex justify-center">
        {!route?.geometry?.length && (
          <p className="text-muted text-xs px-6 text-center">No route saved for offline use. Save the ride for offline before you set off.
          </p>
        )}
      </div>
    </div>
  );
}
