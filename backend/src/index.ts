// Local development server. In production the same app runs as a Cloud Function —
// see function.ts — and nothing here executes.
import { app } from './app';

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`RiderHub API running on port ${PORT}`);
});
