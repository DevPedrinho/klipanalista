import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * eslint-config-next 16 já exporta flat config.
 * Não usar FlatCompat aqui: o shim de eslintrc quebra ao normalizar
 * as referências circulares de plugin desta versão.
 */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "scripts/stubs/**"],
  },
];

export default eslintConfig;
