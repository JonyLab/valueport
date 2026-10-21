# Jev integration

The current integration covers business classification, valuation method selection, guide passage/citation checks, and business-driver question selection. These are advisory steps; users choose the method and confirm inputs. The existing valuation formulas and two-scenario calculation remain authoritative.

## Data flow

`POST /api/my/ai/method` reads the requesting user's encrypted Typesafe key. If configured, it sends company evidence and explicitly labelled user assumptions to `POST https://api.typesafe.ai/v1/systemone`. The version is pinned to `jev-1.14.0` in `src/jev.js`.

A single call asks a business-type Choice and a business-fit Choice for each supported method. If user stories exist, it also asks a story-fit Choice for each method. Criteria and method rubrics come from code. Unknown methods, malformed distributions and invalid answers cannot enter the shortlist.

Classification needs a top probability of at least 0.70 to apply existing business-type constraints. Method answers below confidence 0.45 or with an uncertain choice need user review. Methods with confidently unsuitable business economics are excluded from the shortlist; they remain available in the editor. Remaining candidates are ranked by business fit (70%) and story fit (30%), or business fit alone when no story exists. These are initial routing rules, not thresholds validated against an investment dataset.

The language model explains the resulting shortlist. Its output cannot change Jev's ordering or candidates. If explanation generation fails or changes the shortlist, bounded template explanations are used. If Jev is unconfigured, the original method API behavior is preserved. If Jev fails, regular AI recommendation is used with an explicit fallback label. Provider error bodies and credentials are never returned.

## Missing data

`public/shared/valuation/method-readiness.js` checks actual financial inputs separately from suitability. Model defaults do not count as reported data or confirmed assumptions. Missing data never changes the ranking. The UI lists missing inputs and offers an entry to add them. Missing scalar facts require manual completion; AI suggestions cannot silently fill those gaps. Resource asset packages or missing shares route to the full editor, where asset inputs or an appropriate per-share mode can be selected. Quote-level shares still come from the company's base data.

The UI persists bounded readiness and review metadata alongside guide drafts. No scores are presented as investment accuracy or as the probability that a future scenario will occur.

## Guide evidence checks

After a valid LLM guide response, `src/jev-guide.js` classifies each bounded passage as factual, assumption, mixed, or an open question. For passages with citations, a second Choice checks overall support from only the cited excerpts: supported, partial, unsupported, contradicted, or uncertain. This checks all factual assertions and attributions in the passage, not just the existence of its source numbers. User answers are explicitly labelled assumptions. Model-generated free text is never used for check results.

Missing numbered sources are detected in code even without a configured key. Missing references override semantic judgments. No citation is not evidence of falsity; it is labelled unverified. An initial confidence threshold of 0.45 routes uncertain responses to review; this is not a validated factual-accuracy score. Jev failure preserves the LLM guide and shows an unavailable notice, without marking it verified. There is one bounded, non-retried Jev call per newly generated guide response.

The UI shows passage-level labels and the overall passage check inside each citation popover. Checks are tied to exact passage text and an exact numbered source snapshot; returning to a previous question restores its own references and checks. Editing a passage invalidates its old check. The check evaluates supplied excerpts only; it does not independently verify original sources or forecast outcomes. It does not change user answers, block continuation, or alter valuation formulas.

## Answer coverage and follow-up routing

For guide questions after the first round, two additional Choices share the existing single Jev call. `answer_coverage` chooses unanswered, partial, uncertain, or a specific prior answer that fully covers the new question. It must respect scenario, driver, timeframe and evidence requirements; prior question text and unselected options are not answers. Code excludes bare uncertainty answers and opposite downside/upside reuse candidates. `followup_need` distinguishes missing factual evidence, missing subjective judgment, explicitly accepted risk, no gap, and uncertainty. Acceptance never proves feasibility or supplies missing data.

Only a Choice with confidence >= 0.45 and selected-option probability >= 0.70 affects the UI. These are initial heuristics, not calibrated accuracy. A covered question shows the exact prior answer and a reuse button. Reuse copies that text into an editable note; the user still confirms with Next. It does not select a generated option, auto-submit, silently skip a round, or change the five-round limit. Existing edits disable reuse to prevent overwrites. Partial coverage and missing evidence receive short prompts; accepted risk is acknowledged rather than repeatedly treated as an omission. The LLM prompt asks for only the missing information while keeping cases and evidence distinct.

Routing is bound to the exact question, context, options, prior answers, scenario and outer source snapshot. Changes to the question or prior answers invalidate it. Malformed routing results fall back independently without discarding valid citation checks. No configured key, low confidence or failure offers no answer reuse and preserves normal answering. There are no extra Jev requests, regeneration loops, or changed valuation formulas.

## Key management

Settings supports save, replace, remove and connection test. Keys are encrypted with the existing AES-GCM helper and user-specific authenticated context. The test sends a fixed fictional banking example, not the user's stock or stories. Jev calls have a 15-second timeout, reject redirects, and bound response bodies to 256 KiB. They do not retry automatically.

## Future roles

The user's proposed architecture also includes driver selection, narrative consistency checks and subsequent news routing. Those require separate closed label sets, evaluation cases and UI decisions. They are not enabled by this change.

Jev option probabilities are model outputs conditional on the supplied state and question. They must not be treated as calibrated real-world investment scenario frequencies. Three-scenario expected values need independently designed scenario definitions, weights, user confirmation and validation before changing the valuation engine.

Official references: `https://docs.typesafe.ai/api/system-one.md`, `https://docs.typesafe.ai/primitives/choice.md`, `https://docs.typesafe.ai/confidence.md`, `https://docs.typesafe.ai/models.md`.


## Driver-based narrative guide

New guides send `guideMode: "drivers"` to `/api/my/ai/thesis-guide`. The first request asks Jev to assess the 22 code-owned business drivers against supplied business and verified evidence. Routing runs inside `runChat`'s preparation callback, after authentication/model/quota checks. Each Choice has `core / secondary / negligible / insufficient` labels; specialized mechanisms require business evidence. Confidence >= .45 and core probability >= .70 are initial routing thresholds, not investment calibration. Code picks up to four drivers, removes generic margin when a specific pricing/cost/spread driver is selected, and removes generic commodity price when gold/copper already captures it. If fewer than three qualify, generic demand/profitability/reinvestment drivers fill to three and status remains `uncertain`. Missing keys, malformed answers or network errors use an explicit generic fallback. No valuation formulas or real-world scenario probabilities come from Jev.

The versioned plan is persisted with the unfinished guide and reused across subsequent turns; it cannot contain custom labels/instructions or more than four keys. The LLM writes one single-choice business question per planned variable, keeping factual sources and future assumptions separate. It may not merge a price view with a claimed macro cause, ask terminal-growth/discount-rate numbers here, or invent capacity plans. Plan status is advisory draft metadata, not proof of evidence support. Passage/citation auditing is still a separate call. The legacy fixed-stage answer-reuse routing is deliberately excluded from driver mode because its downside/upside stage indexes do not describe these questions.

Selected answers stay visible and can be clicked to return to that variable. Later answers and scenario/method suggestions are cleared for reconfirmation. After the plan length is reached, the LLM proposes conservative and optimistic variants of the user's main assumptions. Additional conditions must be marked as proposed and unconfirmed; the review screen requires explicit confirmation before applying both narratives. Quantification remains in the later input stage. Existing drafts without `guideMode` keep the legacy five-round flow and retain their answers. This release does not silently restart old drafts.
