import { createSecurityHandle } from 'specra/middleware/security';
import { sequence } from '@sveltejs/kit/hooks';

const cspHeader = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://code.iconify.design",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "frame-src 'self' https://www.youtube.com",
  "connect-src 'self' https://api.iconify.design",
].join('; ');

export const handle = sequence(
  createSecurityHandle({
    strictPathValidation: true,
    customCSP: cspHeader,
  })
);
