/**
 * Mascaramento de dados sensiveis.
 *
 * Regra do modulo: telefones, e-mails e documentos NUNCA saem do servidor
 * em formato completo, e NUNCA entram em log.
 */

/**
 * Mascara um telefone preservando o DDD e os dois ultimos digitos.
 *   5511987654321 -> (11) *********21
 *   11987654321   -> (11) *********21
 *
 * O codigo de pais do Brasil (55) e descartado antes de escolher o DDD:
 * sem isso, "55" seria exibido como se fosse o DDD.
 */
export function maskPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "***";

  // Numero brasileiro com codigo de pais: 55 + DDD (2) + numero (8 ou 9).
  if (digits.length >= 12 && digits.startsWith("55")) {
    digits = digits.slice(2);
  }

  const ddd = digits.slice(0, 2);
  const last2 = digits.slice(-2);
  const middleLength = Math.max(0, digits.length - 4);
  return `(${ddd}) ${"*".repeat(middleLength)}${last2}`;
}

/** jo***@empresa.com */
export function maskEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "***";

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(2, local.length - 2))}${domain}`;
}

/** Mascara CPF/CNPJ preservando apenas os dois ultimos digitos. */
export function maskDocument(doc?: string | null): string | undefined {
  if (!doc) return undefined;
  const digits = doc.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${"*".repeat(digits.length - 2)}${digits.slice(-2)}`;
}

const SENSITIVE_KEYS =
  /^(phone|phonenumber|telefone|celular|whatsapp|email|e_mail|mail|document|cpf|cnpj|token|authorization|password|secret|apikey|api_key)$/i;

/**
 * Percorre um objeto recursivamente mascarando chaves sensiveis.
 * Usado antes de gravar payloads de webhook e antes de qualquer log.
 */
export function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[profundidade maxima]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => maskDeep(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!SENSITIVE_KEYS.test(key)) {
        out[key] = maskDeep(raw, depth + 1);
        continue;
      }

      if (typeof raw !== "string") {
        out[key] = "[mascarado]";
        continue;
      }

      if (/token|authorization|password|secret|apikey|api_key/i.test(key)) {
        out[key] = "[mascarado]";
      } else if (/email|mail/i.test(key)) {
        out[key] = maskEmail(raw) ?? "[mascarado]";
      } else if (/document|cpf|cnpj/i.test(key)) {
        out[key] = maskDocument(raw) ?? "[mascarado]";
      } else {
        out[key] = maskPhone(raw) ?? "[mascarado]";
      }
    }
    return out;
  }

  return value;
}

/** Remove qualquer token que tenha vazado para uma string de erro. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [mascarado]")
    .replace(/\bpn_[A-Za-z0-9]+/g, "pn_[mascarado]");
}
