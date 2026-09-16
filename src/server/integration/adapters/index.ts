import "server-only";

export { authAdapter, buildSessionPath, type DeepLinkResult } from "./auth.adapter";
export { sessionsAdapter } from "./sessions.adapter";
export { messagesAdapter } from "./messages.adapter";
export {
  contactsAdapter,
  TAG_OPERATIONS,
  OPERACAO_DE_ETIQUETAS,
} from "./contacts.adapter";
export { tagsAdapter } from "./tags.adapter";
export { panelsAdapter } from "./panels.adapter";
export {
  cardsAdapter,
  CardRuleError,
  assertCanChangeStep,
  type CreateCardInput,
  type UpdateCardInput,
} from "./cards.adapter";
export { agentsAdapter } from "./agents.adapter";
export { webhooksAdapter, verifySignature, type WebhookSubscription } from "./webhooks.adapter";
export {
  buildIdempotencyKey,
  shouldUseMock,
  type AdapterResult,
} from "./base";
