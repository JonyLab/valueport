// AI subsystem composition entry point.
// Submodules own distinct responsibilities:
//   src/ai/provider.js         — provider config, transport, custom models CRUD, daily quota, runChat
//   src/ai/shared.js           — prompt grounding blocks, validation helpers, fenced JSON parsing
//   src/ai/valuation.js        — /api/my/ai/valuation
//   src/ai/method.js           — /api/my/ai/method (+ Jev)
//   src/ai/thesis.js           — /api/my/ai/note, /api/my/ai/thesis-guide (+ Jev)
//   src/ai/review-brief.js     — /api/my/ai/review, /api/my/ai/brief
//   src/ai/portfolio-query.js  — /api/my/ai/portfolio-query
//   src/ai-assist.js           — /api/my/ai/assist
import { registerAssist } from "./ai-assist.js";
import { chatComplete, createChatRunner, registerAiModelRoutes } from "./ai/provider.js";
import { registerValuationAi } from "./ai/valuation.js";
import { registerMethodAi } from "./ai/method.js";
import { registerThesisAi } from "./ai/thesis.js";
import { registerReviewBriefAi } from "./ai/review-brief.js";
import { registerPortfolioQuery } from "./ai/portfolio-query.js";

export { plain, salvageJson } from "./ai/shared.js";
export { aiConfig, chatComplete, WORKERS_MODELS, SITE_KEY_MODELS, siteKeyModels, validateModel, userAi, DAILY_LIMIT, isWorkersQuotaError } from "./ai/provider.js";
export { validateChat, buildSystemPrompt, parseWidgets, parseScenarios, parseSuggestion } from "./ai/valuation.js";
export { BUSINESS_TYPES, validateMethodReq, buildMethodPrompt, parsePicks } from "./ai/method.js";
export { validateNoteReq, buildNotePrompt, parseThesis, parseNote, validateThesisGuide, guideReferences, clearNoConflict, buildDriverGuidePrompt, buildThesisGuidePrompt, parseThesisGuide } from "./ai/thesis.js";
export { validateReviewReq, buildReviewPrompt, parseReview, validateBriefReq, buildBriefPrompt, parseBrief } from "./ai/review-brief.js";
export { validatePfReq, buildPfPrompt, parsePfQuery } from "./ai/portfolio-query.js";

export function registerAi(app, { chat = chatComplete } = {}) {
  const runChat = createChatRunner(chat);
  registerAiModelRoutes(app, chat);
  registerValuationAi(app, runChat);
  registerMethodAi(app, runChat);
  registerThesisAi(app, runChat);
  registerReviewBriefAi(app, runChat);
  registerPortfolioQuery(app, runChat);
  registerAssist(app, runChat);
}
