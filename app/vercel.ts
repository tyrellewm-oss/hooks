// Vercel function entry: hands each request to the site's one listener in app/server.ts, which is read-only when
// hosted (no keys loaded, GET routes only). scripts/vercel_build.ts bundles this; web/dist is served as static files.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { server } from './server.js';
export default (req: IncomingMessage, res: ServerResponse) => { server.emit('request', req, res); };
