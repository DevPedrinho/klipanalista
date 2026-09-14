import type { NextConfig } from "next";

/**
 * O modulo e incorporado dentro da KlipFlowi como pagina de menu personalizado
 * e como popup de acao. Por isso precisamos permitir enquadramento (framing)
 * apenas pelas origens declaradas em FLW_EMBED_ORIGINS.
 */
const embedOrigins = (process.env.FLW_EMBED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const frameAncestors =
  embedOrigins.length > 0 ? `'self' ${embedOrigins.join(" ")}` : "'self'";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${frameAncestors};`,
          },
        ],
      },
      {
        // Respostas de API nunca devem ser cacheadas por intermediarios:
        // carregam dados de um tenant especifico.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
