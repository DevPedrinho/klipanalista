import { NextResponse } from "next/server";
import { KlipflowiError } from "./klipflowi/client";

/** Erro em JSON, com o corpo da KlipFlowi por inteiro (ele diz qual campo faltou). */
export function erroJson(e: unknown) {
  if (e instanceof KlipflowiError) {
    return NextResponse.json({ erro: e.message, detalhe: e.corpo }, { status: 502 });
  }
  return NextResponse.json({ erro: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
