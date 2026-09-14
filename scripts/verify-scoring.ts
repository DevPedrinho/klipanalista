/**
 * Verificacao do motor de score contra o dataset simulado.
 *
 * Executa com: npm run verify:scoring
 * Nao substitui testes automatizados: serve para inspecionar, caso a caso,
 * se as regras de score e de desqualificacao estao se comportando.
 */
import {
  MOCK_CONVERSATIONS,
  MOCK_PANELS,
  findCardBySession,
  findContact,
  previousConversationCount,
} from "../src/mocks/dataset";
import { buildOpportunity } from "../src/server/services/opportunity.service";
import { computeScore } from "../src/server/scoring/score";
import { defaultSettings } from "../src/server/services/automation.service";

const settings = defaultSettings("acc_klipflowi_demo");
const now = new Date();

const EXPECTED: Record<string, string> = {
  sess_001: "ALTA/CRITICA - orcamento aprovado + prazo + sem retorno",
  sess_002: "ALTA/CRITICA - proposta enviada, cliente parou de responder",
  sess_003: "MEDIA/ALTA - desconto + objecao de preco",
  sess_004: "MEDIA/ALTA - recompra de cliente recorrente",
  sess_005: "DESQUALIFICADA - suporte puro",
  sess_006: "ABAIXO DO CORTE - palavra isolada sem contexto",
  sess_007: "DESQUALIFICADA - compra ja concluida",
  sess_008: "ALTA/CRITICA - troca de fornecedor + urgencia + sem resposta",
};

let failures = 0;

for (const conversation of MOCK_CONVERSATIONS) {
  const contact = findContact(conversation.contactId);
  const card = findCardBySession(conversation.id);

  const score = computeScore(
    {
      conversation,
      existingCard: card,
      previousConversationCount: previousConversationCount(conversation.contactId, conversation.id),
      now,
    },
    {
      hasName: Boolean(contact?.name),
      hasPhone: Boolean(contact?.phone),
      hasCompany: Boolean(contact?.company),
      hasEmail: Boolean(contact?.email),
      hasAgent: Boolean(conversation.agentId),
    },
  );

  const opportunity = buildOpportunity({
    conversation,
    contact,
    existingCard: card,
    previousConversationCount: previousConversationCount(conversation.contactId, conversation.id),
    panels: MOCK_PANELS,
    settings,
    now,
  });

  console.log("=".repeat(78));
  console.log(`${conversation.id}  ${contact?.name ?? "sem contato"}`);
  console.log(`  esperado : ${EXPECTED[conversation.id] ?? "-"}`);
  console.log(
    `  obtido   : score=${score.score} confianca=${score.confidence} ` +
      `prioridade=${score.priority} exibida=${opportunity ? "SIM" : "NAO"}`,
  );
  console.log(
    `  sinais + : ${score.signals.map((s) => s.code).join(", ") || "(nenhum)"}`,
  );
  console.log(
    `  sinais - : ${score.disqualifiers.map((s) => s.code).join(", ") || "(nenhum)"}`,
  );

  if (opportunity) {
    console.log(`  etiquetas: ${opportunity.recommendedTagKeys.join(", ") || "(nenhuma)"}`);
    console.log(`  etapa rec: ${opportunity.recommendedStepName ?? "-"}`);
    console.log(`  valor    : ${opportunity.estimatedValue ?? "-"}${opportunity.estimatedValueIsInferred ? " (inferido)" : ""}`);
    console.log(`  proxima  : ${opportunity.nextAction}`);
    console.log(`  objecoes : ${opportunity.objections.join(", ") || "(nenhuma)"}`);
  }

  // Verificacoes de regressao das regras criticas do produto.
  const mustBeHidden = ["sess_005", "sess_006", "sess_007"];
  const mustBeShown = ["sess_001", "sess_002", "sess_003", "sess_004", "sess_008"];

  if (mustBeHidden.includes(conversation.id) && opportunity) {
    console.log(`  >>> FALHA: ${conversation.id} deveria ficar abaixo do corte.`);
    failures += 1;
  }
  if (mustBeShown.includes(conversation.id) && !opportunity) {
    console.log(`  >>> FALHA: ${conversation.id} deveria aparecer como oportunidade.`);
    failures += 1;
  }
}

console.log("=".repeat(78));
console.log(failures === 0 ? "OK: todas as regras criticas passaram." : `FALHAS: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
