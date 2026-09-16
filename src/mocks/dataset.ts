import type {
  AppUser,
  ContactSnapshot,
  ConversationSnapshot,
  CrmCard,
  LossReason,
  MessageSnapshot,
  Panel,
  Tag,
  Team,
} from "@/domain/types";

/**
 * ===========================================================================
 * DATASET SIMULADO
 * ===========================================================================
 * Estes dados NAO vem da API KlipFlowi. Existem para que a interface, o motor
 * de score e o fluxo de aprovacao possam ser avaliados antes da integracao.
 *
 * As conversas foram escritas para exercitar os detectores de sinal de verdade:
 * ha casos de alta prioridade, casos limitrofes, desqualificacoes e um caso de
 * falso positivo proposital (palavra isolada sem contexto).
 *
 * Datas sao geradas relativas a "agora" para que a recencia sempre faca sentido.
 * ===========================================================================
 */

export const MOCK_ACCOUNT_ID = "acc_klipflowi_demo";

const NOW = Date.now();
const HOUR = 36e5;
const DAY = 24 * HOUR;

/** Instante relativo a agora, em ISO. */
function ago(days: number, hours = 0): string {
  return new Date(NOW - days * DAY - hours * HOUR).toISOString();
}

/* ==========================================================================
   Equipes e usuarios
   ========================================================================== */

export const MOCK_TEAMS: Team[] = [
  {
    id: "team_comercial_interno",
    accountId: MOCK_ACCOUNT_ID,
    name: "Comercial Interno",
    memberIds: ["user_ana", "user_bruno", "user_carla"],
  },
  {
    id: "team_campo",
    accountId: MOCK_ACCOUNT_ID,
    name: "Vendas Externas",
    memberIds: ["user_diego", "user_elaine"],
  },
];

export const MOCK_USERS: AppUser[] = [
  {
    id: "user_ana",
    accountId: MOCK_ACCOUNT_ID,
    name: "Ana Ribeiro",
    email: "ana.ribeiro@exemplo.com.br",
    role: "VENDEDOR",
    teamId: "team_comercial_interno",
    teamName: "Comercial Interno",
    active: true,
  },
  {
    id: "user_bruno",
    accountId: MOCK_ACCOUNT_ID,
    name: "Bruno Tavares",
    email: "bruno.tavares@exemplo.com.br",
    role: "VENDEDOR",
    teamId: "team_comercial_interno",
    teamName: "Comercial Interno",
    active: true,
  },
  {
    id: "user_carla",
    accountId: MOCK_ACCOUNT_ID,
    name: "Carla Monteiro",
    email: "carla.monteiro@exemplo.com.br",
    role: "GESTOR",
    teamId: "team_comercial_interno",
    teamName: "Comercial Interno",
    active: true,
  },
  {
    id: "user_diego",
    accountId: MOCK_ACCOUNT_ID,
    name: "Diego Farias",
    email: "diego.farias@exemplo.com.br",
    role: "VENDEDOR",
    teamId: "team_campo",
    teamName: "Vendas Externas",
    active: true,
  },
  {
    id: "user_elaine",
    accountId: MOCK_ACCOUNT_ID,
    name: "Elaine Souza",
    email: "elaine.souza@exemplo.com.br",
    role: "ADMIN",
    teamId: "team_campo",
    teamName: "Vendas Externas",
    active: true,
  },
];

/* ==========================================================================
   Etiquetas ja existentes na conta
   --------------------------------------------------------------------------
   Inclui propositalmente equivalentes das etiquetas da taxonomia da IA, para
   exercitar a regra de REUTILIZAR em vez de criar duplicadas.
   ========================================================================== */

export const MOCK_TAGS: Tag[] = [
  { id: "tag_001", accountId: MOCK_ACCOUNT_ID, name: "Cliente VIP", color: "PURPLE_600" },
  { id: "tag_002", accountId: MOCK_ACCOUNT_ID, name: "Oportunidade quente", color: "RED_600" },
  { id: "tag_003", accountId: MOCK_ACCOUNT_ID, name: "Follow-up", color: "BLUE_600" },
  { id: "tag_004", accountId: MOCK_ACCOUNT_ID, name: "Suporte", color: "GRAY_600" },
  { id: "tag_005", accountId: MOCK_ACCOUNT_ID, name: "Proposta enviada", color: "GREEN_600" },
  { id: "tag_006", accountId: MOCK_ACCOUNT_ID, name: "Revenda", color: "ORANGE_600" },
];

/* ==========================================================================
   Contatos
   ========================================================================== */

export const MOCK_CONTACTS: ContactSnapshot[] = [
  {
    id: "cont_001",
    accountId: MOCK_ACCOUNT_ID,
    name: "Marcelo Andrade",
    phone: "5511987654321",
    email: "marcelo@construtorahorizonte.com.br",
    company: "Construtora Horizonte",
    tagIds: ["tag_001"],
    createdAt: ago(210),
    updatedAt: ago(1),
  },
  {
    id: "cont_002",
    accountId: MOCK_ACCOUNT_ID,
    name: "Patricia Lemos",
    phone: "5531991234567",
    email: "patricia.lemos@nutrividaalimentos.com.br",
    company: "Nutrivida Alimentos",
    tagIds: [],
    createdAt: ago(96),
    updatedAt: ago(4),
  },
  {
    id: "cont_003",
    accountId: MOCK_ACCOUNT_ID,
    name: "Rogerio Pinto",
    phone: "5541988887777",
    company: "Metalurgica Pinto & Filhos",
    tagIds: ["tag_005"],
    createdAt: ago(430),
    updatedAt: ago(12),
  },
  {
    id: "cont_004",
    accountId: MOCK_ACCOUNT_ID,
    name: "Juliana Castro",
    phone: "5521997775555",
    email: "juliana@clinicavitacare.com.br",
    company: "Clinica Vitacare",
    tagIds: [],
    createdAt: ago(18),
    updatedAt: ago(2),
  },
  {
    id: "cont_005",
    accountId: MOCK_ACCOUNT_ID,
    name: "Fernando Dias",
    phone: "5548999112233",
    tagIds: ["tag_004"],
    createdAt: ago(64),
    updatedAt: ago(1),
  },
  {
    id: "cont_006",
    accountId: MOCK_ACCOUNT_ID,
    name: "Sandra Ferreira",
    phone: "5562988445566",
    email: "sandra@agrocentrogo.com.br",
    company: "AgroCentro GO",
    tagIds: ["tag_006"],
    createdAt: ago(520),
    updatedAt: ago(6),
  },
  {
    id: "cont_007",
    accountId: MOCK_ACCOUNT_ID,
    name: "Thiago Nogueira",
    phone: "5511955443322",
    tagIds: [],
    createdAt: ago(3),
    updatedAt: ago(3),
  },
  {
    id: "cont_008",
    accountId: MOCK_ACCOUNT_ID,
    name: "Renata Albuquerque",
    phone: "5585996663333",
    email: "renata@hotelmarazul.com.br",
    company: "Hotel Mar Azul",
    tagIds: [],
    createdAt: ago(140),
    updatedAt: ago(9),
  },
];

/* ==========================================================================
   Conversas
   ========================================================================== */

let messageSeq = 0;
function msg(
  sessionId: string,
  direction: "INBOUND" | "OUTBOUND",
  text: string,
  sentAt: string,
  authorName?: string,
): MessageSnapshot {
  messageSeq += 1;
  return {
    id: `msg_${String(messageSeq).padStart(4, "0")}`,
    sessionId,
    direction,
    text,
    sentAt,
    authorName,
  };
}

export const MOCK_CONVERSATIONS: ConversationSnapshot[] = [
  /* ---------------------------------------------------------------------
     1. ALTA PRIORIDADE — orcamento aprovado, prazo definido, sem retorno.
     --------------------------------------------------------------------- */
  {
    id: "sess_001",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_001",
    channel: "WHATSAPP",
    agentId: "user_ana",
    agentName: "Ana Ribeiro",
    status: "OPEN",
    startedAt: ago(6),
    lastMessageAt: ago(3, 4),
    messages: [
      msg("sess_001", "INBOUND", "Bom dia! Estou precisando comprar 400 metros de cabo flexivel 4mm para a obra do Tatuape. Voces trabalham com isso?", ago(6)),
      msg("sess_001", "OUTBOUND", "Bom dia, Marcelo! Trabalhamos sim. Vou levantar o valor para voce.", ago(6, -1), "Ana Ribeiro"),
      msg("sess_001", "INBOUND", "Perfeito. Preciso tambem saber o prazo de entrega, porque a equipe entra na obra dia 20. O orcamento ja foi aprovado pela diretoria, entao e so fechar.", ago(5, 20)),
      msg("sess_001", "OUTBOUND", "Otimo! Vou montar a proposta e te envio ainda hoje.", ago(5, 18), "Ana Ribeiro"),
      msg("sess_001", "INBOUND", "Combinado. Preciso fechar isso ate sexta, se der para agilizar eu agradeco. Qual a forma de pagamento de voces? Conseguimos faturar em 30 dias?", ago(3, 4)),
    ],
  },

  /* ---------------------------------------------------------------------
     2. ALTA PRIORIDADE — proposta enviada, cliente parou de responder.
     --------------------------------------------------------------------- */
  {
    id: "sess_002",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_003",
    channel: "WHATSAPP",
    agentId: "user_bruno",
    agentName: "Bruno Tavares",
    status: "OPEN",
    startedAt: ago(22),
    lastMessageAt: ago(12),
    messages: [
      msg("sess_002", "INBOUND", "Boa tarde, gostaria de um orcamento para 12 toneladas de chapa galvanizada, espessura 1,2mm. Segue em anexo a planilha com as especificacoes completas.", ago(22)),
      msg("sess_002", "OUTBOUND", "Boa tarde, Rogerio! Recebi a planilha, obrigado. Vou cotar com a fabrica e retorno.", ago(22, -2), "Bruno Tavares"),
      msg("sess_002", "OUTBOUND", "Rogerio, segue a proposta comercial em anexo. Valor total de R$ 96.400,00 com entrega em 18 dias uteis.", ago(15), "Bruno Tavares"),
      msg("sess_002", "INBOUND", "Recebi, obrigado. Vou analisar com meu socio e te retorno essa semana.", ago(14, 20)),
      msg("sess_002", "OUTBOUND", "Perfeito, fico no aguardo!", ago(14, 19), "Bruno Tavares"),
      msg("sess_002", "OUTBOUND", "Rogerio, tudo bem? Passando para saber se conseguiu analisar a proposta.", ago(12), "Bruno Tavares"),
    ],
  },

  /* ---------------------------------------------------------------------
     3. MEDIA — pedido de desconto com objecao de preco e concorrente.
     --------------------------------------------------------------------- */
  {
    id: "sess_003",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_002",
    channel: "WHATSAPP",
    agentId: "user_ana",
    agentName: "Ana Ribeiro",
    status: "OPEN",
    startedAt: ago(9),
    lastMessageAt: ago(4),
    messages: [
      msg("sess_003", "INBOUND", "Oi, quanto custa o sistema de embalagem a vacuo modelo industrial? Preciso de uma cotacao.", ago(9)),
      msg("sess_003", "OUTBOUND", "Oi Patricia! O modelo industrial sai por R$ 38.900,00. Posso te enviar a ficha tecnica.", ago(9, -3), "Ana Ribeiro"),
      msg("sess_003", "INBOUND", "Achei um pouco caro, esta acima do nosso orcamento. Estou cotando com outro fornecedor tambem e o valor deles ficou melhor. Consegue melhorar o preco?", ago(8)),
      msg("sess_003", "OUTBOUND", "Entendo. Vou verificar o que consigo com a diretoria e te retorno.", ago(8, -1), "Ana Ribeiro"),
      msg("sess_003", "INBOUND", "Fico no aguardo. Se conseguir parcelar em 6 vezes tambem ajuda bastante na decisao.", ago(4)),
    ],
  },

  /* ---------------------------------------------------------------------
     4. RECOMPRA — cliente recorrente reabrindo conversa.
     --------------------------------------------------------------------- */
  {
    id: "sess_004",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_006",
    channel: "WHATSAPP",
    agentId: "user_diego",
    agentName: "Diego Farias",
    status: "OPEN",
    startedAt: ago(2),
    lastMessageAt: ago(1, 6),
    messages: [
      msg("sess_004", "INBOUND", "Diego, bom dia! Precisamos repor o estoque de defensivo, mesma coisa que pedi no ultimo pedido. Consegue ver disponibilidade?", ago(2)),
      msg("sess_004", "OUTBOUND", "Bom dia, Sandra! Vou verificar agora mesmo.", ago(2, -1), "Diego Farias"),
      msg("sess_004", "INBOUND", "Obrigada. Se possivel ja me passa o valor atualizado, porque queremos fechar essa semana para aproveitar a janela de aplicacao.", ago(1, 6)),
    ],
  },

  /* ---------------------------------------------------------------------
     5. DESQUALIFICADA — suporte tecnico puro, sem oportunidade comercial.
     --------------------------------------------------------------------- */
  {
    id: "sess_005",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_005",
    channel: "WHATSAPP",
    agentId: "user_bruno",
    agentName: "Bruno Tavares",
    status: "OPEN",
    startedAt: ago(1),
    lastMessageAt: ago(0, 20),
    messages: [
      msg("sess_005", "INBOUND", "Boa tarde, o equipamento parou de funcionar depois da ultima atualizacao. Aparece um erro na tela e nao consigo acessar o painel.", ago(1)),
      msg("sess_005", "OUTBOUND", "Boa tarde, Fernando. Vou abrir um chamado no suporte tecnico para voce.", ago(1, -1), "Bruno Tavares"),
      msg("sess_005", "INBOUND", "Obrigado. Preciso resolver isso porque a producao esta parada.", ago(0, 20)),
    ],
  },

  /* ---------------------------------------------------------------------
     6. FALSO POSITIVO PROPOSITAL — palavra isolada, sem contexto.
        Deve ficar ABAIXO do corte de 30 pontos.
     --------------------------------------------------------------------- */
  {
    id: "sess_006",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_007",
    channel: "INSTAGRAM",
    status: "OPEN",
    startedAt: ago(3),
    lastMessageAt: ago(3),
    messages: [msg("sess_006", "INBOUND", "quanto custa?", ago(3))],
  },

  /* ---------------------------------------------------------------------
     7. DESQUALIFICADA — compra ja concluida.
     --------------------------------------------------------------------- */
  {
    id: "sess_007",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_004",
    channel: "WHATSAPP",
    agentId: "user_ana",
    agentName: "Ana Ribeiro",
    status: "CLOSED",
    startedAt: ago(5),
    lastMessageAt: ago(2),
    messages: [
      msg("sess_007", "INBOUND", "Oi! Queria saber o valor do pacote de manutencao anual dos equipamentos.", ago(5)),
      msg("sess_007", "OUTBOUND", "Oi Juliana! O pacote anual sai por R$ 14.200,00.", ago(5, -2), "Ana Ribeiro"),
      msg("sess_007", "INBOUND", "Perfeito, ja fechei com voces pelo portal. Pedido confirmado, obrigada!", ago(2)),
    ],
  },

  /* ---------------------------------------------------------------------
     8. OPORTUNIDADE ESQUECIDA — intencao clara, equipe nunca respondeu.
     --------------------------------------------------------------------- */
  {
    id: "sess_008",
    accountId: MOCK_ACCOUNT_ID,
    contactId: "cont_008",
    channel: "WEBCHAT",
    status: "OPEN",
    startedAt: ago(9),
    lastMessageAt: ago(9),
    messages: [
      msg("sess_008", "INBOUND", "Boa tarde. Sou responsavel pelas compras do Hotel Mar Azul e estamos trocando de fornecedor porque o atual vem atrasando as entregas. Preciso de um orcamento para enxoval completo de 80 apartamentos. Gostaria de falar com um vendedor, e urgente porque a reforma termina no mes que vem.", ago(9)),
    ],
  },
];

/* ==========================================================================
   Paineis e cards do CRM
   ========================================================================== */

export const MOCK_PANELS: Panel[] = [
  {
    id: "panel_vendas",
    accountId: MOCK_ACCOUNT_ID,
    name: "Funil de Vendas",
    type: "SALES",
    steps: [
      { id: "step_triagem", name: "Triagem IA", order: 0, isTriage: true },
      { id: "step_qualificacao", name: "Qualificacao", order: 1 },
      { id: "step_proposta", name: "Proposta enviada", order: 2 },
      { id: "step_negociacao", name: "Negociacao", order: 3 },
      { id: "step_fechamento", name: "Fechamento", order: 4 },
    ],
  },
  {
    id: "panel_pos_venda",
    accountId: MOCK_ACCOUNT_ID,
    name: "Pos-venda e Implantacao",
    type: "MANAGEMENT",
    steps: [
      { id: "step_onboarding", name: "Onboarding", order: 0 },
      { id: "step_acompanhamento", name: "Acompanhamento", order: 1 },
      { id: "step_concluido", name: "Concluido", order: 2 },
    ],
  },
];

export const MOCK_CARDS: CrmCard[] = [
  {
    id: "card_001",
    accountId: MOCK_ACCOUNT_ID,
    panelId: "panel_vendas",
    // Card parado em "Qualificacao" embora a proposta ja tenha sido enviada:
    // exercita a deteccao de etapa provavelmente errada.
    stepId: "step_qualificacao",
    title: "Metalurgica Pinto & Filhos - Chapa galvanizada",
    contactIds: ["cont_003"],
    contactId: "cont_003",
    sessionId: "sess_002",
    responsibleId: "user_bruno",
    amount: 96400,
    description: "Cotacao de 12t de chapa galvanizada 1,2mm.",
    status: "OPEN",
    createdAt: ago(21),
    updatedAt: ago(15),
  },
  {
    id: "card_002",
    accountId: MOCK_ACCOUNT_ID,
    panelId: "panel_vendas",
    stepId: "step_negociacao",
    title: "Nutrivida Alimentos - Sistema de embalagem",
    contactIds: ["cont_002"],
    contactId: "cont_002",
    sessionId: "sess_003",
    responsibleId: "user_ana",
    amount: 38900,
    description: "Negociacao de desconto e parcelamento.",
    dueDate: ago(-3),
    status: "OPEN",
    createdAt: ago(8),
    updatedAt: ago(4),
  },
  {
    id: "card_003",
    accountId: MOCK_ACCOUNT_ID,
    panelId: "panel_vendas",
    stepId: "step_fechamento",
    title: "Clinica Vitacare - Manutencao anual",
    contactIds: ["cont_004"],
    contactId: "cont_004",
    sessionId: "sess_007",
    responsibleId: "user_ana",
    amount: 14200,
    status: "WON",
    createdAt: ago(5),
    updatedAt: ago(2),
  },
];

export const MOCK_LOSS_REASONS: LossReason[] = [
  { id: "loss_preco", name: "Preco acima do orcamento" },
  { id: "loss_concorrente", name: "Fechou com concorrente" },
  { id: "loss_prazo", name: "Prazo de entrega inviavel" },
  { id: "loss_semresposta", name: "Cliente parou de responder" },
  { id: "loss_semperfil", name: "Fora do perfil" },
];

/* ==========================================================================
   Consultas auxiliares
   ========================================================================== */

export function findContact(contactId: string): ContactSnapshot | undefined {
  return MOCK_CONTACTS.find((c) => c.id === contactId);
}

export function findConversation(sessionId: string): ConversationSnapshot | undefined {
  return MOCK_CONVERSATIONS.find((c) => c.id === sessionId);
}

export function findCardBySession(sessionId: string): CrmCard | undefined {
  return MOCK_CARDS.find((c) => c.sessionId === sessionId);
}

export function findCardByContact(contactId: string): CrmCard | undefined {
  return MOCK_CARDS.find((c) => c.contactId === contactId);
}

export function findUser(userId: string): AppUser | undefined {
  return MOCK_USERS.find((u) => u.id === userId);
}

export function findPanel(panelId: string): Panel | undefined {
  return MOCK_PANELS.find((p) => p.id === panelId);
}

export function stepName(panelId: string, stepId: string): string | undefined {
  return findPanel(panelId)?.steps.find((s) => s.id === stepId)?.name;
}

/** Quantas conversas anteriores o contato teve, fora a atual. */
export function previousConversationCount(contactId: string, exceptSessionId: string): number {
  return MOCK_CONVERSATIONS.filter(
    (c) => c.contactId === contactId && c.id !== exceptSessionId,
  ).length;
}
