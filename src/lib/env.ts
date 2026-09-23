import "server-only";
import { z } from "zod";

const obrigatoria = (nome: string) => z.string({ error: `${nome} não configurada` }).min(1, `${nome} não configurada`);

const schema = z.object({
  FLW_API_TOKEN: obrigatoria("FLW_API_TOKEN"),
  FLW_API_URL: z.url().default("https://api.wts.chat"),
  FLW_ACCOUNT_ID: z.string().optional(),
  SUPABASE_URL: obrigatoria("SUPABASE_URL").pipe(z.url("SUPABASE_URL inválida")),
  SUPABASE_SERVICE_ROLE_KEY: obrigatoria("SUPABASE_SERVICE_ROLE_KEY"),
  SYNC_JANELA_DIAS: z.coerce.number().int().positive().default(7),
  RETENCAO_DIAS: z.coerce.number().int().positive().optional(),
  CRON_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cache: Env | undefined;

/** Lê as variáveis de ambiente do servidor. Lança erro legível se faltar alguma. */
export function env(): Env {
  if (cache) return cache;
  const vazioViraUndefined = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const resultado = schema.safeParse(vazioViraUndefined);
  if (!resultado.success) {
    const faltando = resultado.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Configuração incompleta: ${faltando}`);
  }
  cache = resultado.data;
  return cache;
}
