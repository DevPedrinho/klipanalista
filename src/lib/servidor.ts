import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "./env";
import { criarCliente } from "./klipflowi/client";
import { klipflowiApi } from "./klipflowi/api";

/** Supabase com service role, no schema `klip`. Só roda no servidor. */
export function db() {
  const e = env();
  return createClient(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: "klip" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Db = ReturnType<typeof db>;

export function api() {
  const e = env();
  return klipflowiApi(criarCliente({ baseUrl: e.FLW_API_URL, token: e.FLW_API_TOKEN }));
}
