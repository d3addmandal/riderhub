// Local development server. In production the same app runs as a Cloud Function —
// see function.ts — and nothing here executes.
import { app } from './app';

const PORT = parseInt(process.env.PORT || '3001', 10);

/*
 * Localhost by default. In production Caddy is the only thing that should be able to
 * reach this process — it sits on a non-standard port behind the reverse proxy, and
 * binding it to every interface would publish an unencrypted copy of the API on that
 * port to anyone who finds it, whatever the firewall is doing.
 *
 * Set BIND_HOST=0.0.0.0 deliberately when you do want that, e.g. to open the dev server
 * to a phone on the same wifi.
 */
const HOST = process.env.BIND_HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`RiderHub API running on ${HOST}:${PORT}`);
});
